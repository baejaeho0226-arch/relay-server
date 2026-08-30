'use strict';

const crypto = require('crypto');
const state = require('../core/state');

const MAX_HISTORY = 100;

function Clone(value) { return JSON.parse(JSON.stringify(value)); }
function Snapshot() {
    return {
        runtimeConfig: Clone(state.desiredRuntimeConfig),
        serverFeatureOverrides: Object.fromEntries(state.serverFeatureOverrides),
        clientFeatureOverrides: Object.fromEntries(state.clientFeatureOverrides)
    };
}
function NewId() { return crypto.randomBytes(8).toString('hex').toUpperCase(); }
function Record(action, actor = 'system', detail = '') {
    const item = {
        id: NewId(),
        at: Date.now(),
        action: String(action || 'UPDATE').slice(0, 64),
        actor: String(actor || 'system').slice(0, 64),
        detail: String(detail || '').slice(0, 500),
        revision: Number(state.desiredRuntimeConfig.revision || 0),
        snapshot: Snapshot()
    };
    state.configHistory.unshift(item);
    if (state.configHistory.length > MAX_HISTORY) state.configHistory.length = MAX_HISTORY;
    return item;
}
function EnsureBaseline() {
    if (!state.configHistory.length) return Record('BASELINE', 'system', 'Initial configuration snapshot');
    return state.configHistory[0];
}
function List(limit = 100) { return state.configHistory.slice(0, Math.max(1, Math.min(MAX_HISTORY, Number(limit) || 100))).map(x => ({...x, snapshot: undefined})); }
function Get(id) { return state.configHistory.find(x => x.id === String(id || '')) || null; }
function RestoreMaps(target, source) {
    target.clear();
    for (const [k, v] of Object.entries(source || {})) target.set(k, Clone(v));
}
function Rollback(id, actor = 'admin') {
    const item = Get(id);
    if (!item || !item.snapshot) return { ok: false, reason: 'HISTORY_NOT_FOUND' };
    const oldRevision = Number(state.desiredRuntimeConfig.revision || 0);
    const cfg = Clone(item.snapshot.runtimeConfig || {});
    cfg.revision = Math.max(oldRevision + 1, Number(cfg.revision || 0) + 1);
    state.desiredRuntimeConfig = cfg;
    RestoreMaps(state.serverFeatureOverrides, item.snapshot.serverFeatureOverrides);
    RestoreMaps(state.clientFeatureOverrides, item.snapshot.clientFeatureOverrides);
    const created = Record('ROLLBACK', actor, `source=${item.id} sourceRevision=${item.revision}`);
    return { ok: true, source: { id: item.id, revision: item.revision, at: item.at }, currentRevision: cfg.revision, history: created };
}

module.exports = { MAX_HISTORY, Snapshot, Record, EnsureBaseline, List, Get, Rollback };
