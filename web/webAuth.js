'use strict';

const crypto = require('crypto');
const config = require('../config/config');
const { ConstantTimeEqual, Now } = require('../core/utils');
const { ResolveAdminRole, AdminAllowed } = require('../admin/auth');
const { LogEvent } = require('../storage/audit');

const COOKIE_NAME = 'relay_admin_session';
const SESSION_MS = Math.max(5 * 60 * 1000, Number(config.WEB_ADMIN_SESSION_MS || 30 * 60 * 1000));
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_BLOCK_MS = 10 * 60 * 1000;

const sessions = new Map();
const loginAttempts = new Map();

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
    if (role === 'admin' && secret === 'ADMIN-SECRET-KEY-1234' && String(process.env.WEB_ADMIN_ALLOW_DEFAULT_SECRET || '') !== '1') return false;
    return true;
}

function CheckLoginRate(ip) {
    const now = Now();
    let item = loginAttempts.get(ip);
    if (!item) {
        item = { startedAt: now, count: 0, blockedUntil: 0 };
        loginAttempts.set(ip, item);
    }
    if (item.blockedUntil > now) return { ok: false, retryAt: item.blockedUntil };
    if (now - item.startedAt > LOGIN_WINDOW_MS) {
        item.startedAt = now;
        item.count = 0;
    }
    return { ok: true, item };
}

function RegisterLoginFailure(ip) {
    const now = Now();
    const checked = CheckLoginRate(ip);
    const item = checked.item || loginAttempts.get(ip) || { startedAt: now, count: 0, blockedUntil: 0 };
    item.count++;
    if (item.count >= LOGIN_MAX_ATTEMPTS) item.blockedUntil = now + LOGIN_BLOCK_MS;
    loginAttempts.set(ip, item);
    return item;
}

function ClearLoginFailures(ip) {
    loginAttempts.delete(ip);
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
    const rate = CheckLoginRate(ip);
    if (!rate.ok) return { ok: false, status: 429, code: 'LOGIN_RATE_LIMIT', retryAt: rate.retryAt };

    role = ResolveAdminRole(role);
    if (!role || !IsWebCredentialConfigured(role)) {
        RegisterLoginFailure(ip);
        return { ok: false, status: 403, code: 'ROLE_NOT_CONFIGURED' };
    }

    const expected = String(config.ADMIN_CREDENTIALS[role] || '');
    const supplied = String(password || '');
    if (!ConstantTimeEqual(expected, supplied)) {
        RegisterLoginFailure(ip);
        LogEvent('WEB_ADMIN_AUTH_FAILED', `${role} / ${ip}`);
        return { ok: false, status: 401, code: 'AUTH_FAILED' };
    }

    ClearLoginFailures(ip);
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
    for (const [ip, item] of loginAttempts) {
        if (item.blockedUntil <= now && now - item.startedAt > LOGIN_WINDOW_MS * 2) loginAttempts.delete(ip);
    }
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
