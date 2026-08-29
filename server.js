const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 33802);
const ADMIN_SECRET = 'ADMIN-SECRET-KEY-1234'; // AdminManager 접속 암호

const IDENTITY_FILE = path.join(__dirname, 'relay-identities.json');
const LICENSE_FILE = path.join(__dirname, 'relay-licenses.json');

const servers = new Map();
const clients = new Map();
const serverIdentities = new Map();
const clientIdentities = new Map();
const licenses = new Map();

function GenerateLicenseKey() {
    return 'KEY-' + crypto.randomBytes(4).toString('hex').toUpperCase() + '-' +
           crypto.randomBytes(4).toString('hex').toUpperCase();
}

function SendLine(socket, text) {
    if (!socket || socket.destroyed) return false;
    try {
        socket.write(text + '\n');
        return true;
    } catch (_) {
        return false;
    }
}

function LoadData() {
    try {
        if (fs.existsSync(IDENTITY_FILE)) {
            const data = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
            if (data.servers) Object.entries(data.servers).forEach(([k, v]) => serverIdentities.set(k, v));
            if (data.clients) Object.entries(data.clients).forEach(([k, v]) => clientIdentities.set(k, v));
        }
        if (fs.existsSync(LICENSE_FILE)) {
            const licData = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
            Object.entries(licData).forEach(([k, v]) => licenses.set(k, v));
        }
    } catch (e) {
        console.error('Data Load Error:', e.message);
    }
}

function SaveLicenses() {
    try {
        fs.writeFileSync(LICENSE_FILE, JSON.stringify(Object.fromEntries(licenses), null, 2), 'utf8');
    } catch (e) {
        console.error('License Save Error:', e.message);
    }
}

function VerifyLicense(licenseKey, clientKey) {
    if (!licenseKey) return { valid: false, code: 'LICENSE_REQUIRED' };
    const lic = licenses.get(licenseKey);
    if (!lic) return { valid: false, code: 'LICENSE_NOT_FOUND' };
    if (lic.status !== 'ACTIVE') return { valid: false, code: 'LICENSE_SUSPENDED' };
    
    if (lic.expiresAt && Date.now() > lic.expiresAt) {
        lic.status = 'EXPIRED';
        SaveLicenses();
        return { valid: false, code: 'LICENSE_EXPIRED' };
    }

    if (lic.boundClientKey && lic.boundClientKey !== clientKey) {
        return { valid: false, code: 'LICENSE_ALREADY_BOUND' };
    }

    if (!lic.boundClientKey) {
        lic.boundClientKey = clientKey;
        lic.activatedAt = Date.now();
        SaveLicenses();
    }

    return { valid: true, lic };
}

function HandleAdminLine(connection, line) {
    const parts = line.split('|');
    const cmd = parts[0];

    if (cmd === 'ADMIN_AUTH') {
        if (parts[1] === ADMIN_SECRET) {
            connection.isAdmin = true;
            SendLine(connection.socket, 'ADMIN_OK');
        } else {
            SendLine(connection.socket, 'ERROR|ADMIN_AUTH_FAILED');
        }
        return;
    }

    if (!connection.isAdmin) {
        SendLine(connection.socket, 'ERROR|NOT_AUTHORIZED');
        return;
    }

    if (cmd === 'LIC_CREATE') {
        const days = parseInt(parts[1] || '30', 10);
        const memo = parts[2] || '';
        const key = GenerateLicenseKey();
        const expiresAt = Date.now() + (days * 86400000);
        
        const licObj = {
            licenseKey: key,
            createdAt: Date.now(),
            expiresAt: expiresAt,
            days: days,
            status: 'ACTIVE',
            boundClientKey: null,
            memo: memo
        };
        licenses.set(key, licObj);
        SaveLicenses();
        SendLine(connection.socket, `LIC_CREATED|${key}|${expiresAt}`);
        return;
    }

    if (cmd === 'LIC_LIST') {
        SendLine(connection.socket, 'LIC_LIST_START');
        for (const [key, lic] of licenses.entries()) {
            SendLine(connection.socket, `LIC_ITEM|${lic.licenseKey}|${lic.status}|${lic.expiresAt}|${lic.boundClientKey || 'NONE'}|${lic.memo || ''}`);
        }
        SendLine(connection.socket, 'LIC_LIST_END');
        return;
    }

    if (cmd === 'LIC_EXTEND') {
        const key = parts[1];
        const days = parseInt(parts[2] || '30', 10);
        const lic = licenses.get(key);
        if (lic) {
            const base = (lic.expiresAt && lic.expiresAt > Date.now()) ? lic.expiresAt : Date.now();
            lic.expiresAt = base + (days * 86400000);
            lic.status = 'ACTIVE';
            SaveLicenses();
            SendLine(connection.socket, `LIC_EXTENDED|${key}|${lic.expiresAt}`);
        } else {
            SendLine(connection.socket, 'ERROR|LICENSE_NOT_FOUND');
        }
        return;
    }

    if (cmd === 'LIC_DELETE') {
        const key = parts[1];
        if (licenses.delete(key)) {
            SaveLicenses();
            SendLine(connection.socket, `LIC_DELETED|${key}`);
        } else {
            SendLine(connection.socket, 'ERROR|LICENSE_NOT_FOUND');
        }
        return;
    }
}

function HandleClientLine(connection, line) {
    line = line.trim();
    if (!line) return;

    if (line.startsWith('CONNECT|')) {
        const parts = line.split('|');
        const identityKey = parts[1] ? parts[1].trim() : '';
        const licenseKey = parts[2] ? parts[2].trim() : '';

        const check = VerifyLicense(licenseKey, identityKey);
        if (!check.valid) {
            SendLine(connection.socket, `ERROR|${check.code}`);
            return;
        }

        let saved = clientIdentities.get(identityKey);
        let server = null;

        if (saved) {
            server = servers.get(saved.serverId);
        } else {
            const serverList = [...servers.values()].filter(s => s.registered && s.socket && !s.socket.destroyed);
            if (serverList.length === 0) {
                SendLine(connection.socket, 'ERROR|NO_SERVER');
                return;
            }
            server = serverList[0];
            saved = { clientId: 'CLI-' + crypto.randomBytes(4).toString('hex').toUpperCase(), serverId: server.serverId };
            clientIdentities.set(identityKey, saved);
        }

        connection.clientId = saved.clientId;
        connection.serverId = saved.serverId;
        clients.set(saved.clientId, connection);

        SendLine(connection.socket, `CONNECTED|${saved.clientId}|${saved.serverId}`);
        return;
    }

    if (line.startsWith('SEND|')) {
        const parts = line.split('|');
        if (parts.length === 3) {
            const clientId = parts[1].trim();
            const number = parts[2].trim();
            const saved = [...clientIdentities.values()].find(v => v.clientId === clientId);
            
            if (saved && servers.has(saved.serverId)) {
                const s = servers.get(saved.serverId);
                SendLine(s.socket, `NUMBER|${clientId}|${number}`);
                SendLine(connection.socket, 'SENT|OK');
            }
        }
        return;
    }

    if (line === 'PONG') return;
}

function HandleServerLine(connection, line) {
    if (line.startsWith('REGISTER|')) {
        const key = line.split('|')[1];
        let id = serverIdentities.get(key) || ('SRV-' + crypto.randomBytes(4).toString('hex').toUpperCase());
        serverIdentities.set(key, id);
        connection.serverId = id;
        connection.registered = true;
        servers.set(id, connection);
        SendLine(connection.socket, `REGISTERED|${id}`);
    }
}

LoadData();

const server = net.createServer(socket => {
    const conn = { socket, type: null, isAdmin: false };
    socket.on('data', data => {
        const lines = data.toString('utf8').split('\n');
        for (let line of lines) {
            line = line.replace(/\r$/, '').trim();
            if (!line) continue;

            if (!conn.type) {
                if (line.startsWith('ADMIN_AUTH')) conn.type = 'admin';
                else if (line.startsWith('REGISTER')) conn.type = 'server';
                else if (line.startsWith('CONNECT')) conn.type = 'client';
            }

            if (conn.type === 'admin') HandleAdminLine(conn, line);
            else if (conn.type === 'server') HandleServerLine(conn, line);
            else if (conn.type === 'client') HandleClientLine(conn, line);
        }
    });
    socket.on('close', () => {
        if (conn.serverId) servers.delete(conn.serverId);
        if (conn.clientId) clients.delete(conn.clientId);
    });
    socket.on('error', () => {});
});

server.listen(PORT, HOST, () => console.log(`Relay Server Running on ${PORT}`));
