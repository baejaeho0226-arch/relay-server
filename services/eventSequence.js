'use strict';

const state = require('../core/state');

function Identity(connection) {
    if (!connection) return { type: '', id: '' };
    if (connection.type === 'server' && connection.serverId) return { type: 'SERVER', id: connection.serverId };
    if (connection.type === 'client' && connection.clientId) return { type: 'CLIENT', id: connection.clientId };
    return { type: '', id: '' };
}

function Stats(connection) {
    if (!connection.sequenceStats) {
        connection.sequenceStats = {
            tx: 0,
            rxLast: 0,
            rxReceived: 0,
            rxMissing: 0,
            rxDuplicates: 0,
            rxOutOfOrder: 0,
            lastGapAt: 0,
            lastRxAt: 0,
            lastTxAt: 0
        };
    }
    return connection.sequenceStats;
}

function Capable(type, id) {
    if (!type || !id) return false;
    const key = `${type}:${id}`;
    const caps = state.deviceCapabilities.get(key);
    return !!caps && caps.has('EVENT_SEQUENCE');
}

function Enabled(connection) {
    const { type, id } = Identity(connection);
    if (!type || !id || !Capable(type, id)) return false;
    try { return require('./featureFlags').FeatureEnabled(type, id, 'EVENT_SEQUENCE', false); }
    catch (_) { return false; }
}

function WrapOutbound(connection, line) {
    line = String(line || '');
    if (!connection || !Enabled(connection) || line.startsWith('SEQ|')) return line;
    const s = Stats(connection);
    s.tx += 1;
    s.lastTxAt = Date.now();
    return `SEQ|${s.tx}|${line}`;
}

function UnwrapInbound(connection, rawLine) {
    const line = String(rawLine || '');
    if (!line.startsWith('SEQ|')) return { ok: true, wrapped: false, line };
    const first = line.indexOf('|');
    const second = line.indexOf('|', first + 1);
    if (second < 0) return { ok: false, reason: 'INVALID_SEQUENCE_FRAME' };
    const seqText = line.substring(first + 1, second);
    const seq = Number(seqText);
    if (!Number.isSafeInteger(seq) || seq <= 0) return { ok: false, reason: 'INVALID_SEQUENCE_NUMBER' };
    const payload = line.substring(second + 1);
    if (!payload) return { ok: false, reason: 'EMPTY_SEQUENCE_PAYLOAD' };

    const s = Stats(connection);
    s.rxReceived += 1;
    s.lastRxAt = Date.now();
    const expected = s.rxLast + 1;
    let status = 'OK';

    if (s.rxLast === 0) {
        s.rxLast = seq;
        if (seq > 1) {
            s.rxMissing += seq - 1;
            status = 'GAP';
        }
    } else if (seq === s.rxLast) {
        s.rxDuplicates += 1;
        status = 'DUPLICATE';
    } else if (seq < s.rxLast) {
        s.rxOutOfOrder += 1;
        status = 'OUT_OF_ORDER';
    } else {
        if (seq > expected) {
            s.rxMissing += seq - expected;
            status = 'GAP';
        }
        s.rxLast = seq;
    }

    if (status !== 'OK') {
        const { type, id } = Identity(connection);
        s.lastGapAt = Date.now();
        try {
            require('../storage/audit').LogEvent('EVENT_SEQUENCE_' + status, `${type || 'UNKNOWN'} ${id || '-'} expected=${expected} got=${seq}`);
        } catch (_) {}
    }

    return { ok: true, wrapped: true, line: payload, seq, expected, status };
}

function Item(type, id, connection) {
    const s = connection ? Stats(connection) : null;
    return {
        type,
        id,
        online: !!connection,
        enabled: connection ? Enabled(connection) : false,
        capable: Capable(type, id),
        stats: s ? { ...s } : null
    };
}

function Overview() {
    const out = [];
    for (const id of state.serverIdentities.values()) out.push(Item('SERVER', id, state.servers.get(id) || null));
    for (const saved of state.clientIdentities.values()) out.push(Item('CLIENT', saved.id, state.clients.get(saved.id) || null));
    return out;
}

module.exports = { Stats, Capable, Enabled, WrapOutbound, UnwrapInbound, Overview };
