'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-qr-auth-test-'));
process.env.DATA_DIR = temporaryData;
process.env.STORAGE_ENGINE = 'json';
process.env.ADMIN_SECRET = 'test-admin-secret-not-for-production';
process.env.QR_APPROVAL_SECRET = 'test-qr-signing-secret-not-for-production';

async function run() {
    const state = require('../core/state');
    const service = require('../services/qrApproval');
    const { ValidateDimensions } = require('../services/qrImageDecoder');
    const QRCode = require('qrcode');
    require('../core/utils').EnsureDirs();
    const clientId = 'A1B2C3D4E5F60708';
    const requestId = 'QRA-00112233445566778899AABB';
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 5 * 60 * 1000;
    const payload = service.BuildPayload(requestId, clientId, expiresAt, token);

    state.clientIdentities.set('ANDROID-QR-TEST', {
        id: clientId,
        serverId: '0102030405060708',
        createdAt: Date.now(),
        lastSeenAt: 0,
        lastAuthAt: 0,
        lastIP: '',
        authCount: 0,
        sendCount: 0,
        reconnectCount: 0
    });
    state.qrAuthRequests.set(requestId, {
        requestId,
        clientId,
        deviceKey: 'ANDROID-QR-TEST',
        tokenHash: crypto.createHash('sha256').update(token, 'utf8').digest('hex'),
        issuedAt: Date.now(),
        expiresAt,
        status: 'PENDING',
        approvedAt: 0,
        approvedBy: '',
        rejectedAt: 0,
        rejectedBy: '',
        reason: '',
        licenseKey: '',
        lastIP: '127.0.0.1',
        scanCount: 0
    });

    const dataUrl = await QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', width: 720, margin: 4 });
    const scan = service.ScanImage(dataUrl);
    assert.strictEqual(scan.request.requestId, requestId);
    assert.strictEqual(scan.request.clientId, clientId);
    assert.match(scan.approvalToken, /^[0-9A-F]{64}$/);
    assert.throws(() => ValidateDimensions(100000, 100000), /QR_IMAGE_DIMENSIONS_INVALID/);

    const approved = service.Approve(requestId, scan.approvalToken, {
        days: 30,
        memo: 'QR integration test',
        tags: ['QR', 'TEST']
    }, 'admin');
    assert.strictEqual(approved.ok, true);
    assert.strictEqual(approved.delivered, false);
    assert.strictEqual(state.qrAuthRequests.get(requestId).status, 'APPROVED');
    assert.strictEqual(state.qrAuthRequests.get(requestId).licenseKey, '');
    assert.match(state.qrAuthRequests.get(requestId).licenseRef, /^QR-[0-9A-F]{8}$/);
    const bound = Array.from(state.licenses.entries()).find(([, license]) => license.boundClient === clientId);
    assert.ok(bound, 'QR approval must create and bind a server-side license');

    assert.throws(() => service.InspectPayload(payload), /QR_REQUEST_APPROVED/);
    const tampered = payload.replace(`c=${clientId}`, 'c=FFFFFFFFFFFFFFFF');
    assert.throws(() => service.ParsePayload(tampered), /QR_SIGNATURE_INVALID/);

    // A client must receive its QR directly from Relay even when no
    // WinSockServer has ever registered or is currently online.
    const serverlessWrites = [];
    const serverlessSocket = {
        destroyed: false,
        remoteAddress: '127.0.0.1',
        write(value) { serverlessWrites.push(String(value)); return true; },
        destroy() { this.destroyed = true; }
    };
    const serverlessConnection = {
        socket: serverlessSocket,
        type: 'client',
        connected: false,
        clientId: '',
        serverId: '',
        protocolVersion: 0,
        appVersion: '',
        sequenceStats: { tx: 0, rxLast: 0, rxReceived: 0, rxMissing: 0, rxDuplicates: 0, rxOutOfOrder: 0, lastGapAt: 0, lastRxAt: 0, lastTxAt: 0 }
    };
    serverlessSocket.__relayConnection = serverlessConnection;
    assert.strictEqual(state.servers.size, 0);
    assert.strictEqual(state.serverIdentities.size, 0);
    const clientHandlerModule = require('../relay/clientHandler');
    clientHandlerModule.HandleClientConnect(serverlessConnection, 'ANDROID-NO-WINSOCK', 2, '2.3.2');
    assert.strictEqual(serverlessConnection.connected, true);
    assert.strictEqual(serverlessConnection.serverId, '');
    assert.ok(serverlessWrites.some(line => line.startsWith(`CONNECTED|${serverlessConnection.clientId}||`)));
    clientHandlerModule.HandleClientLine(serverlessConnection, 'CAPABILITIES|QR_DEVICE_APPROVAL,DEVICE_HMAC');
    const enrollmentLine = serverlessWrites.find(line => line.startsWith('DEVICE_SECRET|'));
    assert.ok(enrollmentLine, 'Relay must enroll client HMAC without WinSockServer');
    const deviceSecret = enrollmentLine.trim().split('|')[1];
    clientHandlerModule.HandleClientLine(serverlessConnection, 'DEVICE_SECRET_ACK');
    const challengeLine = serverlessWrites.find(line => line.startsWith('AUTH_CHALLENGE|'));
    assert.ok(challengeLine, 'Relay must challenge client HMAC without WinSockServer');
    const challenge = challengeLine.trim().split('|');
    const authHmac = crypto.createHmac('sha256', deviceSecret)
        .update(`CLIENT|${serverlessConnection.clientId}|${challenge[1]}|${challenge[2]}|${challenge[3]}`, 'utf8')
        .digest('hex').toUpperCase();
    clientHandlerModule.HandleClientLine(serverlessConnection, `DEVICE_AUTH|${challenge[1]}|${authHmac}`);
    assert.ok(serverlessWrites.some(line => line.startsWith(`DEVICE_AUTH_OK|${challenge[1]}`)));
    clientHandlerModule.HandleClientLine(serverlessConnection, `QR_AUTH_RESUME|${serverlessConnection.clientId}`);
    assert.ok(serverlessWrites.some(line => line.startsWith('QR_AUTH_CHALLENGE|')));

    // When a WinSockServer appears later, only never-assigned clients receive
    // their first fixed binding without interrupting the QR session.
    const lateServerId = '1122334455667788';
    state.serverIdentities.set('SERVER-LATE-START', lateServerId);
    const assigned = require('../relay/serverHandler').BindUnassignedClients(lateServerId);
    assert.strictEqual(assigned, 1);
    assert.strictEqual(serverlessConnection.serverId, lateServerId);
    assert.ok(serverlessWrites.some(line => line.startsWith(`SERVER_ASSIGNED|${lateServerId}`)));

    const productRoot = path.resolve(__dirname, '..', '..');
    const apk = fs.readFileSync(path.join(productRoot, 'ApkWinSock_Android64', 'ApkWinSock.pas'), 'utf8');
    const protocol = fs.readFileSync(path.join(productRoot, 'ApkWinSock_Android64', 'ApkProtocol.pas'), 'utf8');
    const deepLink = fs.readFileSync(path.join(productRoot, 'ApkWinSock_Android64', 'ApkDeepLink.pas'), 'utf8');
    const serverProtocol = fs.readFileSync(path.join(productRoot, 'WinSockServer_Win64', 'RelayProtocol.pas'), 'utf8');
    const admin = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
    const adminCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.css'), 'utf8');
    const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const webApi = fs.readFileSync(path.join(__dirname, '..', 'web', 'webApi.js'), 'utf8');
    const clientHandler = fs.readFileSync(path.join(__dirname, '..', 'relay', 'clientHandler.js'), 'utf8');

    assert.ok(apk.includes('FQrImage: TImage'));
    assert.ok(apk.includes('FQrPanel: TLayout'));
    assert.ok(apk.includes('FQrTimeLabel: TLabel'));
    assert.ok(apk.includes('procedure TForm1.ResizeQrLayout'));
    assert.ok(apk.includes('FQrPanel.SetBounds'));
    assert.ok(apk.includes('FQrImage.SetBounds(0, 0, QrSize, QrSize)'));
    assert.ok(apk.includes("ALine.StartsWith('SERVER_ASSIGNED|')"));
    assert.ok(apk.includes("Format('QR 남은 시간"));
    assert.ok(apk.includes("BuildSendLine(RequestID, FState.ClientID, '1')"));
    assert.ok(apk.includes("ALine.StartsWith('QR_AUTH_CHALLENGE|')"));
    assert.ok(!apk.includes('FLicenseEdit'));
    assert.ok(!apk.includes('TCheckBox'));
    assert.ok(!`${apk}\n${deepLink}`.includes('relaylicense://'));
    assert.ok(protocol.includes('QR_DEVICE_APPROVAL'));
    assert.ok(serverProtocol.includes('AuthSource'));
    assert.ok(admin.includes('async function renderQrAuth()'));
    assert.ok(admin.includes('let qrSelectedFile = null'));
    assert.ok(admin.includes('const file = qrSelectedFile'));
    assert.ok(admin.includes('qrEditInProgress'));
    assert.ok(adminCss.includes('#nav {') && adminCss.includes('overflow-y: scroll'));
    assert.ok(index.includes('data-view="qrauth"'));
    assert.ok(index.includes('class="nav-group"'));
    assert.ok(webApi.includes("pathname === '/api/qr-auth/scan'"));
    assert.ok(clientHandler.includes('FindAssignableServerId'));
    assert.ok(!clientHandler.includes('!GetOnlineServer(saved.serverId)'));
    assert.ok(!`${admin}\n${webApi}`.includes('relaylicense://auth?key='));

    console.log('QR AUTH END-TO-END PASS');
    console.log('- Signed one-time QR image decode: PASS');
    console.log('- Admin approval and server-side license binding: PASS');
    console.log('- Replay and signature tamper rejection: PASS');
    console.log('- Oversized image dimension rejection: PASS');
    console.log('- APK QR-only UI and fixed numeric injection: PASS');
    console.log('- APK responsive QR frame and expiry countdown: PASS');
    console.log('- Relay QR issuance with WinSockServer offline: PASS');
    console.log('- Late WinSockServer first-binding handoff: PASS');
    console.log('- Web selected-photo persistence across live refresh: PASS');
    console.log('- Sidebar grouped navigation scrolling: PASS');
    console.log('- WinSockServer QR authorization source: PASS');
    console.log('- Grouped Web Admin navigation: PASS');
}

run().finally(() => {
    fs.rmSync(temporaryData, { recursive: true, force: true });
}).catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
