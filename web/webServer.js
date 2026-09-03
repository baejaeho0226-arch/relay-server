'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('../config/config');
const { HealthSnapshot } = require('../services/dashboard');
const { LogEvent } = require('../storage/audit');
const {
    SessionCookie, SESSION_MS, Login, Authenticate, Logout, ValidateCsrf
} = require('./webAuth');
const { Json, ApiError, ReadJsonBody, HandleApiRequest } = require('./webApi');
const { OpenEventStream } = require('./webEvents');
const { RecordAdminActivity } = require('../services/adminActivity');
const releaseManager = require('../services/releaseManager');

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
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}


function ReadReleaseUpload(req, meta) {
    return new Promise((resolve, reject) => {
        releaseManager.SigningSecret();
        const crypto = require('crypto');
        const os = require('os');
        const tmpDir = require('path').join(config.DATA_DIR, 'releases', '.tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        const tmp = require('path').join(tmpDir, `upload-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.tmp`);
        const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
        const hash = crypto.createHash('sha256');
        let size = 0;
        let failed = false;
        const fail = error => {
            if (failed) return;
            failed = true;
            try { out.destroy(); } catch (_) {}
            try { fs.unlinkSync(tmp); } catch (_) {}
            reject(error);
        };
        req.on('data', chunk => {
            if (failed) return;
            size += chunk.length;
            if (size > releaseManager.MAX_RELEASE_BYTES) {
                fail(new Error('RELEASE_TOO_LARGE'));
                try { req.destroy(); } catch (_) {}
                return;
            }
            hash.update(chunk);
            if (!out.write(chunk)) req.pause(), out.once('drain', () => req.resume());
        });
        req.on('end', () => {
            if (failed) return;
            out.end(() => resolve({ tmp, size, sha256: hash.digest('hex'), meta }));
        });
        req.on('error', fail);
        out.on('error', fail);
    });
}

function ServeUpdateArtifact(req, res, pathname, url) {
    const match = pathname.match(/^\/updates\/([A-Za-z0-9]+)$/);
    if (!match) return false;
    const artifactId = match[1];
    if (!releaseManager.VerifyDownload(artifactId, url.searchParams.get('exp'), url.searchParams.get('sig'))) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Forbidden');
        return true;
    }
    const release = releaseManager.FindArtifact(artifactId);
    const file = releaseManager.ArtifactPath(release);
    if (!release || !file || !fs.existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Not found');
        return true;
    }
    const stat = fs.statSync(file);
    res.writeHead(200, {
        'Content-Type': release.type === 'CLIENT' && file.toLowerCase().endsWith('.apk') ? 'application/vnd.android.package-archive' : 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${release.originalName || release.fileName}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-SHA256': release.sha256
    });
    if (String(req.method || 'GET').toUpperCase() === 'HEAD') { res.end(); return true; }
    fs.createReadStream(file).pipe(res);
    return true;
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
    const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': ['.html', '.js', '.css'].includes(ext)
            ? 'no-cache, no-store, must-revalidate'
            : 'public, max-age=3600'
    };
    if (safeName === 'service-worker.js') headers['Service-Worker-Allowed'] = '/';
    res.writeHead(200, headers);
    if (String(req.method || 'GET').toUpperCase() === 'HEAD') { res.end(); return; }
    fs.createReadStream(full).pipe(res);
}

async function RequestHandler(req, res) {
    SecurityHeaders(req, res);
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const method = String(req.method || 'GET').toUpperCase();

    if (pathname.startsWith('/internal/ha/')) {
        if (await require('../services/haCoordinator').HandleInternal(req, res, pathname)) return;
    }

    if ((pathname === '/health' || pathname === '/healthz') && method === 'GET') {
        const body = HealthSnapshot();
        Json(res, body.ok ? 200 : 503, body);
        return;
    }

    if ((method === 'GET' || method === 'HEAD') && pathname.startsWith('/updates/')) {
        if (ServeUpdateArtifact(req, res, pathname, url)) return;
    }

    if (pathname === '/api/login' && method === 'POST') {
        let body;
        try { body = await ReadJsonBody(req); }
        catch (error) { ApiError(res, 400, error.message); return; }
        const result = Login(req, body.role, body.password);
        if (!result.ok) {
            RecordAdminActivity(String(body.role || '').toLowerCase(), require('./webAuth').ClientIP(req), 'POST', '/api/login', result.status || 401, 'LOGIN_FAILED');
            ApiError(res, result.status || 401, result.code);
            return;
        }
        RecordAdminActivity(result.session.role, result.session.ip, 'POST', '/api/login', 200, 'LOGIN');
        res.setHeader('Set-Cookie', SessionCookie(req, result.session.token, SESSION_MS / 1000));
        Json(res, 200, {
            ok: true,
            role: result.session.role,
            csrf: result.session.csrf,
            expiresAt: result.session.expiresAt
        });
        return;
    }

    if (pathname === '/api/passkey/login/begin' && method === 'POST') {
        let body; try { body = await ReadJsonBody(req); } catch (error) { ApiError(res, 400, error.message); return; }
        const result = require('../services/passkeyAuth').LoginBegin(body.role, req);
        if (!result.ok) ApiError(res, 400, result.reason); else Json(res, 200, result);
        return;
    }

    if (pathname === '/api/passkey/login/finish' && method === 'POST') {
        let body; try { body = await ReadJsonBody(req); } catch (error) { ApiError(res, 400, error.message); return; }
        const result = require('../services/passkeyAuth').LoginFinish(req, body);
        if (!result.ok) { ApiError(res, 401, result.reason); return; }
        const session = require('./webAuth').CreateSession(req, result.role);
        res.setHeader('Set-Cookie', SessionCookie(req, session.token, SESSION_MS / 1000));
        Json(res, 200, { ok:true, role:session.role, csrf:session.csrf, expiresAt:session.expiresAt });
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

        if (pathname === '/api/releases/upload' && method === 'POST') {
            if (!ValidateCsrf(req, session)) { ApiError(res, 403, 'CSRF_FAILED'); return; }
            if (session.role !== 'admin') { ApiError(res, 403, 'FORBIDDEN'); return; }
            if (!require('../services/haCoordinator').CanAcceptTraffic()) { ApiError(res, 409, 'RELAY_STANDBY_READ_ONLY'); return; }
            const meta = {
                type: url.searchParams.get('type'), channel: url.searchParams.get('channel'), version: url.searchParams.get('version'),
                fileName: url.searchParams.get('fileName'), mandatory: url.searchParams.get('mandatory') === '1',
                rolloutPercent: Number(url.searchParams.get('rolloutPercent') || 100), notes: url.searchParams.get('notes') || ''
            };
            try {
                const upload = await ReadReleaseUpload(req, meta);
                const release = releaseManager.PublishFromTemp(meta, upload.tmp, upload.sha256, upload.size);
                require('../storage/database').SaveDatabase();
                LogEvent('RELEASE_PUBLISHED', `${release.type}/${release.channel} ${release.version} ${release.sha256}`);
                RecordAdminActivity(session.role, session.ip, method, pathname, 200, 'RELEASE_UPLOAD');
                Json(res, 200, { ok: true, release });
            } catch (error) {
                ApiError(res, error.message === 'RELEASE_TOO_LARGE' ? 413 : 400, error.message || 'RELEASE_UPLOAD_FAILED');
            }
            return;
        }

        if (!['GET', 'HEAD'].includes(method) && !ValidateCsrf(req, session)) {
            RecordAdminActivity(session.role, session.ip, method, pathname, 403, 'CSRF_FAILED');
            ApiError(res, 403, 'CSRF_FAILED');
            return;
        }

        if (!['GET', 'HEAD'].includes(method)) {
            res.once('finish', () => {
                RecordAdminActivity(session.role, session.ip, method, pathname, res.statusCode, pathname === '/api/logout' ? 'LOGOUT' : 'MUTATION');
            });
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
            const reference = crypto.randomBytes(6).toString('hex').toUpperCase();
            console.error(
                `[WEB ADMIN ERROR ${reference}] ${String(req.method || 'GET').toUpperCase()} ${req.url}`,
                error && error.stack ? error.stack : error
            );
            if (!res.headersSent) ApiError(res, 500, 'INTERNAL_ERROR', `REF:${reference}`);
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
