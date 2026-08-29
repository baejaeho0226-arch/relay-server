'use strict';

const crypto = require('crypto');

const config = require('../config/config');
const state = require('../core/state');

const {
    ADMIN_CREDENTIALS,
    ADMIN_AUTH_WINDOW_SECONDS,
    CONFIRM_TOKEN_TTL_MS,
    DANGEROUS_PREFIXES
} = config;

const {
    Now,
    RandomNonce,
    RandomToken,
    SafeIP,
    SendLine,
    ConstantTimeEqual
} = require('../core/utils');

const {
    LogEvent
} = require('../storage/audit');


function ResolveAdminRole(role) {
    const value = String(role || '').trim().toLowerCase();

    return ['admin', 'operator', 'viewer'].includes(value)
        ? value
        : '';
}


function RoleConfigured(role) {
    return !!ADMIN_CREDENTIALS[role];
}


function AdminAllowed(role, operation) {
    if (role === 'admin') {
        return true;
    }

    const viewer = new Set([
        'WHOAMI',
        'LIST',
        'SEARCH',
        'VIEW',
        'DASHBOARD',
        'SERVER_LIST',
        'CLIENT_LIST',
        'CLIENT_DETAIL',
        'SERVER_TREE',
        'AUDIT',
        'VERSION_STATUS',
        'SCHEDULE_STATUS'
    ]);

    const operator = new Set([
        ...viewer,
        'EXTEND',
        'UNBIND',
        'SUSPEND',
        'RESUME',
        'TRANSFER',
        'NOTICE'
    ]);

    if (role === 'viewer') {
        return viewer.has(operation);
    }

    if (role === 'operator') {
        return operator.has(operation);
    }

    return false;
}


function MakeRoleHmac(role, nonce, timestamp) {
    const secret = ADMIN_CREDENTIALS[role] || '';

    return crypto
        .createHmac('sha256', secret)
        .update(`${role}|${nonce}|${timestamp}`, 'utf8')
        .digest('hex')
        .toUpperCase();
}


function HandleAdminHello(connection, line) {
    const parts = String(line || '').split('|');

    const role = ResolveAdminRole(
        parts[1] || 'admin'
    );

    if (!role || !RoleConfigured(role)) {
        SendLine(
            connection.socket,
            'ADMIN_ERROR|ROLE_NOT_CONFIGURED'
        );

        return false;
    }

    connection.pendingAdminRole = role;
    connection.adminNonce = RandomNonce();
    connection.adminNonceCreatedAt = Now();
    connection.adminAuthenticated = false;
    connection.adminAuthenticatedAt = 0;
    connection.adminRole = '';

    SendLine(
        connection.socket,
        `CHALLENGE|${connection.adminNonce}|${role}`
    );

    return true;
}


function HandleAdminAuth(connection, line) {
    const parts = String(line || '').split('|');

    if (parts.length < 4) {
        SendLine(
            connection.socket,
            'ADMIN_ERROR|AUTH_FORMAT'
        );

        return false;
    }

    const role = connection.pendingAdminRole;
    const nonce = String(parts[1] || '');
    const timestampText = String(parts[2] || '');
    const supplied = String(parts[3] || '')
        .trim()
        .toUpperCase();

    const timestamp = Number(timestampText);

    if (
        !role ||
        nonce !== connection.adminNonce ||
        !Number.isFinite(timestamp)
    ) {
        SendLine(
            connection.socket,
            'ADMIN_ERROR|AUTH_FAILED'
        );

        return false;
    }

    if (
        Now() - connection.adminNonceCreatedAt > 60000 ||
        Math.abs(
            Math.floor(Now() / 1000) - timestamp
        ) > ADMIN_AUTH_WINDOW_SECONDS
    ) {
        SendLine(
            connection.socket,
            'ADMIN_ERROR|AUTH_EXPIRED'
        );

        return false;
    }

    const expected = MakeRoleHmac(
        role,
        nonce,
        timestampText
    );

    if (!ConstantTimeEqual(expected, supplied)) {
        SendLine(
            connection.socket,
            'ADMIN_ERROR|AUTH_FAILED'
        );

        LogEvent(
            'ADMIN_AUTH_FAILED',
            `${role} ${SafeIP(connection.socket)}`
        );

        return false;
    }

    connection.adminAuthenticated = true;
    connection.adminAuthenticatedAt = Now();
    connection.adminRole = role;

    connection.adminNonce = '';
    connection.adminNonceCreatedAt = 0;
    connection.pendingAdminRole = '';

    SendLine(
        connection.socket,
        `ADMIN_OK|${role}`
    );

    LogEvent(
        'ADMIN_AUTH',
        `${role} / ${SafeIP(connection.socket)}`
    );

    return true;
}


function IsDangerousCommand(line) {
    line = String(line || '');

    return DANGEROUS_PREFIXES.some(
        prefix =>
            line === prefix ||
            line.startsWith(prefix)
    );
}


function PrepareConfirm(connection, command) {
    if (connection.adminRole !== 'admin') {
        SendLine(
            connection.socket,
            'ADMIN_ERROR|FORBIDDEN'
        );

        return '';
    }

    if (!IsDangerousCommand(command)) {
        SendLine(
            connection.socket,
            'CONFIRM_ERROR|INVALID_COMMAND'
        );

        return '';
    }

    const token = RandomToken();

    const expiresAt =
        Now() +
        CONFIRM_TOKEN_TTL_MS;

    state.confirmTokens.set(
        token,
        {
            command,
            expiresAt,
            role: connection.adminRole
        }
    );

    SendLine(
        connection.socket,
        `CONFIRM_TOKEN|${token}|${expiresAt}`
    );

    return token;
}


function ConsumeConfirm(connection, token) {
    token = String(token || '').trim();

    const item =
        state.confirmTokens.get(token);

    state.confirmTokens.delete(token);

    if (
        !item ||
        item.expiresAt < Now() ||
        item.role !== connection.adminRole
    ) {
        SendLine(
            connection.socket,
            'CONFIRM_ERROR|INVALID_OR_EXPIRED'
        );

        return null;
    }

    return item.command;
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
    ConsumeConfirm
};
