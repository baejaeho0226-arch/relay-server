'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const state = require('../core/state');
const { SafeField, Now } = require('../core/utils');

function ReadConfiguredTls() {
    const certFile = String(process.env.RELAY_TLS_CERT_FILE || '').trim();
    const keyFile = String(process.env.RELAY_TLS_KEY_FILE || '').trim();
    if (!certFile || !keyFile) return { configured: false, reason: 'CERTIFICATE_NOT_CONFIGURED' };
    try {
        const cert = fs.readFileSync(certFile);
        const key = fs.readFileSync(keyFile);
        const caFile = String(process.env.RELAY_TLS_CA_FILE || '').trim();
        const ca = caFile ? fs.readFileSync(caFile) : undefined;
        const x509 = new crypto.X509Certificate(cert);
        return {
            configured: true, cert, key, ca,
            pinSha256: crypto.createHash('sha256').update(x509.publicKey.export({ type: 'spki', format: 'der' })).digest('base64'),
            subject: x509.subject, issuer: x509.issuer,
            validFrom: Date.parse(x509.validFrom) || 0, validTo: Date.parse(x509.validTo) || 0
        };
    } catch (error) {
        return { configured: false, reason: 'CERTIFICATE_LOAD_FAILED', detail: SafeField(error.message) };
    }
}

function Status() {
    const material = ReadConfiguredTls();
    const requiredByEnvironment = String(process.env.RELAY_TLS_REQUIRED || '') === '1';
    const active = material.configured && (requiredByEnvironment || state.production.transportPolicy.requireTls);
    return {
        actualMode: active ? 'TLS_1_3' : 'HMAC_ONLY',
        tlsConfigured: !!material.configured,
        tlsRequired: active,
        pinSha256: material.configured ? material.pinSha256 : '',
        certificate: material.configured ? { subject: material.subject, issuer: material.issuer, validFrom: material.validFrom, validTo: material.validTo } : null,
        reason: material.configured ? '' : material.reason,
        policy: { ...state.production.transportPolicy }
    };
}

function CreateRelayServer(connectionHandler) {
    const material = ReadConfiguredTls();
    const requireTls = String(process.env.RELAY_TLS_REQUIRED || '') === '1' || state.production.transportPolicy.requireTls;
    if (!requireTls) return net.createServer(connectionHandler);
    if (!material.configured) throw new Error('RELAY_TLS_REQUIRED_BUT_CERTIFICATE_NOT_CONFIGURED');
    state.production.transportPolicy.mode = 'TLS_1_3';
    state.production.transportPolicy.pinSha256 = material.pinSha256;
    return tls.createServer({
        cert: material.cert, key: material.key, ca: material.ca,
        minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3',
        requestCert: false, rejectUnauthorized: false
    }, connectionHandler);
}

function SetPolicy(input, actor) {
    const requireTls = !!(input && input.requireTls);
    const material = ReadConfiguredTls();
    if (requireTls && !material.configured) return { ok: false, reason: 'TLS_CERTIFICATE_REQUIRED' };
    state.production.transportPolicy = {
        ...state.production.transportPolicy,
        mode: requireTls ? 'TLS_1_3' : 'HMAC',
        requireTls,
        pinSha256: requireTls ? material.pinSha256 : '',
        rotationGraceUntil: Math.max(0, Number(input && input.rotationGraceUntil) || 0),
        updatedAt: Now(), updatedBy: SafeField(actor || 'ADMIN').slice(0, 64)
    };
    require('../storage/database').SaveDatabase();
    require('../storage/audit').LogEvent('TRANSPORT_POLICY_CHANGED', `TLS=${requireTls} / ${state.production.transportPolicy.updatedBy}`);
    return { ok: true, restartRequired: true, transport: Status() };
}

module.exports = { ReadConfiguredTls, Status, CreateRelayServer, SetPolicy };
