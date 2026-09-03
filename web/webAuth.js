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

function GetWebSecret(role) {
    if (role === 'admin') return String(process.env.ADMIN_SECRET || '').trim();
    if (role === 'operator') return String(process.env.OPERATOR_SECRET || '').trim();
    if (role === 'viewer') return String(process.env.VIEWER_SECRET || '').trim();
    return '';
}

function IsWebCredentialConfigured(role) {
    return GetWebSecret(role).length > 0;
}

function CreateSession(req, role) {
    const token = RandomToken(32);
    const csrf = RandomToken(24);
    const now = Now();
    const session = {
        id: RandomToken(8).toUpperCase(),
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

    const expected = GetWebSecret(role);
    const supplied = String(password || '').trim();
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
    const session = token ? sessions.get(token) : null;
    if (session) session.expiresAt = 0;
    if (token) sessions.delete(token);
}

function ListSessions(currentSession) {
    const now = Now();
    const out = [];
    for (const session of sessions.values()) {
        if (!session || session.expiresAt <= now) continue;
        out.push({
            id: session.id,
            role: session.role,
            ip: session.ip,
            createdAt: session.createdAt,
            lastSeenAt: session.lastSeenAt,
            expiresAt: session.expiresAt,
            current: !!currentSession && session.id === currentSession.id
        });
    }
    return out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

function SessionSummary() {
    const rows = ListSessions(null);
    const roles = { admin: 0, operator: 0, viewer: 0 };
    for (const item of rows) if (Object.prototype.hasOwnProperty.call(roles, item.role)) roles[item.role]++;
    return { total: rows.length, roles };
}

function RevokeSession(sessionId) {
    sessionId = String(sessionId || '').trim().toUpperCase();
    for (const [token, session] of sessions) {
        if (String(session.id || '').toUpperCase() !== sessionId) continue;
        session.expiresAt = 0;
        sessions.delete(token);
        return true;
    }
    return false;
}

function RevokeOtherSessions(currentSession) {
    let count = 0;
    for (const [token, session] of Array.from(sessions)) {
        if (currentSession && session.id === currentSession.id) continue;
        session.expiresAt = 0;
        sessions.delete(token);
        count++;
    }
    return count;
}

function RevokeAllSessions() {
    let count = 0;
    for (const [token, session] of Array.from(sessions)) {
        session.expiresAt = 0;
        sessions.delete(token);
        count++;
    }
    return count;
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
    CreateSession,
    Authenticate,
    Logout,
    ValidateCsrf,
    Can,
    IsAdmin,
    ListSessions,
    SessionSummary,
    RevokeSession,
    RevokeOtherSessions,
    RevokeAllSessions
};
