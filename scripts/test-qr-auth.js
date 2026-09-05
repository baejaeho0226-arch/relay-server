'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-biometric-test-'));
process.env.DATA_DIR = temporaryData;
process.env.STORAGE_ENGINE = 'json';
process.env.ADMIN_SECRET = 'test-admin-secret-not-for-production';
process.env.QR_APPROVAL_SECRET = 'test-qr-signing-secret-not-for-production';

function SequenceStats() {
    return { tx: 0, rxLast: 0, rxReceived: 0, rxMissing: 0,
        rxDuplicates: 0, rxOutOfOrder: 0, lastGapAt: 0, lastRxAt: 0,
        lastTxAt: 0 };
}

async function run() {
    const state = require('../core/state');
    const qr = require('../services/qrApproval');
    const biometric = require('../services/clientBiometric');
    const QRCode = require('qrcode');
    require('../core/utils').EnsureDirs();

    const clientId = 'A1B2C3D4E5F60708';
    const requestId = 'QRA-00112233445566778899AABB';
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 60000;
    const payload = qr.BuildPayload(requestId, clientId, expiresAt, token);
    state.clientIdentities.set('ANDROID-BIO-TEST', {
        id: clientId, serverId: '', createdAt: Date.now(), lastSeenAt: 0,
        lastAuthAt: 0, lastIP: '', authCount: 0, sendCount: 0,
        reconnectCount: 0
    });
    state.qrAuthRequests.set(requestId, {
        requestId, clientId, deviceKey: 'ANDROID-BIO-TEST',
        tokenHash: crypto.createHash('sha256').update(token, 'utf8').digest('hex'),
        issuedAt: Date.now(), expiresAt, status: 'PENDING', approvedAt: 0,
        approvedBy: '', rejectedAt: 0, rejectedBy: '', reason: '',
        licenseKey: '', lastIP: '127.0.0.1', scanCount: 0
    });

    const dataUrl = await QRCode.toDataURL(payload,
        { errorCorrectionLevel: 'M', width: 720, margin: 4 });
    const scan = qr.ScanImage(dataUrl);
    assert.strictEqual(scan.request.requestId, requestId);
    assert.strictEqual(scan.request.clientId, clientId);
    const approved = qr.Approve(requestId, scan.approvalToken,
        { days: 30, accessType: 'TYPE2' }, 'admin');
    assert.strictEqual(approved.ok, true);
    assert.strictEqual(approved.pairing.deferred, true);
    const bound = Array.from(state.licenses.entries())
        .find(([, license]) => license.boundClient === clientId);
    assert.ok(bound);
    assert.strictEqual(bound[1].accessType, 'TYPE2');

    const writes = [];
    const socket = {
        destroyed: false, remoteAddress: '127.0.0.1',
        write(value) { writes.push(String(value)); return true; },
        destroy() { this.destroyed = true; }
    };
    const connection = {
        socket, type: 'client', connected: true, clientId, serverId: '',
        licenseAuthorized: false, licenseKey: '', licenseExpiresAt: 0,
        biometricVerified: false, accessType: '', deviceAuthVerified: true,
        lastServerAuthState: '', sequenceStats: SequenceStats()
    };
    socket.__relayConnection = connection;
    state.clients.set(clientId, connection);
    const secret = 'test-client-device-secret-at-least-32-bytes';
    state.deviceSecrets.set(`CLIENT:${clientId}`, secret);
    require('../services/deviceControl').RecordCapabilities('CLIENT', clientId,
        'DEVICE_HMAC,QR_DEVICE_APPROVAL,BIOMETRIC_AUTH,BIOMETRIC_STRONG,BUILD_SESSION_LEASE');

    assert.strictEqual(require('../license/licenseManager')
        .AuthorizeClientByQr(connection, bound[0], requestId), true);
    assert.ok(writes.some(line => line.startsWith(`QR_AUTH_OK|${requestId}|`)));
    const enrollmentLine = writes.find(line =>
        line.startsWith('BIOMETRIC_CHALLENGE|ENROLL|'));
    assert.ok(enrollmentLine);
    const enrollment = enrollmentLine.trim().split('|');
    const enrollmentProof = biometric.Proof(secret, enrollment[1], clientId,
        enrollment[2], enrollment[3]);
    assert.strictEqual(biometric.HandleProof(connection,
        ['BIOMETRIC_PROOF', enrollment[1], enrollment[2], enrollmentProof]), true);
    assert.strictEqual(connection.biometricVerified, true);
    assert.ok(writes.some(line => /^BIOMETRIC_OK\|TYPE2\|\{[0-9A-F-]{36}\}/.test(line)));
    assert.ok(state.clientBiometricProfiles.get(clientId));
    assert.strictEqual(Object.keys(state.clientBiometricProfiles.get(clientId))
        .some(key => /finger|template|password|pin/i.test(key)), false);

    connection.biometricVerified = false;
    assert.strictEqual(biometric.Begin(connection, 'TYPE2').ok, true);
    const verifyLine = writes.filter(line =>
        line.startsWith('BIOMETRIC_CHALLENGE|VERIFY|')).pop();
    assert.ok(verifyLine);
    const verify = verifyLine.trim().split('|');
    const verifyProof = biometric.Proof(secret, verify[1], clientId,
        verify[2], verify[3]);
    assert.strictEqual(biometric.HandleProof(connection,
        ['BIOMETRIC_PROOF', verify[1], verify[2], verifyProof]), true);
    assert.strictEqual(connection.biometricVerified, true);

    const resetAt = writes.length;
    assert.strictEqual(biometric.Reset(clientId, 'TEST_ADMIN').ok, true);
    assert.ok(writes.slice(resetAt).some(line =>
        line.startsWith('BIOMETRIC_RESET|ADMIN')));
    assert.ok(writes.slice(resetAt).some(line =>
        line.startsWith('BIOMETRIC_CHALLENGE|ENROLL|')));
    assert.strictEqual(state.clientBiometricProfiles.has(clientId), false);

    assert.throws(() => qr.InspectPayload(payload), /QR_REQUEST_APPROVED/);
    assert.throws(() => qr.ParsePayload(payload.replace(`c=${clientId}`,
        'c=FFFFFFFFFFFFFFFF')), /QR_SIGNATURE_INVALID/);

    const root = path.resolve(__dirname, '..', '..');
    const apkDir = path.join(root, 'ApkWinSock_Android64');
    const apk = fs.readdirSync(apkDir)
        .filter(name => name === 'ApkWinSock.pas' ||
            /^ApkWinSock\..+\.inc$/i.test(name))
        .sort().map(name => fs.readFileSync(path.join(apkDir, name), 'utf8'))
        .join('\n');
    const apkProtocol = fs.readFileSync(path.join(apkDir, 'ApkProtocol.pas'), 'utf8');
    const apkNotifications = fs.readFileSync(
        path.join(apkDir, 'ApkAndroidNotifications.pas'), 'utf8');
    const project = fs.readFileSync(path.join(apkDir, 'ApkWinSockProject.dpr'), 'utf8');
    const serverDir = path.join(root, 'WinSockServer_Win64');
    const serverProject = fs.readFileSync(path.join(serverDir, 'WinSockServer.dpr'), 'utf8');
    const serverGuard = fs.readFileSync(path.join(serverDir, 'ServerInstanceGuard.pas'), 'utf8');
    const admin = fs.readdirSync(path.join(__dirname, '..', 'public'))
        .filter(name => /^admin(?:-[a-z-]+)?\.js$/i.test(name))
        .sort().map(name => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8'))
        .join('\n');
    const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

    assert.ok(apk.includes('FMX.BiometricAuth'));
    assert.ok(apk.includes('TBiometricStrength.Weak'));
    assert.ok(!apk.includes('TBiometricStrength.DeviceCredential'));
    assert.ok(apk.includes('FBiometricLaunchTimer.Interval := 350'));
    assert.ok(apk.includes('procedure TForm1.QueueBiometricAuthentication'));
    assert.ok(apk.includes('FBiometricFingerprint: TPath'));
    assert.ok(!apk.includes('FBiometricIcon: TLabel'));
    assert.ok(apk.includes('FBiometricProgressTimer.Interval := 400'));
    assert.ok(apk.includes('SetBiometricProgress(100)'));
    assert.ok(apk.includes('procedure TForm1.CancelBiometricPrompt'));
    assert.ok(apk.includes('FBiometricTimeoutTimer.Interval := BIOMETRIC_PROMPT_TIMEOUT_MS'));
    assert.ok(apk.includes("ALine.StartsWith('BIOMETRIC_CHALLENGE|')"));
    assert.ok(apk.includes("ALine.StartsWith('BIOMETRIC_OK|')"));
    assert.ok(apk.includes('FQrCornerH: array[0..3] of TRectangle'));
    assert.ok(!apk.includes('FBrightness'));
    assert.ok(apk.includes('Result.StyledSettings := []'));
    const notificationSetup = fs.readFileSync(
        path.join(apkDir, 'ANDROID_NOTIFICATION_SETUP.txt'), 'utf8');
    assert.ok(notificationSetup.includes('android.permission.POST_NOTIFICATIONS'));
    assert.ok(notificationSetup.includes('ACCESS_NOTIFICATION_POLICY'));
    assert.ok(apkNotifications.includes("CHANNEL_AUTH = 'relay_auth_v2'"));
    assert.ok(apkNotifications.includes("Notify('AUTH', Title, MessageText)"));
    assert.ok(apk.includes("FSupportLabel.Text := '요청 완료'"));
    assert.ok(apk.includes('QR_COUNTDOWN_MAX_MS = 60 * 1000'));
    assert.ok(!apk.includes('FTitleBar'));
    assert.ok(!apk.includes('FPassword'));
    assert.ok(!project.includes('ApkPasswordCrypto'));
    assert.ok(apkProtocol.includes('BIOMETRIC_STRONG'));
    assert.ok(apkProtocol.includes('BIOMETRIC_WEAK'));
    assert.ok(!apkProtocol.includes('SCREEN_BRIGHTNESS'));
    assert.ok(apkProtocol.includes('REALTIME_SUPPORT'));
    assert.ok(serverProject.includes('ServerInstanceGuard'));
    assert.ok(serverGuard.includes('fmShareExclusive'));
    assert.ok(admin.includes('async function renderClientBiometrics()'));
    assert.ok(index.includes('data-view="clientbiometrics"'));

    console.log('QR + BIOMETRIC END-TO-END PASS');
    console.log('- Signed one-minute QR approval: PASS');
    console.log('- Class 2/3 biometric challenge and device HMAC proof: PASS');
    console.log('- No biometric template storage: PASS');
    console.log('- Duplicate WinSockServer local guard source: PASS');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    try { fs.rmSync(temporaryData, { recursive: true, force: true }); } catch (_) {}
});
