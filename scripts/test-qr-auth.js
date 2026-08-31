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
        tags: ['QR', 'TEST'],
        accessType: 'TYPE2'
    }, 'admin');
    assert.strictEqual(approved.ok, true);
    assert.strictEqual(approved.delivered, false);
    assert.strictEqual(state.qrAuthRequests.get(requestId).status, 'APPROVED');
    assert.strictEqual(state.qrAuthRequests.get(requestId).licenseKey, '');
    assert.match(state.qrAuthRequests.get(requestId).licenseRef, /^QR-[0-9A-F]{8}$/);
    const bound = Array.from(state.licenses.entries()).find(([, license]) => license.boundClient === clientId);
    assert.ok(bound, 'QR approval must create and bind a server-side license');
    assert.strictEqual(bound[1].accessType, 'TYPE2');
    assert.strictEqual(state.qrAuthRequests.get(requestId).accessType, 'TYPE2');

    // QR approval is followed by a password setup/login gate. Password text is
    // never sent or stored; the APK proves possession of a derived verifier.
    const passwordWrites = [];
    const passwordSocket = {
        remoteAddress: '127.0.0.1',
        write(value) { passwordWrites.push(String(value)); return true; },
        destroy() {}
    };
    const passwordConnection = {
        socket: passwordSocket,
        type: 'client', connected: true, clientId, serverId: '',
        licenseAuthorized: false, licenseKey: '', licenseExpiresAt: 0,
        passwordVerified: false, accessType: '', deviceAuthVerified: true, lastServerAuthState: '',
        sequenceStats: { tx: 0, rxLast: 0, rxReceived: 0, rxMissing: 0, rxDuplicates: 0, rxOutOfOrder: 0, lastGapAt: 0, lastRxAt: 0, lastTxAt: 0 }
    };
    passwordSocket.__relayConnection = passwordConnection;
    state.clients.set(clientId, passwordConnection);
    const licenseManager = require('../license/licenseManager');
    const passwordService = require('../services/clientPassword');
    assert.strictEqual(licenseManager.AuthorizeClientByQr(passwordConnection, bound[0], requestId), true);
    assert.ok(passwordWrites.some(line => line.startsWith(`QR_AUTH_OK|${requestId}|`) && line.includes('|TYPE2')));
    const setupLine = passwordWrites.find(line => line.startsWith('PASSWORD_CHALLENGE|SETUP|'));
    assert.ok(setupLine, 'First QR approval must issue a password setup challenge');
    const setup = setupLine.trim().split('|');
    const testPassword = '2580';
    const verifier = passwordService.DeriveVerifier(testPassword, setup[3], Number(setup[4]));
    const setupProof = passwordService.Proof(verifier, 'SETUP', clientId, setup[2], setup[5]);
    assert.strictEqual(passwordService.HandleSetup(passwordConnection, ['PASSWORD_SETUP', setup[2], verifier, setupProof]), true);
    assert.strictEqual(passwordConnection.passwordVerified, true);
    assert.ok(passwordWrites.some(line => line.startsWith('PASSWORD_OK|TYPE2')));
    const profile = state.clientPasswordProfiles.get(clientId);
    assert.ok(profile && profile.verifier === verifier);
    assert.strictEqual(Object.values(profile).includes(testPassword), false);

    passwordConnection.passwordVerified = false;
    assert.strictEqual(passwordService.Begin(passwordConnection, 'TYPE2').ok, true);
    const loginLine = passwordWrites.filter(line => line.startsWith('PASSWORD_CHALLENGE|LOGIN|')).pop();
    assert.ok(loginLine, 'Returning QR device must receive a password login challenge');
    const login = loginLine.trim().split('|');
    const loginVerifier = passwordService.DeriveVerifier(testPassword, login[3], Number(login[4]));
    const loginProof = passwordService.Proof(loginVerifier, 'LOGIN', clientId, login[2], login[5]);
    assert.strictEqual(passwordService.HandleVerify(passwordConnection, ['PASSWORD_VERIFY', login[2], loginProof]), true);
    assert.strictEqual(passwordConnection.passwordVerified, true);

    const resetWriteStart = passwordWrites.length;
    const resetPin = '97531';
    const resetResult = passwordService.ResetPassword(clientId, resetPin, 'TEST_ADMIN');
    assert.strictEqual(resetResult.ok, true);
    assert.strictEqual(resetResult.status.registered, true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(resetResult.status, 'verifier'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(resetResult.status, 'salt'), false);
    assert.ok(passwordWrites.slice(resetWriteStart).some(line => line.startsWith('PASSWORD_RESET|ADMIN')));
    const resetLoginLine = passwordWrites.slice(resetWriteStart).find(line => line.startsWith('PASSWORD_CHALLENGE|LOGIN|'));
    assert.ok(resetLoginLine, 'Admin password reset must force a fresh APK login challenge');
    const resetLogin = resetLoginLine.trim().split('|');
    const resetVerifier = passwordService.DeriveVerifier(resetPin, resetLogin[3], Number(resetLogin[4]));
    const resetProof = passwordService.Proof(resetVerifier, 'LOGIN', clientId, resetLogin[2], resetLogin[5]);
    assert.strictEqual(passwordService.HandleVerify(passwordConnection, ['PASSWORD_VERIFY', resetLogin[2], resetProof]), true);
    assert.strictEqual(passwordConnection.passwordVerified, true);
    assert.strictEqual(Object.values(state.clientPasswordProfiles.get(clientId)).includes(resetPin), false);

    // BUILD is persisted before WinSockServer starts. Relay holds the grant,
    // then forwards it only after a later silent WinSockServer connection has
    // completed capability and HMAC authentication.
    const buildServerId = state.clientIdentities.get('ANDROID-QR-TEST').serverId;
    const buildServerWrites = [];
    const buildServerSocket = {
        destroyed: false,
        remoteAddress: '127.0.0.1',
        write(value) { buildServerWrites.push(String(value)); return true; },
        destroy() { this.destroyed = true; }
    };
    const buildServer = {
        socket: buildServerSocket, type: 'server', registered: true,
        serverId: buildServerId, deviceAuthVerified: true,
        buildGateCapable: true, buildUnlocked: false, buildClients: new Set(),
        clients: new Set([clientId]),
        sequenceStats: { tx: 0, rxLast: 0, rxReceived: 0, rxMissing: 0, rxDuplicates: 0, rxOutOfOrder: 0, lastGapAt: 0, lastRxAt: 0, lastTxAt: 0 }
    };
    buildServerSocket.__relayConnection = buildServer;
    passwordConnection.serverId = buildServerId;
    passwordConnection.deviceAuthVerified = true;
    const buildRequestId = 'BUILD-001122334455';
    state.servers.delete(buildServerId);
    require('../relay/clientHandler').HandleClientBuild(passwordConnection, `BUILD|${buildRequestId}|${clientId}`);
    assert.ok(passwordWrites.some(line => line.startsWith(`BUILD_WAITING|${buildRequestId}|`)));
    assert.strictEqual(state.pendingBuildGrants.get(clientId).status, 'PENDING');
    assert.strictEqual(buildServerWrites.some(line => line.includes(buildRequestId)), false);

    state.servers.set(buildServerId, buildServer);
    require('../services/deviceControl').RecordCapabilities('SERVER', buildServerId, 'DEVICE_HMAC,BUILD_GATE');
    require('../services/buildGate').TryDispatchServer(buildServerId);
    assert.ok(buildServerWrites.some(line => line.trim() === `BUILD|${buildRequestId}|${clientId}`));
    assert.strictEqual(state.pendingBuildGrants.get(clientId).status, 'DISPATCHED');
    assert.strictEqual(buildServer.buildUnlocked, false);
    require('../relay/serverHandler').HandleServerLine(buildServer, `ACK|${buildRequestId}|${clientId}|OK|0|BUILD_GATE|TICKET=TEST1234`);
    assert.strictEqual(buildServer.buildUnlocked, true);
    assert.strictEqual(buildServer.buildClients.has(clientId), true);
    assert.ok(passwordWrites.some(line => line.startsWith(`BUILD_OK|${buildRequestId}|TICKET=TEST1234`)));
    assert.strictEqual(state.pendingBuildGrants.has(clientId), false);
    state.servers.delete(buildServerId);

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
    clientHandlerModule.HandleClientConnect(serverlessConnection, 'ANDROID-NO-WINSOCK', 2, '2.6.0');
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

    // Reinstalling the APK removes its local secret while Relay still has the
    // old one. A valid outstanding challenge + NO_SECRET must re-enroll once,
    // not fall through to ERROR|UNKNOWN_COMMAND and strand the QR screen.
    const deviceAuth = require('../services/deviceAuth');
    serverlessConnection.deviceAuthVerified = false;
    const recoveryStart = serverlessWrites.length;
    deviceAuth.IssueChallenge('CLIENT', serverlessConnection.clientId);
    const recoveryChallengeLine = serverlessWrites.slice(recoveryStart).find(line => line.startsWith('AUTH_CHALLENGE|'));
    assert.ok(recoveryChallengeLine);
    const recoveryChallenge = recoveryChallengeLine.trim().split('|');
    clientHandlerModule.HandleClientLine(serverlessConnection, `DEVICE_AUTH_ERROR|${recoveryChallenge[1]}|NO_SECRET`);
    const recoveryWrites = serverlessWrites.slice(recoveryStart);
    const recoveredSecretLine = recoveryWrites.find(line => line.startsWith('DEVICE_SECRET|'));
    assert.ok(recoveredSecretLine, 'Missing local secret must trigger bounded re-enrollment');
    assert.ok(!recoveryWrites.some(line => line.trim() === 'ERROR|UNKNOWN_COMMAND'));
    const recoveredSecret = recoveredSecretLine.trim().split('|')[1];
    assert.notStrictEqual(recoveredSecret, deviceSecret);
    const recoveryAckStart = serverlessWrites.length;
    clientHandlerModule.HandleClientLine(serverlessConnection, 'DEVICE_SECRET_ACK');
    const recoveredChallengeLine = serverlessWrites.slice(recoveryAckStart).find(line => line.startsWith('AUTH_CHALLENGE|'));
    assert.ok(recoveredChallengeLine);
    const recoveredChallenge = recoveredChallengeLine.trim().split('|');
    const recoveredHmac = crypto.createHmac('sha256', recoveredSecret)
        .update(`CLIENT|${serverlessConnection.clientId}|${recoveredChallenge[1]}|${recoveredChallenge[2]}|${recoveredChallenge[3]}`, 'utf8')
        .digest('hex').toUpperCase();
    clientHandlerModule.HandleClientLine(serverlessConnection, `DEVICE_AUTH|${recoveredChallenge[1]}|${recoveredHmac}`);
    assert.strictEqual(serverlessConnection.deviceAuthVerified, true);
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
    const qrRenderer = fs.readFileSync(path.join(productRoot, 'ApkWinSock_Android64', 'ApkQrRenderer.pas'), 'utf8');
    const protocol = fs.readFileSync(path.join(productRoot, 'ApkWinSock_Android64', 'ApkProtocol.pas'), 'utf8');
    const passwordCrypto = fs.readFileSync(path.join(productRoot, 'ApkWinSock_Android64', 'ApkPasswordCrypto.pas'), 'utf8');
    const deepLink = fs.readFileSync(path.join(productRoot, 'ApkWinSock_Android64', 'ApkDeepLink.pas'), 'utf8');
    const serverProtocol = fs.readFileSync(path.join(productRoot, 'WinSockServer_Win64', 'RelayProtocol.pas'), 'utf8');
    const serverRuntime = fs.readFileSync(path.join(productRoot, 'WinSockServer_Win64', 'ServerRuntime.pas'), 'utf8');
    const serverProject = fs.readFileSync(path.join(productRoot, 'WinSockServer_Win64', 'WinSockServer.dpr'), 'utf8');
    const numberProcessor = fs.readFileSync(path.join(productRoot, 'WinSockServer_Win64', 'NumberProcessor.pas'), 'utf8');
    const admin = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
    const adminCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.css'), 'utf8');
    const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const webApi = fs.readFileSync(path.join(__dirname, '..', 'web', 'webApi.js'), 'utf8');
    const clientHandler = fs.readFileSync(path.join(__dirname, '..', 'relay', 'clientHandler.js'), 'utf8');
    assert.ok(apk.includes('FQrImage: TImage'));
    assert.ok(apk.includes('FQrPanel: TLayout'));
    assert.ok(apk.includes('FQrTimeLabel: TLabel'));
    assert.ok(apk.includes('FQrCountdownTimer: TTimer'));
    assert.ok(apk.includes('FQrCountdownTimer.Interval := 250'));
    assert.ok(apk.includes('FPasswordPad: TGridLayout'));
    assert.ok(apk.includes("ALine.StartsWith('PASSWORD_CHALLENGE|')"));
    assert.ok(apk.includes("ALine.StartsWith('PASSWORD_OK|')"));
    assert.ok(apk.includes("ALine.StartsWith('PASSWORD_RESET|')"));
    assert.ok(apk.includes('FSendButton: TButton'));
    assert.ok(apk.includes('FFinalCheckBox: TCheckBox'));
    assert.ok(apk.includes("FSendButton.Text := BUILD_BUTTON_TEXT"));
    assert.ok(apk.includes("FFinalCheckBox.Text := 'Ready'"));
    assert.ok(!apk.includes('FUserStatusText'));
    assert.ok(!apk.includes('COLOR_DASH_BG'));
    assert.ok(apk.includes("ReportUiState('AUTHORIZED', FState.AccessType)"));
    assert.ok(apk.includes('procedure TForm1.ResizeQrLayout'));
    assert.ok(apk.includes('Fill.Color := COLOR_QR_BG'));
    assert.ok(apk.includes('FQrBackground: TRectangle'));
    assert.ok(apk.includes('FQrBackground.Fill.Color := COLOR_QR_BG'));
    assert.ok(apk.includes('FQrPanel.SetBounds(0, 0, RootWidth, RootHeight)'));
    assert.ok(apk.includes('FQrImage.SetBounds(LeftPos, TopPos, QrSize, QrSize)'));
    assert.ok(apk.includes('TopPos + QrSize + QR_TIME_GAP'));
    assert.ok(qrRenderer.includes('Image.Bitmap.BitmapScale := 1'));
    assert.ok(qrRenderer.includes('QUIET_ZONE_MODULES = 8'));
    assert.ok(apk.includes("ALine.StartsWith('SERVER_ASSIGNED|')"));
    assert.ok(apk.includes("Format('QR 남은 시간"));
    assert.ok(apk.includes('BuildBuildLine(RequestID, FState.ClientID)'));
    assert.ok(apk.includes("ALine.StartsWith('BUILD_OK|')"));
    assert.ok(apk.includes("ALine.StartsWith('BUILD_WAITING|')"));
    assert.ok(apk.includes("ALine.StartsWith('BUILD_EXPIRED|')"));
    assert.ok(apk.includes('FBuildCompleted := True'));
    assert.ok(apk.includes("ALine.StartsWith('QR_AUTH_CHALLENGE|')"));
    assert.ok(!apk.includes('FLicenseEdit'));
    assert.ok(!`${apk}\n${deepLink}`.includes('relaylicense://'));
    assert.ok(protocol.includes('QR_DEVICE_APPROVAL'));
    assert.ok(protocol.includes('PASSWORD_KEYPAD'));
    assert.ok(protocol.includes('TYPE_ROUTING'));
    assert.ok(protocol.includes('BUILD_GATE'));
    assert.ok(serverProtocol.includes('BUILD_GATE'));
    assert.ok(serverRuntime.includes('function TWinSockRelayServer.HandleBuild'));
    assert.ok(serverRuntime.includes('if not FBuildUnlocked or not FBuildAuthorizedClients.IsAuthorized(ClientID) then'));
    assert.ok(serverRuntime.includes("BuildCommandAck(CommandID, 'ERROR', 'BUILD_REQUIRED')"));
    assert.ok(serverRuntime.includes("Line.StartsWith('BUILD_GATE_EXIT|')"));
    assert.ok(serverRuntime.includes('while FConnection.IsConnected and not FTerminateRequested do'));
    assert.ok(serverRuntime.includes('MaxAttempts := 1'));
    assert.ok(serverProject.includes('{$APPTYPE GUI}'));
    assert.ok(!serverProject.includes('{$APPTYPE CONSOLE}'));
    assert.ok(!/\b(?:Writeln|Readln)\b/.test(`${serverProject}\n${serverRuntime}`));
    assert.ok(!fs.existsSync(path.join(productRoot, 'WinSockServer_Win64', 'ConsoleLog.pas')));
    assert.ok(numberProcessor.includes('GProcessor := nil'));
    assert.ok(passwordCrypto.includes('DerivePasswordVerifier'));
    assert.ok(passwordCrypto.includes('BuildPasswordProof'));
    assert.ok(serverProtocol.includes('AuthSource'));
    assert.ok(admin.includes('async function renderQrAuth()'));
    assert.ok(admin.includes('let qrSelectedFile = null'));
    assert.ok(admin.includes('qrSelectedPreviewDataUrl'));
    assert.ok(admin.includes("await setQrSelectedFile(file)"));
    assert.ok(!admin.includes('URL.createObjectURL'));
    assert.ok(admin.includes("name: 'accessType'"));
    assert.ok(admin.includes('const file = qrSelectedFile'));
    assert.ok(admin.includes('qrEditInProgress'));
    assert.ok(admin.includes('function captureScrollState(view)'));
    assert.ok(admin.includes('restoreScrollState(scrollState)'));
    assert.ok(admin.includes('consoleHistoryLoaded = true'));
    assert.ok(admin.includes('data-client-action="password"'));
    assert.ok(admin.includes("type: 'password'"));
    assert.ok(admin.includes('async function renderClientPasswords()'));
    assert.ok(admin.includes('PIN 재설정 / 보기'));
    assert.ok(adminCss.includes('#nav {') && adminCss.includes('overflow-y: scroll'));
    assert.ok(index.includes('data-view="qrauth"'));
    assert.ok(index.includes('data-view="clientpasswords"'));
    assert.ok(index.includes('WEB v3.4.0'));
    assert.ok(index.includes('class="nav-group"'));
    assert.ok(webApi.includes("pathname === '/api/qr-auth/scan'"));
    assert.ok(webApi.includes('/password\\/reset'));
    assert.ok(clientHandler.includes('FindAssignableServerId'));
    assert.ok(!clientHandler.includes('!GetOnlineServer(saved.serverId)'));
    assert.ok(!`${admin}\n${webApi}`.includes('relaylicense://auth?key='));

    console.log('QR AUTH END-TO-END PASS');
    console.log('- Signed one-time QR image decode: PASS');
    console.log('- Admin approval and server-side license binding: PASS');
    console.log('- Password setup/login proof and no plaintext storage: PASS');
    console.log('- Web Admin PIN reset, one-time reveal and forced APK re-login: PASS');
    console.log('- Type1/Type2/Type3 approval routing: PASS');
    console.log('- Replay and signature tamper rejection: PASS');
    console.log('- Oversized image dimension rejection: PASS');
    console.log('- APK QR/PIN/Build/final-checkbox flow: PASS');
    console.log('- Authenticated WinSockServer Build gate and dynamic server ACK: PASS');
    console.log('- Build-first persistent wait and silent delayed WinSockServer launch: PASS');
    console.log('- APK responsive QR frame and expiry countdown: PASS');
    console.log('- Relay QR issuance with WinSockServer offline: PASS');
    console.log('- APK reinstall secret recovery without UNKNOWN_COMMAND: PASS');
    console.log('- Late WinSockServer first-binding handoff: PASS');
    console.log('- Web selected-photo persistence across live refresh: PASS');
    console.log('- Sidebar grouped navigation scrolling: PASS');
    console.log('- WinSockServer QR authorization source: PASS');
    console.log('- Grouped Web Admin navigation: PASS');
    console.log('- Live list scroll preservation and complete console clear: PASS');
    console.log('- APK minimal centered Build UI without status dashboard: PASS');
}

run().finally(() => {
    fs.rmSync(temporaryData, { recursive: true, force: true });
}).catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
