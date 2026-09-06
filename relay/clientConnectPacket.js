"use strict";
// Shared registration parsing keeps stopped and online connections on the same
// installation-token validation path, before either can enter device state.
function Parse(line) {
    const parts = String(line).trim().split('|');
    const installation = parts[0] === 'CONNECT_INSTALLATION';
    if (installation ? parts.length !== 5 || !parts[4] : parts.length > 4)
        return { ok: false, reason: 'INVALID_CONNECT' };
    const modern = parts.length >= 4;
    const deviceKey = String(parts[modern ? 3 : 1] || '').trim();
    if (!deviceKey) return { ok: false, reason: 'DEVICE_KEY_REQUIRED' };
    return { ok: true, deviceKey, protocolVersion: modern ? Number(parts[1]) : 1,
        appVersion: modern ? String(parts[2] || '').trim() : '1.0.0',
        installationToken: modern ? parts[4] || '' : '' };
}
module.exports = { Parse };
