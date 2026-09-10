'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const apkDir = path.join(root, 'ApkWinSock_Android64');
const serverDir = path.join(root, 'WinSockServer_Win64');
const webDir = path.join(root, 'WebRelay_Node_v6.7.0_WebAdmin_v3.5.0');

function read(file) { return fs.readFileSync(file, 'utf8'); }
function sourceFiles(dir) {
    return fs.readdirSync(dir)
        .filter(name => /\.(pas|dpr|inc)$/i.test(name))
        .map(name => path.join(dir, name));
}

// Entry points are maintained in the user's existing projects.
for (const dir of [apkDir, serverDir])
    assert.ok(!fs.readdirSync(dir).some(name => /\.dpr$/i.test(name)));

const delphiFiles = [...sourceFiles(apkDir), ...sourceFiles(serverDir)];
for (const file of delphiFiles) {
    const bytes = fs.readFileSync(file);
    assert.deepStrictEqual(Array.from(bytes.subarray(0, 3)), [0xEF, 0xBB, 0xBF],
        `${path.basename(file)}: UTF-8 BOM missing`);
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
const delphiText = delphiFiles.map(file => read(file)).join('\n');
// FIX13.2: TCorner is declared in FMX.Types; uses clauses are unit-local.
const qrRenderer = read(path.join(apkDir, 'ApkQrRenderer.pas'));
const qrUses = [...qrRenderer.matchAll(/\buses\s+([\s\S]*?);/gi)].map(m => m[1]).join(',');
assert.ok(/\bFMX\.Types\b/i.test(qrUses), 'ApkQrRenderer: FMX.Types is required for TCorner');

// FIX13.1: standalone units are not covered by the TForm1-only checks below.
assert.deepStrictEqual(require('./verify_member_declarations').Check(
    read(path.join(apkDir, 'ApkMemberClient.pas'))), [], 'ApkMemberClient declaration errors');
for (const file of delphiFiles) {
    assert.ok(!/^\s*F\w+\s*:\s*\w+\s*,/m.test(read(file)),
        `${path.basename(file)}: unexpected type list in field declaration`);
}
assert.ok(!/\bShellExecute(?:Ex)?\b/i.test(delphiText));
assert.ok(!/\bCreateProcess\b/i.test(delphiText));
assert.ok(!/\bcmd\.exe\b/i.test(delphiText));
assert.ok(!/\bWinapi\.Windows\b/i.test(delphiText));
assert.ok(!/\.Caption\b/.test(delphiText));
assert.ok(!/\{\$R\s+\*\.fmx\}/i.test(delphiText));
assert.ok(!/\{\$CODEPAGE\b/i.test(delphiText));

const apk = fs.readdirSync(apkDir)
    .filter(name => name === 'ApkWinSock.pas' || /^ApkWinSock\..+\.inc$/i.test(name))
    .sort().map(name => read(path.join(apkDir, name))).join('\n');
const apkState = read(path.join(apkDir, 'ApkClientState.pas'));
const apkProtocol = read(path.join(apkDir, 'ApkProtocol.pas'));
const apkOwnerSource = read(path.join(apkDir, 'ApkWinSock.pas'));
const apkOwner = apkOwnerSource.replace(/\{\$I (ApkWinSock\.(?:Fields|Methods)\.inc)\}/g, (_, file) => read(path.join(apkDir, file)));
const apkUserProfile = read(path.join(apkDir, 'ApkUserProfile.pas'));
const apkIdentity = read(path.join(apkDir, 'ApkDeviceIdentity.pas'));
const apkNotifications = read(path.join(apkDir, 'ApkAndroidNotifications.pas'));
const androidManifest = read(path.join(apkDir, 'AndroidManifest.full.xml'));
const formClass = apkOwner.slice(apkOwner.indexOf('TForm1 = class'),
    apkOwner.indexOf('\n  end;', apkOwner.indexOf('TForm1 = class')));
const declaredFormMethods = [...formClass.matchAll(/\b(?:procedure|function)\s+(\w+)\b/g)]
    .map(match => match[1]);
const implementedFormMethods = [...apk.matchAll(/\b(?:procedure|function)\s+TForm1\.(\w+)\b/g)]
    .map(match => match[1]);
assert.deepStrictEqual([...new Set(declaredFormMethods.filter(name =>
    !implementedFormMethods.includes(name)))], [], 'TForm1 declaration without implementation');
for (const feature of ['Ui', 'Lifecycle', 'QrAuth', 'BiometricBuild', 'Extensions', 'Protocol', 'Connection', 'Support', 'Installation', 'Permissions']) {
    assert.ok(apkOwner.includes(`{$I ApkWinSock.${feature}.inc}`));
    assert.ok(fs.existsSync(path.join(apkDir, `ApkWinSock.${feature}.inc`)));
}
assert.ok(apkOwnerSource.split(/\r?\n/).length < 160);
assert.ok(apk.includes('inherited CreateNew(AOwner)'));
assert.ok(apk.includes('FQrCountdownTimer.Interval := 1000'));
assert.ok(!apk.includes('FSendButton'));
assert.ok(!apk.includes('SendButtonClick'));
assert.ok(apk.includes('procedure TForm1.TryAutomaticBuild'));
assert.ok(apk.includes('procedure TForm1.SetWebStatus'));
assert.ok(apk.includes('UntilValue: Int64;'));
assert.ok(!apk.includes('FBuildWaitPanel'));
assert.ok(!apk.includes('ShowBuildWaitingPage'));
assert.ok(!apk.includes('FDisplayGuid'));
assert.ok(!apk.includes('DisplayGuidValue'));
assert.ok(!apk.includes('WinSockServer.exe를 실행해주세요.'));
assert.ok(apk.includes('FBiometricAuth: TBiometricAuth'));
assert.ok(apk.includes('TBiometricStrength.Weak'));
assert.ok(!apk.includes('TBiometricStrength.DeviceCredential'));
assert.ok(apk.includes('FBiometricLaunchTimer.Interval := 350'));
assert.ok(apk.includes('procedure TForm1.QueueBiometricAuthentication'));
assert.ok(apk.includes('FBiometricFingerprint: TImage'));
assert.ok(!apk.includes('FBiometricIcon: TLabel'));
assert.ok(apk.includes('FBiometricProgressTimer.Interval := 400'));
assert.ok(!apk.includes('FBiometricProgressValue + 1'));
assert.ok(!apk.includes("IntToStr(SafeValue) + '%'"));
assert.ok(apk.includes('PlatformActive := FBiometricAuth.IsActive'));
assert.ok(apk.includes('SetBiometricProgress(100)'));
assert.ok(apk.includes('FBiometricTimeoutTimer.Interval := BIOMETRIC_PROMPT_TIMEOUT_MS'));
assert.ok(apk.includes('procedure TForm1.CancelBiometricPrompt'));
assert.ok(apk.includes('if not FBiometricPromptActive then ApplyImmersiveFullscreen'));
assert.ok(apk.includes("ALine.StartsWith('BIOMETRIC_CHALLENGE|')"));
assert.ok(apk.includes("ALine.StartsWith('BIOMETRIC_OK|')"));
assert.ok(apk.includes('procedure TForm1.HubReply')); // Contextual purchase/feed feedback is now intentional.
assert.ok(apk.includes("AndroidToast('로그인이 되었습니다.')"));
assert.ok(!apk.includes('ShowIconlessToast'));
assert.ok(!apk.includes('FToastBubble'));
assert.ok(!apk.includes('FTitleBar'));
assert.ok(!apk.includes('SetScreenTitle'));
assert.ok(!apk.includes('FBrightness'));
assert.ok(!fs.existsSync(path.join(apkDir, 'ApkScreenBrightness.pas')));
assert.ok(apk.includes('Result.StyledSettings := []'));
assert.ok(androidManifest.includes('android.permission.POST_NOTIFICATIONS'));
assert.ok(!androidManifest.includes('android.permission.ACCESS_NOTIFICATION_POLICY'));
assert.ok(apk.includes('RequestNotificationPermissionOnce;'));
assert.ok(apkNotifications.includes("CHANNEL_AUTH = 'relay_auth_v2'"));
assert.ok(apkNotifications.includes("Notify('AUTH', Title, MessageText)"));
assert.ok(androidManifest.includes('android.permission.POST_NOTIFICATIONS'));
assert.ok(androidManifest.includes('android.permission.USE_BIOMETRIC'));
assert.ok(androidManifest.includes('android.permission.USE_FINGERPRINT'));
assert.ok(!androidManifest.includes('android.permission.ACCESS_NOTIFICATION_POLICY'));
assert.ok(!androidManifest.includes('android.permission.CAMERA'));
assert.ok(androidManifest.includes('android:value="Project"'));
assert.ok(apk.includes('FSupportButton: TRectangle'));
assert.ok(!apk.includes('FQrCornerH')); 
assert.ok(apk.includes("FOfflineLabel.Text := '인터넷을 연결해주세요.'"));
assert.ok(apk.includes('procedure TForm1.ConnectivityTimerTimer'));
assert.ok(apk.includes('if not NetworkConnected then'));
assert.ok(!apk.includes('FRuntime.ReconnectAttempt > 0'));
assert.ok(apk.includes('FQrPanel.Visible := True'));
assert.ok(apk.includes('QR_COUNTDOWN_MAX_MS = 60 * 1000'));
assert.ok(!apk.includes('FQrActionButton'));
assert.ok(apk.includes('FQrCountdownDeadlineTick: Int64'));
assert.ok(apk.includes('TStopwatch.GetTimeStamp'));
assert.ok(apk.includes('TightenQrCountdown(RemainingMs)'));
assert.ok(apk.includes('procedure TForm1.HubRenderCatalog'));
assert.ok(apk.includes('procedure TForm1.HubRenderMe'));
assert.ok(!apk.includes('FDashboardGroupCard'));
assert.ok(!apk.includes('FDashboardStatusCard'));
assert.ok(!apk.includes('FDashboardGuid'));
assert.ok(apk.includes('procedure TForm1.HubRenderFeed'));
for (const label of ['홈','소식','게임','피드','마이페이지']) {
    assert.ok(read(path.join(apkDir,'ApkDashboardTheme.pas')).includes("'"+label+"'"));
}
for (const contentName of ['테일즈런너', '알투비트', '로스트사가']) {
    assert.ok(read(path.join(apkDir, 'ApkDashboardTheme.pas')).includes(`'${contentName}'`));
}
assert.ok(apk.includes('FDashboardTabsCard: TRectangle'));
assert.ok(apk.includes('FDashboardTabs: array[0..4] of TRectangle'));
assert.ok(apk.includes('FMainPanel: TLayout'));
assert.ok(apk.includes('FDashboardScroll := TVertScrollBox.Create(Self)'));
assert.ok(!apk.includes('FHubNavShape'));assert.ok(apk.includes('FDashboardTabsCard.SetBounds(0,H-72,W,72)'));
assert.ok(apk.includes('FHubFilledIcons[FDashboardActiveTab].Scale.X:=Pulse'));
assert.ok(!apk.includes('FMainContentTitle'));
assert.ok(!apk.includes('FMainContentSubtitle'));
assert.ok(!apk.includes('FMainContentGuid'));
assert.ok(apk.includes('procedure TForm1.ShowMainPage'));
assert.ok(apk.includes('if not (Sender is TControl) or not FFinalPanel.Visible then Exit'));
assert.ok(apk.includes('procedure TForm1.ShowInitialAuthPage'));
assert.ok(apk.includes("FBiometricMode := 'RESTORE_WAIT'"));
assert.ok(!apk.includes("'--:--'"));
assert.ok(apkUserProfile.includes('procedure TApkUserProfile.MarkQrApproved'));
assert.ok(apkUserProfile.includes('procedure TApkUserProfile.MarkLoginMetadata'));
assert.ok(apkIdentity.includes("Result := 'ANDROID2-'"));
assert.ok(apkIdentity.includes("'.relay-apk-install-id'"));
// Vector icons may specify their own line width.
assert.strictEqual((apk.match(/FNotifier\.NotifyAuthSuccess\(/g) || []).length, 1);
assert.ok(apk.includes("'관리자 승인이 허가 되었습니다.'"));
assert.ok(!apk.includes('FFinalCheckBox'));
assert.ok(apk.includes('FTransportOffline := True'));
assert.ok(apk.includes('FConnectivityTimer.Interval := 250'));
assert.ok(apk.includes('NETWORK_OFFLINE_CONFIRM_MS = 2000'));
assert.ok(apk.includes('FNetworkDownSince: Int64'));
assert.ok(apk.includes('FNetworkOfflineConfirmed: Boolean'));
assert.ok(apk.includes('if NowMs - FNetworkDownSince < NETWORK_OFFLINE_CONFIRM_MS then Exit'));
assert.ok(apk.includes('if FNetworkOfflineConfirmed then ShowOfflinePage'));
assert.ok(read(path.join(apkDir, 'ApkNetworkStatus.pas')).includes('isConnectedOrConnecting'));
assert.ok(apk.includes("FRuntime.SendLine('LINK_PING|'"));
assert.ok(apk.includes("if ALine.StartsWith('LINK_PONG') then Exit"));
assert.ok(apk.includes("ALine.StartsWith('BUILD_SESSION_EXPIRED|')"));
assert.ok(apk.includes("ALine.StartsWith('BUILD_REVOKED|')"));
assert.ok(apkState.includes('FBuildSessionExpiresAt: Int64'));
assert.ok(apkProtocol.includes('BUILD_SESSION_LEASE'));
assert.ok(apkProtocol.includes('FIXED_BUILD_BINDING'));
assert.ok(apkProtocol.includes('TYPE_PROCESSOR_ROUTING'));
assert.ok(apkProtocol.includes('BIOMETRIC_STRONG'));
assert.ok(apkProtocol.includes('BIOMETRIC_WEAK'));
assert.ok(!apkProtocol.includes('SCREEN_BRIGHTNESS'));
assert.ok(apkProtocol.includes('REALTIME_SUPPORT'));

const runtime = fs.readdirSync(serverDir)
    .filter(name => name === 'ServerRuntime.pas' || /^ServerRuntime\..+\.inc$/i.test(name))
    .sort().map(name => read(path.join(serverDir, name))).join('\n');
const protocol = read(path.join(serverDir, 'RelayProtocol.pas'));
const security = read(path.join(serverDir, 'DeviceSecurity.pas'));
const processor = read(path.join(serverDir, 'NumberProcessor.pas'));
const consoleLog = read(path.join(serverDir, 'ConsoleLog.pas'));
const serverIdentity = read(path.join(serverDir, 'DeviceIdentity.pas'));
const serverLocalStorage = read(path.join(serverDir, 'LocalStorage.pas'));
const serverSocket = read(path.join(serverDir, 'RelaySocket.pas'));
const runtimeOwner = read(path.join(serverDir, 'ServerRuntime.pas'));
for (const feature of ['Lifecycle', 'Registration', 'BuildGate', 'ConfigCommand', 'Security', 'Protocol', 'Connection']) {
    assert.ok(runtimeOwner.includes(`{$I ServerRuntime.${feature}.inc}`));
    assert.ok(fs.existsSync(path.join(serverDir, `ServerRuntime.${feature}.inc`)));
}
assert.ok(runtimeOwner.split(/\r?\n/).length < 200);
assert.ok(read(path.join(serverDir, 'ServerInstanceGuard.pas')).includes('fmShareExclusive'));
assert.ok(serverIdentity.includes("Result := 'WIN2-'"));
assert.ok(serverIdentity.includes("WinSockLocalFile('device.id')"));
assert.ok(serverLocalStorage.includes("'.winsockserver-local'"));
assert.ok(serverLocalStorage.includes('TFile.Copy(LegacyFile, Result)'));
assert.ok(serverSocket.includes('SO_RCVTIMEO'));
assert.ok(serverSocket.includes('SO_SNDTIMEO'));
assert.ok(serverSocket.includes('TCP_NODELAY'));
assert.ok(!/[가-힣]/.test(sourceFiles(serverDir).map(file => read(file)).join('\n')));
assert.ok(consoleLog.includes("PrintStatus('BUILD AUTHORIZED - SERVICE READY')"));
assert.ok(consoleLog.includes("PrintStatus('WAITING FOR APK AUTHORIZATION')"));
assert.ok(!consoleLog.includes('SESSION: '));
assert.ok(!consoleLog.includes('LICENSE EXPIRES: '));
assert.ok(runtime.includes('FSecurity.VerifyBuildGrant'));
assert.ok(runtime.includes("Line.StartsWith('BUILD_REVOKE|')"));
assert.ok(runtime.includes('SessionRevoked := FBuildSessions.RevokeSession'));
assert.ok(runtime.includes('STALE BUILD REVOKE IGNORED'));
assert.ok(runtime.includes('while True do'));
assert.ok(runtime.includes('FBuildSessions.IsAuthorized(ClientID'));
assert.ok(runtime.includes("'SERVER_ALREADY_PAIRED'"));
assert.ok(security.includes("'BUILD|' + UpperCase(Trim(ServerID))"));
assert.ok(security.includes("'REVOKE|' + UpperCase(Trim(ServerID))"));
assert.ok(protocol.includes('Length(Parts) <> 7'));
assert.ok(protocol.includes('BUILD_SESSION_LEASE'));
assert.ok(processor.includes("NormalizeAccessType(AccessType) + '/'"));

const admin = fs.readdirSync(path.join(webDir, 'public'))
    .filter(name => /^admin(?:-[a-z-]+)?\.js$/i.test(name))
    .sort().map(name => read(path.join(webDir, 'public', name)).replace(/\\"/g, '"')).join('\n');
const buildGate = read(path.join(webDir, 'services', 'buildGate.js'));
const qrApproval = read(path.join(webDir, 'services', 'qrApproval.js'));
const serverHandler = read(path.join(webDir, 'relay', 'serverHandler.js'));
const userDashboard = read(path.join(webDir, 'services', 'userDashboard.js'));
const recovery = read(path.join(webDir, 'services', 'requestRecovery.js'));
const indexHtml = read(path.join(webDir, 'public', 'index.html'));
for (const moduleName of ['admin.js', 'admin-pages-monitoring.js', 'admin-pages-access.js', 'admin-pages-operations.js', 'admin-actions.js', 'admin-pages-production.js', 'admin-pages-support.js']) {
    assert.ok(indexHtml.includes(`/${moduleName}?v=4.14.0-fix25`));
    assert.ok(fs.existsSync(path.join(webDir, 'public', moduleName)));
}
assert.ok(read(path.join(webDir, 'web', 'apiContext.js')).includes("require('./routes/buildQrRoutes')"));
assert.ok(fs.existsSync(path.join(webDir, 'web', 'routes', 'buildQrRoutes.js')));
const webApiSource = [read(path.join(webDir, 'web', 'webApi.js')), read(path.join(webDir, 'web', 'apiContext.js')), ...fs.readdirSync(path.join(webDir, 'web', 'routes')).map(n=>read(path.join(webDir, 'web', 'routes', n)))].join('\n');
assert.ok(webApiSource.includes("const qrApproval = require('../services/qrApproval')"));
assert.ok(webApiSource.includes("const buildGate = require('../services/buildGate')"));
assert.ok(webApiSource.includes("pathname === '/api/pairing/repair'"));
assert.ok(webApiSource.includes("pathname === '/api/history/clean'"));
assert.ok(webApiSource.includes("deviceRegistry.DeleteServer"));
assert.ok(webApiSource.includes("deviceRegistry.DeleteClient"));
assert.ok(admin.includes('class="api-error"'));
assert.ok(indexHtml.includes('4.14.0-fix25'));
assert.ok(admin.includes('data-history-clean="SERVER_HISTORY"'));
assert.ok(admin.includes('data-history-clean="CLIENT_HISTORY"'));
assert.ok(admin.includes('>삭제</button>'));
for (const contentName of ['TalesRunner', 'R2Beat', 'Lostsaga']) {
    assert.ok(admin.includes(contentName));
}
for (const acceptState of ['READY', 'FULL', 'OFFLINE', 'DRAINING', 'DISABLED', 'KICKED']) {
    assert.ok(webApiSource.includes(`acceptState = '${acceptState}'`));
}
assert.ok(admin.includes('s.acceptState'));
assert.ok(admin.includes('async function renderBuildSessions()'));
assert.ok(admin.includes('data-build-revoke'));
assert.ok(admin.includes('data-server-action="delete"'));
assert.ok(admin.includes('data-client-action="delete"'));
assert.ok(admin.includes('data-history-clean="ALL"'));
assert.ok(admin.includes('pairing-repair-btn'));
assert.ok(buildGate.includes('function GrantProof'));
assert.ok(buildGate.includes('function Rebind'));
assert.ok(buildGate.includes('function BindingForServer'));
assert.ok(buildGate.includes('SERVER_ALREADY_PAIRED'));
assert.ok(buildGate.includes("require('../relay/serverHandler').BindUnassignedClients(serverId)"));
assert.ok(qrApproval.includes('deferred: !record.serverId'));
assert.ok(!qrApproval.includes('BindForApproval(record.clientId'));
assert.ok(!admin.includes('const pairableServers'));
assert.ok(serverHandler.includes('targetServer.deviceAuthVerified !== true'));
assert.ok(serverHandler.includes('live.deviceAuthVerified === true && live.biometricVerified === true'));
assert.ok(serverHandler.includes('ERROR|SERVER_ALREADY_RUNNING'));
assert.ok(serverHandler.includes('state.pendingBuildGrants.get(saved.id)'));
assert.ok(serverHandler.includes("saved.pairingApprovedBy = 'DEFERRED_BUILD_CLAIM'"));
assert.ok(userDashboard.includes('crypto.randomUUID()'));
assert.ok(userDashboard.includes("GROUPS = Object.freeze(['TYPE1', 'TYPE2', 'TYPE3'])"));
assert.ok(read(path.join(webDir, 'config', 'config.js')).includes('const MAX_CLIENTS_PER_SERVER = 1'));
assert.ok(read(path.join(webDir, 'identity', 'identityManager.js')).includes('function RepairOneToOneAssignments'));
assert.ok(read(path.join(webDir, 'identity', 'identityManager.js')).includes('function RepairOrphanAssignments'));
assert.ok(read(path.join(webDir, 'identity', 'identityManager.js')).includes("return online ? online.serverId : ''"));
assert.ok(read(path.join(webDir, 'relay', 'serverHandler.js')).includes('function MigrateLegacyServerIdentity'));
assert.ok(read(path.join(webDir, 'relay', 'clientHandler.js')).includes('function MigrateLegacyClientIdentity'));
assert.ok(read(path.join(webDir, 'relay', 'serverHandler.js')).includes('A stale, merely connected, or partially authenticated APK must never'));
assert.ok(read(path.join(webDir, 'relay', 'clientHandler.js')).includes('const existingGrant = state.pendingBuildGrants.get(clientId)'));
assert.ok(recovery.includes('function BuildSessionReady'));
const biometricService = read(path.join(webDir, 'services', 'clientBiometric.js'));
const lifecycle = read(path.join(webDir, 'core', 'lifecycle.js'));
const connection = read(path.join(webDir, 'core', 'connection.js'));
assert.ok(biometricService.includes('BIOMETRIC_CHALLENGE'));
assert.ok(biometricService.includes('function HandleProof'));
assert.ok(biometricService.includes('crypto.timingSafeEqual'));
assert.ok(!fs.existsSync(path.join(webDir, 'services', 'clientPassword.js')));
assert.ok(connection.includes('superseded:false'));
assert.ok(lifecycle.includes('SERVER_STALE_CONNECTION_CLOSED'));
assert.ok(lifecycle.includes('CLIENT_STALE_CONNECTION_CLOSED'));
assert.ok(lifecycle.includes('currentServer&&currentServer!==connection'));
assert.ok(lifecycle.includes('currentClient&&currentClient!==connection'));

const allNames = fs.readdirSync(root, { recursive: true }).map(String).join('\n');
assert.ok(!/DownWinSock/i.test(allNames));

console.log('SOURCE VALIDATION PASS');
console.log('- Missing units / banned APIs / FMX resource regressions: NONE');
console.log('- Build lease, revoke, fixed binding and TYPE routing tokens: PASS');
console.log('- APK module includes / Server modules / Web Admin modular routes and actions: PASS');
console.log('- Delphi UTF-8 BOM / APK Korean / Server ASCII encoding policy: PASS');

for (const method of implementedFormMethods) assert.ok(declaredFormMethods.includes(method), `Undeclared TForm1 method: ${method}`);
assert.ok(!apk.includes('FBiometricButton'));
assert.ok(!apk.includes('BiometricButtonClick'));
assert.ok(apkUserProfile.includes('FResumeStage'));
assert.ok(apk.includes('procedure TForm1.CompleteReinstallProbe'));
const declaredFields = new Set([...formClass.matchAll(/\b(F\w+)\s*:/g)].map(m => m[1].toLowerCase()));
for (const name of new Set([...apk.matchAll(/\b(F[A-Z]\w*)\b/g)].map(m => m[1]))) {
  if (['FMX', 'FREQUENCY', 'FIX7', 'FORM', 'FIRST', 'FILL', 'Fill', 'FullScreen', 'False', 'Frequency'].includes(name)) continue;
  // Only application F-prefixed variables; uppercase prose is excluded.
  if (/^F[A-Z][a-z]\w*$/.test(name)) assert.ok(declaredFields.has(name.toLowerCase()), `Undeclared form field: ${name}`);
}

// Validate exact status-icon path operands; a missing cubic operand crashes
// first rendering on some FMX backends even when Pascal compilation succeeds.
const svgFiles = ['auth', 'blocked', 'offline', 'fingerprint'];
for (const name of svgFiles) {
  const svg = read(path.join(apkDir, 'icons', name + '.svg'));
  assert.ok(svg.includes('#17191e'));
  const data = / d="([^"]+)"/.exec(svg)[1];
  const tokens = data.match(/[MCLZ]|-?\d+(?:\.\d+)?/g);
  for (let i=0; i<tokens.length;) {
    const command=tokens[i++], count={M:2,L:2,C:6,Z:0}[command];
    assert.ok(count !== undefined, 'Invalid path command');
    const operands=tokens.slice(i,i+count); i+=count;
    assert.ok(operands.length===count && operands.every(v=>Number.isFinite(Number(v))), 'Invalid cubic operands');
  }
}
const glyphs = read(path.join(apkDir, 'ApkSmoothGlyphs.pas'));
for (const block of glyphs.matchAll(/GLYPH_\w+ =\s*([\s\S]*?);/g)) {
  const png = Buffer.from([...block[1].matchAll(/'([^']*)'/g)].map(m=>m[1]).join(''), 'base64');
  assert.equal(png.subarray(1,4).toString(),'PNG');
  assert.equal(png.readUInt32BE(16),512); assert.equal(png.readUInt32BE(20),512);
}
assert.ok(apk.includes('if not PermissionsReady then Exit;'));
assert.ok(apk.includes('FUserProfile.SetPermissionResetPending(True)'));
assert.ok(apk.includes('CLIENT_PERMISSIONS_OK|'));
assert.ok(apk.includes('procedure TForm1.RevokePermissionSession'));
assert.ok(!apk.includes('관리자 오프라인 · 문의 접수 가능'));
assert.ok(!apk.includes('FUnblockButton'));
assert.ok(!apk.includes('UnblockCheckClick'));
assert.ok(!apk.includes('최근 대화 60개'));
assert.ok(apk.includes("'SUPPORT_SEND_V2|'"));
assert.ok(apk.includes("'SUPPORT_SYNC|'"));
assert.ok(apk.includes('FUserProfile.SetReleaseNotificationPending(True)'));
console.log('- Status vector operands / automatic probes / support protocol declarations: PASS');
