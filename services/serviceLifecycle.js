'use strict';

// One service lifecycle for HTTP and legacy TCP administration. Waiting sockets
// are deliberately outside the online device registries and cannot do work.
const state = require('../core/state');
const { SendLine, Now } = require('../core/utils');
const waiting = new Set();
let timer = null;
const DEVICE_MAPS = [
  'servers','clients','serverIdentities','clientIdentities','licenses',
  'disabledServers','drainingServers','disabledClients','kickedServers','kickedClients',
  'requestHistory','requestTraces','pendingRequests','rateLimits','ipHistory',
  'serverAliases','clientAliases','serverNotes','clientNotes','serverDrainMeta',
  'serverFeatureOverrides','clientFeatureOverrides','serverProtocolProfiles','clientProtocolProfiles',
  'deviceSecrets','deviceAuthStatus','deviceAuthChallenges','deviceInfo','deviceCapabilities','deviceDiagnostics',
  'clientUiStates','deviceReleaseChannels','deviceUpdateStatus','deviceEnrollments',
  'deviceSecretRotations','deviceSecretMeta','deviceNetworkProfiles','clientFailoverEnabled',
  'clientFailoverRecords','clientServerBindings','clientOfflineQueueEnabled','offlineQueue','deadLetters',
  'processorStats','pendingDeviceCommands','qrAuthRequests','clientBiometricProfiles',
  'clientBiometricChallenges','pendingBuildGrants','buildSessions','clientBuildBindings',
  'accessGroupGuids','supportThreads'
];
const save = () => require('../storage/database').SaveDatabase();
function Forget(connection) {
  waiting.delete(connection);
  if (!waiting.size && timer) { clearInterval(timer); timer = null; }
}
function Park(connection) {
  if (!connection || !connection.socket || connection.socket.destroyed) return;
  const first = !waiting.has(connection);
  connection.serviceWaiting = true;
  connection.registered = false;
  connection.connected = false;
  connection.licenseAuthorized = false;
  connection.licenseKey = '';
  connection.licenseExpiresAt = 0;
  connection.biometricVerified = false;
  connection.deviceAuthVerified = false;
  connection.permissionsGranted = false;
  connection.buildCompleted = false;
  connection.buildUnlocked = false;
  connection.buildSessionId = '';
  connection.clients?.clear();
  connection.buildClients?.clear();
  connection.buildSessions?.clear();
  connection.accessType = '';
  connection.permissionSequence = 0;
  connection.permissionMask = -1;
  if (first) {
    connection.serviceLastSeen = Now();
    waiting.add(connection);
    SendLine(connection.socket, 'SERVICE_STATE|DISABLED');
  }
  if (!timer) {
    timer = setInterval(() => {
      for (const c of waiting) {
        if (c.socket.destroyed || Now() - c.serviceLastSeen > 45000) {
          Forget(c); c.socket.destroy(); continue;
        }
        SendLine(c.socket, `PING|SERVICE-${Now()}`);
      }
    }, 10000);
    timer.unref();
  }
}
function Gate(connection, line) {
  if (connection.type === 'admin') return false;
  if (state.serviceEnabled) {
    if (!connection.serviceWaiting) return false;
    // A pre-reset transport can only request a fresh connection; its late
    // close must not create offline/history records for a deleted device.
    SendLine(connection.socket, 'SERVICE_STATE|ONLINE');
    connection.socket.end?.();
    return true;
  }
  line = String(line).trim();
  if (connection.type !== 'server') {
    const installation = require('./clientInstallation');
    if (connection.reinstallBlocked || installation.IsBlocked(connection)) { installation.Reject(connection); return true; }
    if (line === 'CONNECT' || line.startsWith('CONNECT|') || line.startsWith('CONNECT_INSTALLATION|')) {
      const packet = require('../relay/clientConnectPacket').Parse(line);
      if (!packet.ok) { SendLine(connection.socket, `ERROR|${packet.reason}`); return true; }
      if (!installation.CheckDeviceKey(connection, packet.deviceKey, packet.installationToken) ||
          !installation.CheckConnectToken(connection, packet.deviceKey, packet.installationToken)) return true;
    }
  }
  Park(connection);
  connection.serviceLastSeen = Now();
  if (line === 'LINK_PING' || line.startsWith('LINK_PING|')) {
    const token = String(line.split('|')[1] || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
    SendLine(connection.socket, token ? `LINK_PONG|${token}` : 'LINK_PONG');
  }
  // Nothing else, including registration, QR, support and delayed ACKs, may
  // repopulate the cleared state while the service is stopped.
  return true;
}
function Stop(actor = 'ADMIN') {
  state.serviceEnabled = false;
  state.maintenanceMode = false;
  state.maintenanceSchedule = null;
  // Persist the closed gate before any cleanup; a restart must stay stopped.
  const gateSaved = save();
  require('./clientInstallation').PrepareServiceReset();
  const summary = { servers: state.serverIdentities.size, clients: state.clientIdentities.size,
    licenses: state.licenses.size, sessions: state.buildSessions.size, conversations: state.supportThreads.size };
  for (const server of state.servers.values()) {
    // Older WinSockServer also understands CLIENT_UNAUTHORIZED.
    const ids = new Set([...(server.clients || []), ...(server.buildClients || [])]);
    for (const session of state.buildSessions.values()) if (session.serverId === server.serverId) ids.add(session.clientId);
    for (const id of ids) SendLine(server.socket, `CLIENT_UNAUTHORIZED|${id}|SERVICE_DISABLED`);
  }
  for (const c of [...state.servers.values(), ...state.clients.values()]) Park(c);
  for (const name of DEVICE_MAPS) state[name].clear();
  for (const value of Object.values(state.runtimeStats)) if (value instanceof Map) value.clear();
  for (const name of ['ackOk','ackError','ackTimeout','ackRetries','queuedRequests','dequeuedRequests','replayedRequests','deadLetteredRequests','notices']) state.runtimeStats[name] = 0;
  for (const name of ['pairingClaims','updateTransactions','anomalyFindings','privilegedApprovals']) state.production[name].clear();
  state.production.diagnosticsBundles = [];
  state.events.length = 0;
  state.notifications.length = 0;
  state.confirmTokens.clear();
  state.licenseRevision++;
  // Installation anti-reinstall records, admin credentials, policies, releases,
  // backups and audit history survive this operational reset.
  const cleaned = save();
  require('../storage/audit').LogEvent('SERVICE_STOP', `${actor} ${JSON.stringify(summary)}`);
  require('../web/webEvents').BroadcastServiceState({ enabled: false, cleared: summary });
  return { ok: gateSaved && cleaned, ...(gateSaved && cleaned ? {} : { reason: 'DATABASE_SAVE_FAILED' }), cleared: summary };
}
function Start(actor = 'ADMIN') {
  if (state.serviceEnabled) return { ok: true, alreadyStarted: true, resumed: 0 };
  state.serviceEnabled = true;
  state.maintenanceMode = false;
  if (!save()) { state.serviceEnabled = false; return { ok: false, reason: 'DATABASE_SAVE_FAILED' }; }
  let resumed = 0;
  for (const c of Array.from(waiting)) {
    Forget(c);
    if (!c.socket.destroyed && SendLine(c.socket, 'SERVICE_STATE|ONLINE')) resumed++;
  }
  require('../storage/audit').LogEvent('SERVICE_START', `${actor} resumed=${resumed}`);
  require('../web/webEvents').BroadcastServiceState({ enabled: true });
  return { ok: true, resumed };
}
module.exports = { Start, Stop, Gate, Forget, DEVICE_MAPS };
