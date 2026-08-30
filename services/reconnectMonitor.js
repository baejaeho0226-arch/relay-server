'use strict';

const config = require('../config/config');
const state = require('../core/state');
const { Now } = require('../core/utils');

const WINDOW_MS = config.RECONNECT_WINDOW_MS || 5 * 60 * 1000;
const THRESHOLD = config.RECONNECT_FLAPPING_THRESHOLD || 5;
const ALERT_COOLDOWN_MS = config.RECONNECT_ALERT_COOLDOWN_MS || 5 * 60 * 1000;

function Maps(kind) {
    if (String(kind).toUpperCase() === 'SERVER') {
        return { history: state.runtimeStats.serverReconnectHistory, alerts: state.runtimeStats.serverFlappingAlerts };
    }
    return { history: state.runtimeStats.clientReconnectHistory, alerts: state.runtimeStats.clientFlappingAlerts };
}

function Prune(list, now) {
    return (Array.isArray(list) ? list : []).filter(x => now - x <= WINDOW_MS);
}

function RecordReconnect(kind, id) {
    kind = String(kind || '').toUpperCase();
    id = String(id || '').toUpperCase();
    if (!id || !['SERVER', 'CLIENT'].includes(kind)) return GetReconnectStatus(kind, id);
    const now = Now();
    const maps = Maps(kind);
    const list = Prune(maps.history.get(id), now);
    list.push(now);
    maps.history.set(id, list);

    if (list.length >= THRESHOLD) {
        const lastAlert = Number(maps.alerts.get(id) || 0);
        if (now - lastAlert >= ALERT_COOLDOWN_MS) {
            maps.alerts.set(id, now);
            const detail = `${id} ${list.length} reconnects / ${Math.round(WINDOW_MS / 60000)}m`;
            try { require('../storage/audit').LogEvent(`${kind}_FLAPPING`, detail); } catch (_) {}
            try {
                require('./notificationCenter').AddNotification({
                    severity: 'WARNING',
                    type: `${kind}_FLAPPING`,
                    title: `${kind === 'SERVER' ? 'Server' : 'Client'} reconnect storm`,
                    message: detail,
                    entityType: kind,
                    entityId: id,
                    dedupeKey: `${kind}_FLAPPING|${id}`
                });
            } catch (_) {}
        }
    }
    return GetReconnectStatus(kind, id);
}

function GetReconnectStatus(kind, id) {
    kind = String(kind || '').toUpperCase();
    id = String(id || '').toUpperCase();
    if (!id || !['SERVER', 'CLIENT'].includes(kind)) return { count: 0, windowMs: WINDOW_MS, threshold: THRESHOLD, flapping: false, lastAt: 0 };
    const now = Now();
    const maps = Maps(kind);
    const list = Prune(maps.history.get(id), now);
    if (list.length) maps.history.set(id, list); else maps.history.delete(id);
    return {
        count: list.length,
        windowMs: WINDOW_MS,
        threshold: THRESHOLD,
        flapping: list.length >= THRESHOLD,
        lastAt: list.length ? list[list.length - 1] : 0
    };
}

function CleanupReconnectHistory() {
    for (const kind of ['SERVER', 'CLIENT']) {
        const maps = Maps(kind);
        for (const id of Array.from(maps.history.keys())) GetReconnectStatus(kind, id);
        const now = Now();
        for (const [id, at] of maps.alerts) if (now - at > ALERT_COOLDOWN_MS * 2) maps.alerts.delete(id);
    }
}

module.exports = { RecordReconnect, GetReconnectStatus, CleanupReconnectHistory };
