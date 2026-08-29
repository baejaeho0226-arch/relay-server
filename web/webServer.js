'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const config = require('../config/config');
const { HealthSnapshot } = require('../services/dashboard');
const { LogEvent } = require('../storage/audit');
const {
    SessionCookie, SESSION_MS, Login, Authenticate, Logout, ValidateCsrf
} = require('./webAuth');
const { Json, ApiError, ReadJsonBody, HandleApiRequest } = require('./webApi');
const { OpenEventStream } = require('./webEvents');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
};

function SecurityHeaders(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}

function ServeFile(req, res, fileName) {
    const safeName = fileName === '/' ? 'index.html' : fileName.replace(/^\/+/, '');
    const full = path.resolve(PUBLIC_DIR, safeName);
    if (!full.startsWith(PUBLIC_DIR + path.sep) && full !== path.join(PUBLIC_DIR, 'index.html')) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
    }
    const ext = path.extname(full).toLowerCase();
    const stat = fs.statSync(full);
    res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store'
    });
    fs.createReadStream(full).pipe(res);
}

async function RequestHandler(req, res) {
    SecurityHeaders(req, res);
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const method = String(req.method || 'GET').toUpperCase();

    if ((pathname === '/health' || pathname === '/healthz') && method === 'GET') {
        const body = HealthSnapshot();
        Json(res, body.ok ? 200 : 503, body);
        return;
    }

    if (pathname === '/api/login' && method === 'POST') {
        let body;
        try { body = await ReadJsonBody(req); }
        catch (error) { ApiError(res, 400, error.message); return; }
        const result = Login(req, body.role, body.password);
        if (!result.ok) {
            ApiError(res, result.status || 401, result.code);
            return;
        }
        res.setHeader('Set-Cookie', SessionCookie(req, result.session.token, SESSION_MS / 1000));
        Json(res, 200, {
            ok: true,
            role: result.session.role,
            csrf: result.session.csrf,
            expiresAt: result.session.expiresAt
        });
        return;
    }

    if (pathname.startsWith('/api/')) {
        const session = Authenticate(req);
        if (!session) {
            ApiError(res, 401, 'NOT_AUTHORIZED');
            return;
        }

        if (pathname === '/api/session' && method === 'GET') {
            Json(res, 200, {
                ok: true,
                role: session.role,
                csrf: session.csrf,
                expiresAt: session.expiresAt
            });
            return;
        }

        if (pathname === '/api/events' && method === 'GET') {
            OpenEventStream(req, res, session);
            return;
        }

        if (!['GET', 'HEAD'].includes(method) && !ValidateCsrf(req, session)) {
            ApiError(res, 403, 'CSRF_FAILED');
            return;
        }

        if (pathname === '/api/logout' && method === 'POST') {
            const role = session.role;
            Logout(req);
            res.setHeader('Set-Cookie', SessionCookie(req, '', 0));
            LogEvent('WEB_ADMIN_LOGOUT', role);
            Json(res, 200, { ok: true });
            return;
        }

        await HandleApiRequest(req, res, session);
        return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Method not allowed');
        return;
    }

    if (pathname === '/') {
        ServeFile(req, res, '/index.html');
        return;
    }

    ServeFile(req, res, pathname);
}

function StartWebAdmin() {
    const port = Number(config.WEB_ADMIN_PORT || 0);
    if (!(port > 0)) return null;

    const server = http.createServer((req, res) => {
        Promise.resolve(RequestHandler(req, res)).catch(error => {
            console.error('[WEB ADMIN ERROR]', error && error.stack ? error.stack : error);
            if (!res.headersSent) ApiError(res, 500, 'INTERNAL_ERROR');
            else { try { res.end(); } catch (_) {} }
        });
    });

    server.on('error', error => console.error('WEB ADMIN SERVER ERROR:', error.message));
    server.listen(port, config.HOST, () => {
        console.log('Web Admin HTTP Port:', port);
        if (!config.ADMIN_CREDENTIALS.admin) console.log('Web Admin admin role disabled: ADMIN_SECRET is not configured.');
    });
    return server;
}

module.exports = {
    StartWebAdmin
};
