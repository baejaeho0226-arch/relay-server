'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const state = require('../core/state');

const { HOST, PORT, HEALTH_PORT, DATA_DIR, DB_FILE, DB_BAK_FILE, BACKUP_DIR, AUDIT_DIR, CURRENT_PROTOCOL_VERSION, DEFAULT_MIN_PROTOCOL_VERSION, DEFAULT_MIN_SERVER_VERSION, DEFAULT_MIN_CLIENT_VERSION, ADMIN_CREDENTIALS, ADMIN_AUTH_WINDOW_SECONDS, ADMIN_SESSION_TIMEOUT_MS, CONFIRM_TOKEN_TTL_MS, SERVER_KICK_BLOCK_MS, CLIENT_KICK_BLOCK_MS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, MAX_CLIENTS_PER_SERVER, REQUEST_HISTORY_TIMEOUT_MS, ACK_RETRY_MS, ACK_TIMEOUT_MS, ACK_MAX_RETRIES, MAX_INPUT_BUFFER, MAX_BULK_KEYS, MAX_SEARCH_RESULTS, MAX_EVENT_MEMORY, AUTO_BACKUP_INTERVAL_MS, MAX_BACKUPS, DANGEROUS_PREFIXES } = config;
const { servers, clients, serverIdentities, clientIdentities, licenses, disabledServers, drainingServers, disabledClients, kickedServers, kickedClients, requestHistory, pendingRequests, rateLimits, events, confirmTokens, ipHistory, runtimeStats } = state;

function AdminAllowed(...args) { return require('./auth').AdminAllowed(...args); }
function AuditSearch(...args) { return require('../storage/audit').AuditSearch(...args); }
function ClientExists(...args) { return require('../identity/identityManager').ClientExists(...args); }
function ClientHealth(...args) { return require('../identity/identityManager').ClientHealth(...args); }
function ClientMove(...args) { return require('../identity/identityManager').ClientMove(...args); }
function CreateBackup(...args) { return require('../storage/backup').CreateBackup(...args); }
function CreateLicense(...args) { return require('../license/licenseManager').CreateLicense(...args); }
function DeleteLicense(...args) { return require('../license/licenseManager').DeleteLicense(...args); }
function EnforceVersionPolicy(...args) { return require('../services/versionPolicy').EnforceVersionPolicy(...args); }
function ExecuteConfirmed(...args) { return require('./auth').ExecuteConfirmed(...args); }
function ExtendLicense(...args) { return require('../license/licenseManager').ExtendLicense(...args); }
function FindClientDeviceKey(...args) { return require('../identity/identityManager').FindClientDeviceKey(...args); }
function FindLicense(...args) { return require('../license/licenseManager').FindLicense(...args); }
function FindServerDeviceKey(...args) { return require('../identity/identityManager').FindServerDeviceKey(...args); }
function GetBoundLicenseEntry(...args) { return require('../license/licenseManager').GetBoundLicenseEntry(...args); }
function GetKickUntil(...args) { return require('../identity/identityManager').GetKickUntil(...args); }
function GetLicenseStatus(...args) { return require('../license/licenseManager').GetLicenseStatus(...args); }
function GetOnlineClient(...args) { return require('../identity/identityManager').GetOnlineClient(...args); }
function GetOnlineServer(...args) { return require('../identity/identityManager').GetOnlineServer(...args); }
function GetSavedClientByID(...args) { return require('../identity/identityManager').GetSavedClientByID(...args); }
function HandleAdminAuth(...args) { return require('./auth').HandleAdminAuth(...args); }
function HandleAdminHello(...args) { return require('./auth').HandleAdminHello(...args); }
function IsDangerousCommand(...args) { return require('./auth').IsDangerousCommand(...args); }
function LogEvent(...args) { return require('../storage/audit').LogEvent(...args); }
function NormalizeID(...args) { return require('../core/utils').NormalizeID(...args); }
function NormalizeLicenseKey(...args) { return require('../core/utils').NormalizeLicenseKey(...args); }
function NormalizeVersion(...args) { return require('../core/utils').NormalizeVersion(...args); }
function NoticeAll(...args) { return require('../relay/notifications').NoticeAll(...args); }
function NoticeClient(...args) { return require('../relay/notifications').NoticeClient(...args); }
function NotifyServerUnauthorized(...args) { return require('../relay/notifications').NotifyServerUnauthorized(...args); }
function Now(...args) { return require('../core/utils').Now(...args); }
function PrepareConfirm(...args) { return require('./auth').PrepareConfirm(...args); }
function ReissueLicense(...args) { return require('../license/licenseManager').ReissueLicense(...args); }
function RestoreBackup(...args) { return require('../storage/backup').RestoreBackup(...args); }
function ResumeLicense(...args) { return require('../license/licenseManager').ResumeLicense(...args); }
function SafeField(...args) { return require('../core/utils').SafeField(...args); }
function SafeIP(...args) { return require('../core/utils').SafeIP(...args); }
function SaveDatabase(...args) { return require('../storage/database').SaveDatabase(...args); }
function SearchLicenses(...args) { return require('../license/licenseManager').SearchLicenses(...args); }
function SendLicenseItem(...args) { return require('../license/licenseManager').SendLicenseItem(...args); }
function SendLine(...args) { return require('../core/utils').SendLine(...args); }
function ServerExists(...args) { return require('../identity/identityManager').ServerExists(...args); }
function ServerHealth(...args) { return require('../identity/identityManager').ServerHealth(...args); }
function SuspendLicense(...args) { return require('../license/licenseManager').SuspendLicense(...args); }
function TransferLicense(...args) { return require('../license/licenseManager').TransferLicense(...args); }
function UnbindLicense(...args) { return require('../license/licenseManager').UnbindLicense(...args); }

function ExecuteAdminCommand(connection, line, confirmed = false) {
    if (IsDangerousCommand(line) && !confirmed) { SendLine(connection.socket, 'ADMIN_ERROR|CONFIRM_REQUIRED'); return; }

    if (line === 'WHOAMI') { SendLine(connection.socket, `ADMIN_ROLE|${connection.adminRole}`); return; }
    if (line === 'VERSION_STATUS') { SendLine(connection.socket, `VERSION_STATUS|${state.minProtocolVersion}|${state.minServerVersion}|${state.minClientVersion}`); return; }

    if (line.startsWith('VERSION_SET|')) {
        if (connection.adminRole !== 'admin') { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        const p = line.split('|');
        const proto = Number(p[1]);
        const sv = NormalizeVersion(p[2]);
        const cv = NormalizeVersion(p[3]);
        if (!Number.isInteger(proto) || proto < 1 || proto > CURRENT_PROTOCOL_VERSION || !sv || !cv) { SendLine(connection.socket, 'VERSION_ERROR|INVALID'); return; }
        state.minProtocolVersion = proto; state.minServerVersion = sv; state.minClientVersion = cv; SaveDatabase();
        SendLine(connection.socket, `VERSION_SET_OK|${proto}|${sv}|${cv}`);
        LogEvent('VERSION_POLICY_CHANGED', `P=${proto} S=${sv} C=${cv}`);
        setTimeout(EnforceVersionPolicy, 250);
        return;
    }

    if (line.startsWith('LIC_CREATE|')) {
        if (connection.adminRole !== 'admin') { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        const p = line.split('|'); const days = Number(p[1]);
        if (!Number.isInteger(days) || days <= 0 || days > 36500) { SendLine(connection.socket, 'LIC_ERROR|INVALID_DAYS'); return; }
        const created = CreateLicense(days, p.slice(2).join('|'));
        SendLine(connection.socket, `LIC_OK|${created.key}|${created.expiresAt}`); return;
    }

    if (line === 'LIC_LIST') {
        if (!AdminAllowed(connection.adminRole, 'LIST')) { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        for (const [key, license] of licenses) SendLicenseItem(connection.socket, key, license);
        SendLine(connection.socket, 'END_LIST'); return;
    }

    if (line.startsWith('LIC_SEARCH|')) {
        if (!AdminAllowed(connection.adminRole, 'SEARCH')) { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        const p = line.split('|');
        for (const item of SearchLicenses(p[1] || '', p[2] || 'ALL')) SendLicenseItem(connection.socket, item.key, item.license);
        SendLine(connection.socket, 'END_SEARCH'); return;
    }

    if (line.startsWith('LIC_EXTEND|')) {
        if (!AdminAllowed(connection.adminRole, 'EXTEND')) { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        const p = line.split('|'); const days = Number(p[2]); const key = NormalizeLicenseKey(p[1]);
        if (!Number.isInteger(days) || days <= 0 || days > 36500) { SendLine(connection.socket, 'LIC_ERROR|INVALID_DAYS'); return; }
        if (!ExtendLicense(key, days)) { SendLine(connection.socket, 'LIC_ERROR|NOT_FOUND'); return; }
        SaveDatabase(); SendLine(connection.socket, `LIC_EXTEND_OK|${key}|${FindLicense(key).expiresAt}`); LogEvent('LICENSE_EXTEND', `${key} +${days}`); return;
    }

    if (line.startsWith('LIC_UNBIND|')) {
        if (!AdminAllowed(connection.adminRole, 'UNBIND')) { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        const key = NormalizeLicenseKey(line.split('|')[1] || '');
        if (!UnbindLicense(key)) { SendLine(connection.socket, 'LIC_ERROR|NOT_FOUND'); return; }
        SaveDatabase(); SendLine(connection.socket, `LIC_UNBIND_OK|${key}`); LogEvent('LICENSE_UNBIND', key); return;
    }

    if (line.startsWith('LIC_SUSPEND|')) {
        if (!AdminAllowed(connection.adminRole, 'SUSPEND')) { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        const key = NormalizeLicenseKey(line.split('|')[1] || '');
        if (!SuspendLicense(key)) { SendLine(connection.socket, 'LIC_ERROR|NOT_FOUND'); return; }
        SaveDatabase(); SendLine(connection.socket, `LIC_SUSPEND_OK|${key}`); LogEvent('LICENSE_SUSPEND', key); return;
    }

    if (line.startsWith('LIC_RESUME|')) {
        if (!AdminAllowed(connection.adminRole, 'RESUME')) { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        const key = NormalizeLicenseKey(line.split('|')[1] || '');
        if (!ResumeLicense(key)) { SendLine(connection.socket, 'LIC_ERROR|NOT_FOUND_OR_EXPIRED'); return; }
        SaveDatabase(); SendLine(connection.socket, `LIC_RESUME_OK|${key}`); LogEvent('LICENSE_RESUME', key); return;
    }

    if (line.startsWith('LIC_REISSUE|')) {
        if (connection.adminRole !== 'admin') { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        const r = ReissueLicense(line.split('|')[1] || '');
        if (!r) { SendLine(connection.socket, 'LIC_ERROR|REISSUE_FAILED'); return; }
        SendLine(connection.socket, `LIC_REISSUE_OK|${r.oldKey}|${r.newKey}|${r.expiresAt}`); return;
    }

    if (line.startsWith('LIC_TRANSFER|')) {
        if (!AdminAllowed(connection.adminRole, 'TRANSFER')) { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        const p = line.split('|'); const r = TransferLicense(p[1] || '', p[2] || '');
        if (!r.ok) { SendLine(connection.socket, `LIC_ERROR|${r.reason}`); return; }
        SendLine(connection.socket, `LIC_TRANSFER_OK|${NormalizeLicenseKey(p[1])}|${NormalizeID(p[2])}`); return;
    }

    for (const def of [
        ['LIC_BULK_EXTEND|', 'EXTEND'], ['LIC_BULK_UNBIND|', 'UNBIND'], ['LIC_BULK_SUSPEND|', 'SUSPEND'],
        ['LIC_BULK_RESUME|', 'RESUME'], ['LIC_BULK_DELETE|', 'DELETE']
    ]) {
        if (!line.startsWith(def[0])) continue;
        const op = def[1];
        if (op === 'DELETE' ? connection.adminRole !== 'admin' : !AdminAllowed(connection.adminRole, op)) { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        const p = line.split('|');
        let days = 0, keys;
        if (op === 'EXTEND') { days = Number(p[1]); keys = p.slice(2); if (!Number.isInteger(days) || days <= 0) { SendLine(connection.socket, 'LIC_ERROR|INVALID_DAYS'); return; } }
        else keys = p.slice(1);
        keys = keys.map(NormalizeLicenseKey).filter(Boolean).slice(0, MAX_BULK_KEYS);
        let success = 0;
        for (const key of keys) {
            if (op === 'EXTEND' && ExtendLicense(key, days)) success++;
            else if (op === 'UNBIND' && UnbindLicense(key)) success++;
            else if (op === 'SUSPEND' && SuspendLicense(key)) success++;
            else if (op === 'RESUME' && ResumeLicense(key)) success++;
            else if (op === 'DELETE' && DeleteLicense(key)) success++;
        }
        SaveDatabase(); SendLine(connection.socket, `${def[0].slice(0,-1)}_OK|${success}|${keys.length}`); return;
    }

    if (line === 'DASHBOARD') {
        if (!AdminAllowed(connection.adminRole, 'DASHBOARD')) { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        let onlineServers = 0, onlineClients = 0, available = 0, bound = 0, expired = 0, suspended = 0;
        for (const id of serverIdentities.values()) if (GetOnlineServer(id)) onlineServers++;
        for (const saved of clientIdentities.values()) if (GetOnlineClient(saved.id)) onlineClients++;
        for (const license of licenses.values()) {
            const s = GetLicenseStatus(license);
            if (s === 'AVAILABLE') available++; else if (s === 'BOUND') bound++; else if (s === 'EXPIRED') expired++; else if (s === 'SUSPENDED') suspended++;
        }
        SendLine(connection.socket, [
            'DASH', `SERVICE=${state.serviceEnabled?'ONLINE':'OFFLINE'}`, `MAINTENANCE=${state.maintenanceMode?'ON':'OFF'}`,
            `SERVERS=${serverIdentities.size}`, `ONLINE_SERVERS=${onlineServers}`, `DISABLED_SERVERS=${disabledServers.size}`,
            `DRAINING_SERVERS=${drainingServers.size}`, `CLIENTS=${clientIdentities.size}`, `ONLINE_CLIENTS=${onlineClients}`,
            `DISABLED_CLIENTS=${disabledClients.size}`, `LICENSES=${licenses.size}`, `AVAILABLE=${available}`, `BOUND=${bound}`,
            `EXPIRED=${expired}`, `SUSPENDED=${suspended}`, `PENDING_ACKS=${pendingRequests.size}`, `ACK_OK=${runtimeStats.ackOk}`,
            `ACK_ERROR=${runtimeStats.ackError}`, `ACK_TIMEOUT=${runtimeStats.ackTimeout}`, `ACK_RETRIES=${runtimeStats.ackRetries}`,
            `MIN_PROTOCOL=${state.minProtocolVersion}`, `MIN_SERVER_VERSION=${state.minServerVersion}`, `MIN_CLIENT_VERSION=${state.minClientVersion}`,
            `MAX_CLIENTS_PER_SERVER=${MAX_CLIENTS_PER_SERVER}`, `RATE_LIMIT=${RATE_LIMIT_MAX}`, `UPTIME_MS=${Now()-runtimeStats.startedAt}`
        ].join('|'));
        for (const event of events.slice(-20)) SendLine(connection.socket, `EVENT|${event.time}|${event.type}|${event.detail}`);
        SendLine(connection.socket, 'END_DASHBOARD'); return;
    }

    if (line === 'SERVER_LIST') {
        if (!AdminAllowed(connection.adminRole, 'SERVER_LIST')) { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        for (const [deviceKey, serverId] of serverIdentities) {
            const live = GetOnlineServer(serverId);
            const kickedUntil = GetKickUntil(kickedServers, serverId);
            let status = live ? 'ONLINE' : 'OFFLINE';
            if (disabledServers.has(serverId)) status = 'DISABLED'; else if (drainingServers.has(serverId)) status = 'DRAINING'; else if (kickedUntil > Now()) status = 'KICKED';
            SendLine(connection.socket, [
                'SERVER_ITEM', serverId, status, live ? live.clients.size : 0, deviceKey,
                live ? live.lastIP : '', live ? live.lastSeen : 0, kickedUntil,
                live ? live.protocolVersion : 0, live ? live.appVersion : '', live ? live.rttMs : -1,
                live ? ServerHealth(live) : 'OFFLINE', runtimeStats.serverReconnects.get(serverId) || 0
            ].join('|'));
        }
        SendLine(connection.socket, 'END_SERVER_LIST'); return;
    }

    if (line === 'CLIENT_LIST') {
        if (!AdminAllowed(connection.adminRole, 'CLIENT_LIST')) { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        for (const [deviceKey, saved] of clientIdentities) {
            const live = GetOnlineClient(saved.id); const boundLic = GetBoundLicenseEntry(saved.id); const kickedUntil = GetKickUntil(kickedClients, saved.id);
            let status = live ? 'ONLINE' : 'OFFLINE';
            if (disabledClients.has(saved.id)) status = 'DISABLED'; else if (kickedUntil > Now()) status = 'KICKED';
            SendLine(connection.socket, [
                'CLIENT_ITEM', saved.id, deviceKey, saved.serverId, status,
                boundLic ? GetLicenseStatus(boundLic.license) : 'NONE', boundLic ? boundLic.key : '', boundLic ? boundLic.license.expiresAt : 0,
                saved.lastAuthAt, saved.lastSeenAt, saved.lastIP, saved.authCount, saved.sendCount, saved.reconnectCount,
                live ? live.protocolVersion : 0, live ? live.appVersion : '', live ? live.rttMs : -1, live ? ClientHealth(live) : 'OFFLINE'
            ].join('|'));
        }
        SendLine(connection.socket, 'END_CLIENT_LIST'); return;
    }

    if (line.startsWith('CLIENT_DETAIL|')) {
        if (!AdminAllowed(connection.adminRole, 'CLIENT_DETAIL')) { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        const clientId = NormalizeID(line.split('|')[1] || ''); const saved = GetSavedClientByID(clientId);
        if (!saved) { SendLine(connection.socket, 'CLIENT_ERROR|NOT_FOUND'); SendLine(connection.socket, 'END_CLIENT_DETAIL'); return; }
        const live = GetOnlineClient(clientId); const lic = GetBoundLicenseEntry(clientId);
        SendLine(connection.socket, [
            'CLIENT_DETAIL_ITEM', clientId, live?'ONLINE':'OFFLINE', FindClientDeviceKey(clientId), saved.serverId,
            lic?lic.key:'', lic?GetLicenseStatus(lic.license):'NONE', lic?lic.license.expiresAt:0,
            saved.lastAuthAt, saved.lastSeenAt, saved.lastIP, saved.authCount, saved.sendCount, saved.reconnectCount,
            live?live.protocolVersion:0, live?live.appVersion:'', live?live.rttMs:-1, live?ClientHealth(live):'OFFLINE'
        ].join('|'));
        SendLine(connection.socket, 'END_CLIENT_DETAIL'); return;
    }

    if (line.startsWith('SERVER_TREE|')) {
        if (!AdminAllowed(connection.adminRole, 'SERVER_TREE')) { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        const serverId = NormalizeID(line.split('|')[1] || '');
        if (!ServerExists(serverId)) { SendLine(connection.socket, 'SERVER_TREE_ERROR|NOT_FOUND'); SendLine(connection.socket, 'END_SERVER_TREE'); return; }
        const live = GetOnlineServer(serverId);
        SendLine(connection.socket, `SERVER_TREE_SERVER|${serverId}|${FindServerDeviceKey(serverId)}|${live?'ONLINE':'OFFLINE'}|${live?ServerHealth(live):'OFFLINE'}`);
        for (const [deviceKey, saved] of clientIdentities) {
            if (saved.serverId !== serverId) continue;
            const lic = GetBoundLicenseEntry(saved.id);
            SendLine(connection.socket, `SERVER_TREE_CLIENT|${saved.id}|${deviceKey}|${GetOnlineClient(saved.id)?'ONLINE':'OFFLINE'}|${lic?GetLicenseStatus(lic.license):'NONE'}`);
        }
        SendLine(connection.socket, 'END_SERVER_TREE'); return;
    }

    if (line === 'AUDIT_LIST' || line.startsWith('AUDIT_SEARCH|')) {
        if (!AdminAllowed(connection.adminRole, 'AUDIT')) { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        let result = events;
        if (line.startsWith('AUDIT_SEARCH|')) {
            const p = line.split('|'); result = AuditSearch(p[1] || '', p[2] || 'ALL', Number(p[3]) || 0);
        }
        for (const e of result.slice(-MAX_SEARCH_RESULTS)) SendLine(connection.socket, `AUDIT|${e.time}|${e.type}|${e.detail}`);
        SendLine(connection.socket, 'END_AUDIT'); return;
    }

    if (line === 'BACKUP_CREATE') {
        if (connection.adminRole !== 'admin') { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        const f = CreateBackup('manual'); SendLine(connection.socket, f ? `BACKUP_OK|${f}` : 'BACKUP_ERROR|CREATE_FAILED'); return;
    }

    if (line === 'BACKUP_LIST') {
        if (!AdminAllowed(connection.adminRole, 'VIEW')) { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        try {
            for (const file of fs.readdirSync(BACKUP_DIR).filter(x=>x.endsWith('.json')).sort().reverse()) {
                const st = fs.statSync(path.join(BACKUP_DIR, file)); SendLine(connection.socket, `BACKUP_ITEM|${file}|${st.size}|${st.mtimeMs}`);
            }
        } catch (_) {}
        SendLine(connection.socket, 'END_BACKUP_LIST'); return;
    }

    if (line.startsWith('BACKUP_RESTORE|')) {
        if (connection.adminRole !== 'admin') { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        const r = RestoreBackup(line.substring('BACKUP_RESTORE|'.length));
        SendLine(connection.socket, r.ok ? `BACKUP_RESTORE_OK|${r.fileName}|${r.preRestore}` : `BACKUP_ERROR|${r.reason}`); return;
    }

    if (line.startsWith('BACKUP_DELETE|')) {
        if (connection.adminRole !== 'admin') { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        const file = path.basename(line.substring('BACKUP_DELETE|'.length)); const fp = path.join(BACKUP_DIR, file);
        try { if (!fs.existsSync(fp)) { SendLine(connection.socket, 'BACKUP_ERROR|NOT_FOUND'); return; } fs.unlinkSync(fp); SendLine(connection.socket, `BACKUP_DELETE_OK|${file}`); LogEvent('BACKUP_DELETE', file); }
        catch (_) { SendLine(connection.socket, 'BACKUP_ERROR|DELETE_FAILED'); }
        return;
    }

    if (line.startsWith('SERVER_KICK|')) {
        if (connection.adminRole !== 'admin') { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        const id = NormalizeID(line.split('|')[1] || ''); if (!ServerExists(id)) { SendLine(connection.socket, 'ADMIN_ERROR|SERVER_NOT_FOUND'); return; }
        const until = Now() + SERVER_KICK_BLOCK_MS; kickedServers.set(id, until); const live = GetOnlineServer(id);
        if (live) { SendLine(live.socket, `ERROR|ADMIN_KICK|${until}`); live.socket.destroy(); }
        SendLine(connection.socket, `SERVER_KICK_OK|${id}|${until}`); LogEvent('SERVER_KICK', `${id} until ${until}`); return;
    }

    if (line.startsWith('SERVER_DISABLE|') || line.startsWith('SERVER_ENABLE|') || line.startsWith('SERVER_DRAIN_ON|') || line.startsWith('SERVER_DRAIN_OFF|')) {
        if (connection.adminRole !== 'admin') { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        const p = line.split('|'); const id = NormalizeID(p[1] || ''); if (!ServerExists(id)) { SendLine(connection.socket, 'ADMIN_ERROR|SERVER_NOT_FOUND'); return; }
        if (line.startsWith('SERVER_DISABLE|')) {
            disabledServers.add(id); drainingServers.delete(id); kickedServers.delete(id); SaveDatabase(); const live=GetOnlineServer(id); if(live){SendLine(live.socket,'ERROR|SERVER_DISABLED');live.socket.destroy();}
            SendLine(connection.socket, `SERVER_DISABLE_OK|${id}`); LogEvent('SERVER_DISABLE', id);
        } else if (line.startsWith('SERVER_ENABLE|')) {
            disabledServers.delete(id); kickedServers.delete(id); SaveDatabase(); SendLine(connection.socket, `SERVER_ENABLE_OK|${id}`); LogEvent('SERVER_ENABLE', id);
        } else if (line.startsWith('SERVER_DRAIN_ON|')) {
            drainingServers.add(id); SaveDatabase(); SendLine(connection.socket, `SERVER_DRAIN_ON_OK|${id}`); LogEvent('SERVER_DRAIN_ON', id);
        } else {
            drainingServers.delete(id); SaveDatabase(); SendLine(connection.socket, `SERVER_DRAIN_OFF_OK|${id}`); LogEvent('SERVER_DRAIN_OFF', id);
        }
        return;
    }

    if (line.startsWith('CLIENT_KICK|')) {
        if (connection.adminRole !== 'admin') { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        const id = NormalizeID(line.split('|')[1] || ''); if (!ClientExists(id)) { SendLine(connection.socket, 'ADMIN_ERROR|CLIENT_NOT_FOUND'); return; }
        const until = Now() + CLIENT_KICK_BLOCK_MS; kickedClients.set(id, until); NotifyServerUnauthorized(id, 'ADMIN_KICK'); const live=GetOnlineClient(id);
        if(live){SendLine(live.socket,`ERROR|CLIENT_KICKED|${until}`);live.socket.destroy();}
        SendLine(connection.socket, `CLIENT_KICK_OK|${id}|${until}`); LogEvent('CLIENT_KICK', `${id} until ${until}`); return;
    }

    if (line.startsWith('CLIENT_DISABLE|') || line.startsWith('CLIENT_ENABLE|')) {
        if (connection.adminRole !== 'admin') { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        const id = NormalizeID(line.split('|')[1] || ''); if (!ClientExists(id)) { SendLine(connection.socket, 'ADMIN_ERROR|CLIENT_NOT_FOUND'); return; }
        if (line.startsWith('CLIENT_DISABLE|')) {
            disabledClients.add(id); kickedClients.delete(id); SaveDatabase(); NotifyServerUnauthorized(id,'CLIENT_DISABLED'); const live=GetOnlineClient(id); if(live){SendLine(live.socket,'ERROR|CLIENT_DISABLED');live.socket.destroy();}
            SendLine(connection.socket, `CLIENT_DISABLE_OK|${id}`); LogEvent('CLIENT_DISABLE', id);
        } else {
            disabledClients.delete(id); kickedClients.delete(id); SaveDatabase(); SendLine(connection.socket, `CLIENT_ENABLE_OK|${id}`); LogEvent('CLIENT_ENABLE', id);
        }
        return;
    }

    if (line.startsWith('CLIENT_MOVE|')) {
        if (connection.adminRole !== 'admin') { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        const p=line.split('|'); const r=ClientMove(p[1]||'',p[2]||''); SendLine(connection.socket, r.ok ? `CLIENT_MOVE_OK|${NormalizeID(p[1])}|${NormalizeID(p[2])}` : `CLIENT_MOVE_ERROR|${r.reason}`); return;
    }

    if (line === 'SERVICE_STOP') {
        if (connection.adminRole !== 'admin') { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        state.serviceEnabled=false; state.maintenanceMode=false; SaveDatabase();
        for(const c of clients.values()){c.licenseAuthorized=false;c.licenseExpiresAt=0;c.lastServerAuthState='';SendLine(c.socket,'SERVICE_STATE|DISABLED');NotifyServerUnauthorized(c.clientId,'SERVICE_DISABLED');}
        SendLine(connection.socket,'SERVICE_STOP_OK');LogEvent('SERVICE_STOP',SafeIP(connection.socket));return;
    }

    if (line === 'SERVICE_START') {
        if (connection.adminRole !== 'admin') { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        state.serviceEnabled=true; state.maintenanceMode=false; SaveDatabase(); for(const c of clients.values()) SendLine(c.socket,'SERVICE_STATE|ONLINE');
        SendLine(connection.socket,'SERVICE_START_OK');LogEvent('SERVICE_START',SafeIP(connection.socket));return;
    }

    if (line === 'MAINTENANCE_ON') {
        if (connection.adminRole !== 'admin') { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        if(!state.serviceEnabled){SendLine(connection.socket,'ADMIN_ERROR|SERVICE_DISABLED');return;}
        state.maintenanceMode=true; SaveDatabase();
        // Existing authorized sessions stay valid; only new CONNECT/LICENSE_AUTH are blocked.
        for(const c of clients.values()) if(!c.licenseAuthorized) SendLine(c.socket,'SERVICE_STATE|MAINTENANCE');
        SendLine(connection.socket,'MAINTENANCE_ON_OK');LogEvent('MAINTENANCE_ON',SafeIP(connection.socket));return;
    }

    if (line === 'MAINTENANCE_OFF') {
        if (connection.adminRole !== 'admin') { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        state.maintenanceMode=false; SaveDatabase(); for(const c of clients.values()) SendLine(c.socket,'SERVICE_STATE|ONLINE');
        SendLine(connection.socket,'MAINTENANCE_OFF_OK');LogEvent('MAINTENANCE_OFF',SafeIP(connection.socket));return;
    }

    if (line.startsWith('MAINT_SCHEDULE|')) {
        if (connection.adminRole !== 'admin') { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        const p=line.split('|'); const startAt=Number(p[1]),endAt=Number(p[2]); const message=SafeField(p.slice(3).join('|')||'Scheduled maintenance');
        if(!(startAt>Now()&&endAt>startAt)){SendLine(connection.socket,'MAINT_SCHEDULE_ERROR|INVALID_TIME');return;}
        state.maintenanceSchedule={startAt,endAt,message};SaveDatabase();SendLine(connection.socket,`MAINT_SCHEDULE_OK|${startAt}|${endAt}|${message}`);LogEvent('MAINT_SCHEDULE',`${startAt}-${endAt} ${message}`);return;
    }

    if (line === 'MAINT_SCHEDULE_CLEAR') {
        if (connection.adminRole !== 'admin') { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
        state.maintenanceSchedule=null;SaveDatabase();SendLine(connection.socket,'MAINT_SCHEDULE_CLEAR_OK');LogEvent('MAINT_SCHEDULE_CLEAR','');return;
    }

    if (line === 'MAINT_SCHEDULE_STATUS') {
        if (!AdminAllowed(connection.adminRole,'SCHEDULE_STATUS')) { SendLine(connection.socket,'ADMIN_ERROR|FORBIDDEN');return; }
        if(state.maintenanceSchedule)SendLine(connection.socket,`MAINT_SCHEDULE_STATUS|${state.maintenanceSchedule.startAt}|${state.maintenanceSchedule.endAt}|${state.maintenanceSchedule.message}`);else SendLine(connection.socket,'MAINT_SCHEDULE_STATUS|NONE');return;
    }

    if (line.startsWith('NOTICE_ALL|')) {
        if (!AdminAllowed(connection.adminRole,'NOTICE')) { SendLine(connection.socket,'ADMIN_ERROR|FORBIDDEN');return; }
        const count=NoticeAll(line.substring('NOTICE_ALL|'.length));SendLine(connection.socket,`NOTICE_ALL_OK|${count}`);return;
    }

    if (line.startsWith('NOTICE_CLIENT|')) {
        if (!AdminAllowed(connection.adminRole,'NOTICE')) { SendLine(connection.socket,'ADMIN_ERROR|FORBIDDEN');return; }
        const p=line.split('|'); const id=NormalizeID(p[1]||''); const ok=NoticeClient(id,p.slice(2).join('|'));SendLine(connection.socket,ok?`NOTICE_CLIENT_OK|${id}`:`NOTICE_CLIENT_ERROR|OFFLINE`);return;
    }

    SendLine(connection.socket, 'ADMIN_ERROR|UNKNOWN_COMMAND');
}

function HandleAdminLine(connection, line) {
    line = line.trim(); if (!line) return;
    if (line === 'ADMIN_HELLO' || line.startsWith('ADMIN_HELLO|')) { HandleAdminHello(connection, line); return; }
    if (line.startsWith('ADMIN_AUTH|')) { HandleAdminAuth(connection, line); return; }
    if (!connection.adminAuthenticated) { SendLine(connection.socket, 'ADMIN_ERROR|NOT_AUTHORIZED'); return; }
    if (Now() - connection.adminAuthenticatedAt > ADMIN_SESSION_TIMEOUT_MS) { connection.adminAuthenticated=false;connection.adminRole='';SendLine(connection.socket,'ADMIN_ERROR|SESSION_EXPIRED');return; }

    if (line.startsWith('CONFIRM_PREPARE|')) {
        let cmd=''; try{cmd=Buffer.from(line.substring('CONFIRM_PREPARE|'.length),'base64').toString('utf8');}catch(_){ }
        if(!cmd||!IsDangerousCommand(cmd)){SendLine(connection.socket,'CONFIRM_ERROR|INVALID_COMMAND');return;}
        PrepareConfirm(connection,cmd);return;
    }
    if (line.startsWith('CONFIRM_EXEC|')) { ExecuteConfirmed(connection,line.split('|')[1]||'');return; }
    ExecuteAdminCommand(connection,line,false);
}

module.exports = {
    ExecuteAdminCommand,
    HandleAdminLine
};
