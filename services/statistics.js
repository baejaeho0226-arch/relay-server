'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const state = require('../core/state');

function AuditFilesForRange(startAt, endAt) {
    const out = [];
    const d = new Date(startAt);
    d.setUTCHours(0, 0, 0, 0);
    while (d.getTime() <= endAt) {
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        const file = path.join(config.AUDIT_DIR, `audit-${y}-${m}-${day}.jsonl`);
        if (fs.existsSync(file)) out.push(file);
        d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
}

function ReadEvents(startAt, endAt) {
    const result = [];
    const seen = new Set();
    for (const file of AuditFilesForRange(startAt, endAt)) {
        let text = '';
        try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
        for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
                const e = JSON.parse(line);
                const time = Number(e.time) || 0;
                if (time < startAt || time > endAt) continue;
                const key = `${time}|${e.type}|${e.detail}`;
                if (seen.has(key)) continue;
                seen.add(key);
                result.push({ time, type: String(e.type || '') });
            } catch (_) {}
        }
    }
    if (!result.length) {
        for (const e of state.events) if (e.time >= startAt && e.time <= endAt) result.push({ time: e.time, type: e.type });
    }
    return result;
}

function BuildStatistics(range = '1H') {
    range = String(range || '1H').toUpperCase();
    let durationMs = 60 * 60 * 1000;
    let bucketMs = 5 * 60 * 1000;
    if (range === '24H') { durationMs = 24 * 60 * 60 * 1000; bucketMs = 60 * 60 * 1000; }
    else if (range === '6H') { durationMs = 6 * 60 * 60 * 1000; bucketMs = 30 * 60 * 1000; }
    else if (range === '7D') { durationMs = 7 * 24 * 60 * 60 * 1000; bucketMs = 6 * 60 * 60 * 1000; }
    else range = '1H';

    const endAt = Date.now();
    const bucketCount = Math.ceil(durationMs / bucketMs);
    const startAt = Math.floor((endAt - durationMs) / bucketMs) * bucketMs;
    const buckets = [];
    for (let i = 0; i <= bucketCount; i++) {
        const time = startAt + i * bucketMs;
        buckets.push({ time, connections: 0, sends: 0, ackOk: 0, ackError: 0, ackTimeout: 0 });
    }
    const events = ReadEvents(startAt, endAt);
    for (const e of events) {
        let index = Math.floor((e.time - startAt) / bucketMs);
        if (index < 0 || index >= buckets.length) continue;
        const b = buckets[index];
        if (e.type === 'SERVER_ONLINE' || e.type === 'CLIENT_ONLINE') b.connections++;
        else if (e.type === 'NUMBER_SEND') b.sends++;
        else if (e.type === 'ACK_OK') b.ackOk++;
        else if (e.type === 'ACK_ERROR' || e.type === 'ACK_FAILED') b.ackError++;
        else if (e.type === 'ACK_TIMEOUT') b.ackTimeout++;
    }
    const totals = buckets.reduce((a, b) => {
        a.connections += b.connections; a.sends += b.sends; a.ackOk += b.ackOk; a.ackError += b.ackError; a.ackTimeout += b.ackTimeout; return a;
    }, { connections: 0, sends: 0, ackOk: 0, ackError: 0, ackTimeout: 0 });
    const ackTotal = totals.ackOk + totals.ackError + totals.ackTimeout;
    totals.ackSuccessRate = ackTotal ? Number((totals.ackOk / ackTotal * 100).toFixed(2)) : 100;
    return { range, startAt, endAt, bucketMs, totals, buckets };
}

module.exports = { BuildStatistics };
