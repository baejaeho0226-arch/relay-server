'use strict';

const crypto = require('crypto');
const config = require('../config/config');
const { ConstantTimeEqual, Now } = require('../core/utils');
const { ResolveAdminRole, AdminAllowed } = require('../admin/auth');
const { LogEvent } = require('../storage/audit');

const COOKIE_NAME = 'relay_admin_session';
const SESSION_MS = Math.max(5 * 60 * 1000, Number(config.WEB_ADMIN_SESSION_MS || 30 * 60 * 1000));
const sessions = new Map();

function RandomToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('hex');
}

function ClientIP(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return forwarded || String(req.socket && req.socket.remoteAddress || '');
}

function ParseCookies(req) {
    const out = {};
    const raw = String(req.headers.cookie || '');
    for (const part of raw.split(';')) {
        const p = part.indexOf('=');
        if (p <= 0) continue;
        const key = part.substring(0, p).trim();
        const value = part.substring(p + 1).trim();
        try { out[key] = decodeURIComponent(value); } catch (_) { out[key] = value; }
    }
    return out;
}

function IsHttps(req) {
    if (req.socket && req.socket.encrypted) return true;
    return String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
}

function SessionCookie(req, token, maxAgeSeconds) {
    const parts = [
        `${COOKIE_NAME}=${encodeURIComponent(token)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`
    ];
    if (IsHttps(req) || String(process.env.WEB_ADMIN_SECURE_COOKIE || '') === '1') parts.push('Secure');
    return parts.join('; ');
}

function IsWebCredentialConfigured(role) {
    const secret = String(config.ADMIN_CREDENTIALS[role] || '');
    if (!secret) return false;
    return true;
}

function CreateSession(req, role) {
    const token = RandomToken(32);
    const csrf = RandomToken(24);
    const now = Now();
    const session = {
        token,
        csrf,
        role,
        ip: ClientIP(req),
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + SESSION_MS
    };
    sessions.set(token, session);
    return session;
}

function Login(req, role, password) {
    const ip = ClientIP(req);
    role = ResolveAdminRole(role);

    if (!role || !IsWebCredentialConfigured(role)) {
        return { ok: false, status: 403, code: 'ROLE_NOT_CONFIGURED' };
    }

    const expected = String(config.ADMIN_CREDENTIALS[role] || '');
    const supplied = String(password || '');
    if (!ConstantTimeEqual(expected, supplied)) {
        LogEvent('WEB_ADMIN_AUTH_FAILED', `${role} / ${ip}`);
        return { ok: false, status: 401, code: 'AUTH_FAILED' };
    }

    const session = CreateSession(req, role);
    LogEvent('WEB_ADMIN_AUTH', `${role} / ${ip}`);
    return { ok: true, session };
}

function Authenticate(req, refresh = true) {
    const cookies = ParseCookies(req);
    const token = cookies[COOKIE_NAME] || '';
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    const now = Now();
    if (session.expiresAt <= now) {
        sessions.delete(token);
        return null;
    }
    if (refresh) {
        session.lastSeenAt = now;
        session.expiresAt = now + SESSION_MS;
    }
    return session;
}

function Logout(req) {
    const cookies = ParseCookies(req);
    const token = cookies[COOKIE_NAME] || '';
    if (token) sessions.delete(token);
}

function ValidateCsrf(req, session) {
    if (!session) return false;
    const supplied = String(req.headers['x-csrf-token'] || '');
    return ConstantTimeEqual(session.csrf, supplied);
}

function Can(session, operation) {
    return !!session && AdminAllowed(session.role, operation);
}

function IsAdmin(session) {
    return !!session && session.role === 'admin';
}

function CleanupSessions() {
    const now = Now();
    for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token);
}

setInterval(CleanupSessions, 60 * 1000).unref();

module.exports = {
    COOKIE_NAME,
    SESSION_MS,
    ClientIP,
    SessionCookie,
    Login,
    Authenticate,
    Logout,
    ValidateCsrf,
    Can,
    IsAdmin
};
