'use strict';

const config = require('../config/config');
const state = require('../core/state');
const { Now, SafeField } = require('../core/utils');
const fs = require('fs');
const path = require('path');

const METRICS = ['connections', 'sends', 'ackOk', 'ackError', 'ackTimeout'];

function DateKey(timestamp = Now()) {
    try {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: config.DAILY_REPORT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(timestamp));
        const item = Object.fromEntries(parts.map(x => [x.type, x.value]));
        return `${item.year}-${item.month}-${item.day}`;
    } catch (_) {
        return new Date(timestamp).toISOString().slice(0, 10);
    }
}

function NewAccumulator(date = DateKey()) {
    return { date, startedAt: Now(), connections: 0, sends: 0, ackOk: 0, ackError: 0, ackTimeout: 0, peakServers: 0, peakClients: 0 };
}

function NormalizeAccumulator(raw) {
    if (!raw || typeof raw !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(String(raw.date || ''))) return null;
    const out = NewAccumulator(String(raw.date));
    out.startedAt = Number(raw.startedAt) || Now();
    for (const key of METRICS) out[key] = Math.max(0, Number(raw[key]) || 0);
    out.peakServers = Math.max(0, Number(raw.peakServers) || 0);
    out.peakClients = Math.max(0, Number(raw.peakClients) || 0);
    return out;
}

function ImportPersisted(data) {
    state.dailyHealthReports.clear();
    const source = data && data.dailyHealthReports;
    if (source && typeof source === 'object') {
        for (const [date, raw] of Object.entries(source)) {
            if (/^\d{4}-\d{2}-\d{2}$/.test(date) && raw && typeof raw === 'object') state.dailyHealthReports.set(date, { ...raw, date });
        }
    }
    state.dailyHealthAccumulator = NormalizeAccumulator(data && data.dailyHealthAccumulator);
    EnsureCurrent();
}

function BuildReport(accumulator, reason = 'SCHEDULED') {
    const acc = accumulator || EnsureCurrent();
    const ackTotal = acc.ackOk + acc.ackError + acc.ackTimeout;
    const flapping = state.runtimeStats.serverFlappingAlerts.size + state.runtimeStats.clientFlappingAlerts.size;
    const expiry = require('./licenseMonitor').GetExpirySummary();
    const processorStats = require('./processorCenter').Stats();
    let backupAt = Number(state.runtimeStats.lastBackupAt) || 0;
    let backupFile = state.runtimeStats.lastBackupFile || '';
    if (!backupAt) {
        try {
            const full = require('../storage/database').LatestBackupFile();
            if (full) { backupAt = fs.statSync(full).mtimeMs; backupFile = path.basename(full); }
        } catch (_) {}
    }
    return {
        date: acc.date,
        timezone: config.DAILY_REPORT_TIMEZONE,
        generatedAt: Now(),
        reason: SafeField(reason),
        servers: { online: state.servers.size, total: state.serverIdentities.size, peak: acc.peakServers },
        clients: { online: state.clients.size, total: state.clientIdentities.size, peak: acc.peakClients },
        connections: acc.connections,
        sends: acc.sends,
        ack: { ok: acc.ackOk, error: acc.ackError, timeout: acc.ackTimeout, successRate: ackTotal ? Number((acc.ackOk / ackTotal * 100).toFixed(2)) : 100 },
        flapping,
        licensesExpiring7d: expiry.within7d,
        backup: { ok: backupAt > 0, lastAt: backupAt, file: backupFile },
        database: { ok: state.runtimeStats.lastDatabaseSaveOk !== false, lastSaveAt: state.runtimeStats.lastDatabaseSaveAt, size: state.runtimeStats.lastDatabaseSize },
        processors: processorStats.map(x => ({ processor: x.processor, requests: x.requests, successRate: x.successRate, avgMs: x.avgMs, maxMs: x.maxMs }))
    };
}

function TrimReports() {
    const rows = Array.from(state.dailyHealthReports.keys()).sort().reverse();
    for (const date of rows.slice(config.DAILY_REPORT_RETENTION_DAYS)) state.dailyHealthReports.delete(date);
}

function Finalize(accumulator, reason = 'DAY_ROLLOVER') {
    const report = BuildReport(accumulator, reason);
    state.dailyHealthReports.set(report.date, report);
    TrimReports();
    try { require('../storage/audit').LogEvent('DAILY_HEALTH_REPORT', `${report.date} ACK=${report.ack.successRate}% TIMEOUT=${report.ack.timeout}`); } catch (_) {}
    require('./pushManager').Send({ title: `Relay Daily Health ${report.date}`, body: `Servers ${report.servers.online}/${report.servers.total} · Clients ${report.clients.online}/${report.clients.total} · ACK ${report.ack.successRate}% · Timeout ${report.ack.timeout}`, severity: 'INFO', type: 'DAILY_HEALTH', url: '/?view=reports' }, { force: true }).catch(() => {});
    return report;
}

function EnsureCurrent() {
    const currentDate = DateKey();
    if (!state.dailyHealthAccumulator) state.dailyHealthAccumulator = NewAccumulator(currentDate);
    if (state.dailyHealthAccumulator.date !== currentDate) {
        Finalize(state.dailyHealthAccumulator);
        state.dailyHealthAccumulator = NewAccumulator(currentDate);
    }
    state.dailyHealthAccumulator.peakServers = Math.max(state.dailyHealthAccumulator.peakServers, state.servers.size);
    state.dailyHealthAccumulator.peakClients = Math.max(state.dailyHealthAccumulator.peakClients, state.clients.size);
    return state.dailyHealthAccumulator;
}

function Record(metric, amount = 1) {
    if (!METRICS.includes(metric)) return;
    const acc = EnsureCurrent();
    acc[metric] += Math.max(0, Number(amount) || 0);
}

function GenerateCurrent(reason = 'MANUAL') {
    const report = BuildReport(EnsureCurrent(), reason);
    state.dailyHealthReports.set(report.date, report);
    TrimReports();
    require('../storage/database').SaveDatabase();
    return report;
}

function List(limit = 90) {
    return Array.from(state.dailyHealthReports.values()).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, Math.max(1, Math.min(365, Number(limit) || 90)));
}

function Overview(limit) {
    const current = BuildReport(EnsureCurrent(), 'LIVE_PREVIEW');
    return { timezone: config.DAILY_REPORT_TIMEZONE, current, reports: List(limit) };
}

module.exports = { DateKey, NewAccumulator, ImportPersisted, BuildReport, EnsureCurrent, Record, GenerateCurrent, List, Overview };
