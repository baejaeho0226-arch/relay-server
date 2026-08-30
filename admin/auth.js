'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const state = require('../core/state');

const { HOST, PORT, HEALTH_PORT, DATA_DIR, DB_FILE, DB_BAK_FILE, BACKUP_DIR, AUDIT_DIR, CURRENT_PROTOCOL_VERSION, DEFAULT_MIN_PROTOCOL_VERSION, DEFAULT_MIN_SERVER_VERSION, DEFAULT_MIN_CLIENT_VERSION, ADMIN_CREDENTIALS, ADMIN_AUTH_WINDOW_SECONDS, ADMIN_SESSION_TIMEOUT_MS, CONFIRM_TOKEN_TTL_MS, SERVER_KICK_BLOCK_MS, CLIENT_KICK_BLOCK_MS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, MAX_CLIENTS_PER_SERVER, REQUEST_HISTORY_TIMEOUT_MS, ACK_RETRY_MS, ACK_TIMEOUT_MS, ACK_MAX_RETRIES, MAX_INPUT_BUFFER, MAX_BULK_KEYS, MAX_SEARCH_RESULTS, MAX_EVENT_MEMORY, AUTO_BACKUP_INTERVAL_MS, MAX_BACKUPS, DANGEROUS_PREFIXES } = config;
const { servers, clients, serverIdentities, clientIdentities, licenses, disabledServers, drainingServers, disabledClients, kickedServers, kickedClients, requestHistory, pendingRequests, rateLimits, events, confirmTokens, ipHistory, runtimeStats } = state;

function ConstantTimeEqual(...args) { return require('../core/utils').ConstantTimeEqual(...args); }
function ExecuteAdminCommand(...args) { return require('./adminHandler').ExecuteAdminCommand(...args); }
function LogEvent(...args) { return require('../storage/audit').LogEvent(...args); }
function Now(...args) { return require('../core/utils').Now(...args); }
function RandomNonce(...args) { return require('../core/utils').RandomNonce(...args); }
function RandomToken(...args) { return require('../core/utils').RandomToken(...args); }
function SafeIP(...args) { return require('../core/utils').SafeIP(...args); }
function SendLine(...args) { return require('../core/utils').SendLine(...args); }

function ResolveAdminRole(role) {
    const r = String(role || '').trim().toLowerCase();
    return ['admin', 'operator', 'viewer'].includes(r) ? r : '';
}

function RoleConfigured(role) {
    return !!ADMIN_CREDENTIALS[role];
}

function AdminAllowed(role, operation) {
    if (role === 'admin') return true;
    const viewer = new Set(['WHOAMI','LIST','SEARCH','VIEW','DASHBOARD','SERVER_LIST','CLIENT_LIST','CLIENT_DETAIL','SERVER_TREE','AUDIT','VERSION_STATUS','SCHEDULE_STATUS']);
    const operator = new Set([...viewer, 'EXTEND','UNBIND','SUSPEND','RESUME','TRANSFER','NOTICE','NOTE']);
    return role === 'viewer' ? viewer.has(operation) : role === 'operator' ? operator.has(operation) : false;
}

function MakeRoleHmac(role, nonce, timestamp) {
    return crypto.createHmac('sha256', ADMIN_CREDENTIALS[role]).update(`${role}|${nonce}|${timestamp}`, 'utf8').digest('hex').toUpperCase();
}

function HandleAdminHello(connection, line) {
    const parts = line.split('|');
    const role = ResolveAdminRole(parts[1] || 'admin');
    if (!role || !RoleConfigured(role)) { SendLine(connection.socket, 'ADMIN_ERROR|ROLE_NOT_CONFIGURED'); return; }
    connection.pendingAdminRole = role;
    connection.adminNonce = RandomNonce();
    connection.adminNonceCreatedAt = Now();
    connection.adminAuthenticated = false;
    SendLine(connection.socket, `CHALLENGE|${connection.adminNonce}|${role}`);
}

function HandleAdminAuth(connection, line) {
    const parts = line.split('|');
    if (parts.length < 4) { SendLine(connection.socket, 'ADMIN_ERROR|AUTH_FORMAT'); return; }
    const role = connection.pendingAdminRole;
    const nonce = parts[1];
    const timestampText = parts[2];
    const supplied = String(parts[3] || '').trim().toUpperCase();
    const timestamp = Number(timestampText);
    if (!role || nonce !== connection.adminNonce || !Number.isFinite(timestamp)) { SendLine(connection.socket, 'ADMIN_ERROR|AUTH_FAILED'); return; }
    if (Now() - connection.adminNonceCreatedAt > 60000 || Math.abs(Math.floor(Now()/1000) - timestamp) > ADMIN_AUTH_WINDOW_SECONDS) {
        SendLine(connection.socket, 'ADMIN_ERROR|AUTH_EXPIRED'); return;
    }
    const expected = MakeRoleHmac(role, nonce, timestampText);
    if (!ConstantTimeEqual(expected, supplied)) { SendLine(connection.socket, 'ADMIN_ERROR|AUTH_FAILED'); LogEvent('ADMIN_AUTH_FAILED', `${role} ${SafeIP(connection.socket)}`); return; }
    connection.adminAuthenticated = true;
    connection.adminAuthenticatedAt = Now();
    connection.adminRole = role;
    connection.adminNonce = '';
    connection.pendingAdminRole = '';
    SendLine(connection.socket, `ADMIN_OK|${role}`);
    LogEvent('ADMIN_AUTH', `${role} / ${SafeIP(connection.socket)}`);
}

function IsDangerousCommand(line) {
    return DANGEROUS_PREFIXES.some(prefix => line === prefix || line.startsWith(prefix));
}

function PrepareConfirm(connection, command) {
    if (connection.adminRole !== 'admin') { SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN'); return; }
    const token = RandomToken();
    confirmTokens.set(token, { command, expiresAt: Now() + CONFIRM_TOKEN_TTL_MS, role: connection.adminRole });
    SendLine(connection.socket, `CONFIRM_TOKEN|${token}|${Now() + CONFIRM_TOKEN_TTL_MS}`);
}

function ExecuteConfirmed(connection, token) {
    const item = confirmTokens.get(token);
    confirmTokens.delete(token);
    if (!item || item.expiresAt < Now() || item.role !== connection.adminRole) { SendLine(connection.socket, 'CONFIRM_ERROR|INVALID_OR_EXPIRED'); return; }
    ExecuteAdminCommand(connection, item.command, true);
}

module.exports = {
    ResolveAdminRole,
    RoleConfigured,
    AdminAllowed,
    MakeRoleHmac,
    HandleAdminHello,
    HandleAdminAuth,
    IsDangerousCommand,
    PrepareConfirm,
    ExecuteConfirmed
};
