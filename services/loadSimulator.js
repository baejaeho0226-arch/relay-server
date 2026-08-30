'use strict';

const config = require('../config/config');

const PRESETS = Object.freeze({
    smoke: { servers: 2, clients: 10, requestsPerClient: 1, mode: 'connect' },
    medium: { servers: 10, clients: 100, requestsPerClient: 1, mode: 'connect' },
    heavy: { servers: 100, clients: 1000, requestsPerClient: 1, mode: 'connect' }
});

function ClampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}

function NormalizeOptions(input = {}) {
    return {
        relayHost: String(input.relayHost || '127.0.0.1').trim() || '127.0.0.1',
        relayPort: ClampInt(input.relayPort, 1, 65535, config.PORT),
        webUrl: String(input.webUrl || `http://127.0.0.1:${config.WEB_ADMIN_PORT}`).trim(),
        servers: ClampInt(input.servers, 1, 500, 10),
        clients: ClampInt(input.clients, 1, 5000, 100),
        requestsPerClient: ClampInt(input.requestsPerClient, 0, 100, 1),
        mode: String(input.mode || 'connect').toLowerCase() === 'full' ? 'full' : 'connect'
    };
}

function ShellQuote(value) {
    const text = String(value || '');
    if (/^[A-Za-z0-9._:\/-]+$/.test(text)) return text;
    return `'${text.replace(/'/g, `'\\''`)}'`;
}

function BuildCommand(input = {}) {
    const o = NormalizeOptions(input);
    return [
        'node tools/load-simulator.js',
        `--relay-host ${ShellQuote(o.relayHost)}`,
        `--relay-port ${o.relayPort}`,
        `--web-url ${ShellQuote(o.webUrl)}`,
        `--servers ${o.servers}`,
        `--clients ${o.clients}`,
        `--requests ${o.requestsPerClient}`,
        `--mode ${o.mode}`
    ].join(' ');
}

function Overview() {
    return {
        presets: PRESETS,
        limits: { servers: 500, clients: 5000, requestsPerClient: 100 },
        recommendation: 'DEDICATED_STAGING_ONLY',
        note: 'Run the simulator from a separate machine/process. The production Relay never spawns simulator connections itself.',
        example: BuildCommand(PRESETS.medium)
    };
}

module.exports = { PRESETS, NormalizeOptions, BuildCommand, Overview };
