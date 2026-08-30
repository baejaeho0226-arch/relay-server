'use strict';

process.on('uncaughtException', error => {
    console.error('================================');
    console.error('FATAL UNCAUGHT EXCEPTION');
    console.error('================================');
    console.error(error && error.stack ? error.stack : error);
    console.error('================================');
    process.exit(1);
});

process.on('unhandledRejection', reason => {
    console.error('================================');
    console.error('FATAL UNHANDLED REJECTION');
    console.error('================================');
    console.error(reason && reason.stack ? reason.stack : reason);
    console.error('================================');
    process.exit(1);
});


const net = require('net');
const http = require('http');

const config = require('./config/config');
const state = require('./core/state');
const { EnsureDirs } = require('./core/utils');
const { LoadRecentAudit, LogEvent } = require('./storage/audit');
const { LoadDatabase, SaveDatabase } = require('./storage/database');
const { CreateBackup } = require('./storage/backup');
const { CreateConnection } = require('./core/connection');
const { CleanupRequestHistory, ProcessPendingRequests } = require('./relay/ackManager');
const { CleanupTransient, Shutdown } = require('./core/lifecycle');
const { ApplyMaintenanceSchedule } = require('./services/maintenance');
const { ValidateClientLicense } = require('./license/licenseManager');
const { SendPing } = require('./relay/heartbeat');
const { HealthSnapshot } = require('./services/dashboard');
const { GetOnlineServer, GetOnlineClient } = require('./identity/identityManager');
const { StartWebAdmin } = require('./web/webServer');
const { CleanupReconnectHistory } = require('./services/reconnectMonitor');
const { ScanLicenseExpiryAlerts } = require('./services/licenseMonitor');
const { CheckDrainReadiness } = require('./services/drainMonitor');

const {
    HOST, PORT, HEALTH_PORT, WEB_ADMIN_PORT, WEB_ADMIN_VERSION, ENABLE_LEGACY_TCP_ADMIN,
    DATA_DIR, CURRENT_PROTOCOL_VERSION,
    MAX_CLIENTS_PER_SERVER,
    ACK_RETRY_MS, ACK_TIMEOUT_MS,
    AUTO_BACKUP_INTERVAL_MS
} = config;

const { servers, clients } = state;

EnsureDirs();
LoadRecentAudit();
LoadDatabase();
ScanLicenseExpiryAlerts();

const relayServer = net.createServer(CreateConnection);

relayServer.on('error', error =>
    console.error('SERVER ERROR:', error.message)
);

relayServer.listen(PORT, HOST, () => {
    console.log('================================');
    console.log('       PURE TCP RELAY vNext');
    console.log('================================');
    console.log('TCP Port:', PORT);
    console.log('DATA_DIR:', DATA_DIR);
    console.log('Protocol current/min:', CURRENT_PROTOCOL_VERSION, '/', state.minProtocolVersion);
    console.log('Min Server:', state.minServerVersion, 'Min Client:', state.minClientVersion);
    console.log('Max clients/server:', MAX_CLIENTS_PER_SERVER);
    console.log('ACK retry/timeout:', ACK_RETRY_MS, '/', ACK_TIMEOUT_MS);
    console.log('Service:', state.serviceEnabled ? 'ONLINE' : 'OFFLINE', 'Maintenance:', state.maintenanceMode ? 'ON' : 'OFF');
    console.log('Web Admin:', `v${WEB_ADMIN_VERSION}`, 'Port:', WEB_ADMIN_PORT);
    console.log('Legacy TCP Admin:', ENABLE_LEGACY_TCP_ADMIN ? 'ENABLED' : 'DISABLED');
    console.log('Device Extensions:', 'ENABLED (CAPABILITIES / DEVICE_INFO / HMAC / CONFIG / SEQUENCE)');
    console.log('================================');
});

StartWebAdmin();

if (HEALTH_PORT > 0 && HEALTH_PORT !== WEB_ADMIN_PORT) {
    const health = http.createServer((req, res) => {
        if (req.url !== '/health' && req.url !== '/healthz') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not_found' }));
            return;
        }

        const body = HealthSnapshot();
        res.writeHead(body.ok ? 200 : 503, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store'
        });
        res.end(JSON.stringify(body));
    });

    health.listen(HEALTH_PORT, HOST, () =>
        console.log('Health HTTP Port:', HEALTH_PORT)
    );
}

setInterval(() => {
    CleanupRequestHistory();
    CleanupTransient();
    ProcessPendingRequests();
    ApplyMaintenanceSchedule();
    CleanupReconnectHistory();
    CheckDrainReadiness();
}, 1000);

setInterval(() => {
    const now=Date.now(), hb=Math.max(1000,Number(state.desiredRuntimeConfig.heartbeatMs)||10000);
    for (const c of Array.from(servers.values())) {
        if (!c.socket || c.socket.destroyed) continue;
        if (now - c.lastSeen > Math.max(30000,hb*3)) { c.socket.destroy(); continue; }
        if(!c.nextPingAt||now>=c.nextPingAt){SendPing(c);c.nextPingAt=now+hb;}
    }
    for (const c of Array.from(clients.values())) {
        if (!c.socket || c.socket.destroyed) continue;
        if (now - c.lastSeen > Math.max(30000,hb*3)) { c.socket.destroy(); continue; }
        ValidateClientLicense(c);
        if(!c.nextPingAt||now>=c.nextPingAt){SendPing(c);c.nextPingAt=now+hb;}
    }
}, 1000);

setInterval(() => SaveDatabase(), 30000);
setInterval(() => ScanLicenseExpiryAlerts(), 60000);
setInterval(() => CreateBackup('auto'), AUTO_BACKUP_INTERVAL_MS);

process.on('SIGINT', Shutdown);
process.on('SIGTERM', Shutdown);
