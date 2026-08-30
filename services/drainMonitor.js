'use strict';

const state = require('../core/state');
const { Now, NormalizeID } = require('../core/utils');
const { GetOnlineServer, ServerExists } = require('../identity/identityManager');

function SaveDatabase() { return require('../storage/database').SaveDatabase(); }
function LogEvent(type, detail) { return require('../storage/audit').LogEvent(type, detail); }

function StartDrain(serverId) {
    serverId = NormalizeID(serverId);
    if (!serverId || !ServerExists(serverId)) return { ok: false, reason: 'SERVER_NOT_FOUND' };
    const live = GetOnlineServer(serverId);
    const currentClients = live ? live.clients.size : 0;
    state.drainingServers.add(serverId);
    if (!state.serverDrainMeta.has(serverId)) {
        state.serverDrainMeta.set(serverId, {
            startedAt: Now(),
            initialClients: currentClients,
            readyNotified: false
        });
    }
    SaveDatabase();
    return { ok: true, status: GetDrainStatus(serverId) };
}

function StopDrain(serverId) {
    serverId = NormalizeID(serverId);
    state.drainingServers.delete(serverId);
    state.serverDrainMeta.delete(serverId);
    SaveDatabase();
    return { ok: true };
}

function ClearDrainMeta(serverId) {
    serverId = NormalizeID(serverId);
    state.drainingServers.delete(serverId);
    state.serverDrainMeta.delete(serverId);
}

function GetDrainStatus(serverId) {
    serverId = NormalizeID(serverId);
    const active = state.drainingServers.has(serverId);
    const live = GetOnlineServer(serverId);
    const currentClients = live ? live.clients.size : 0;
    const savedClients = (() => {
        let count = 0;
        for (const saved of state.clientIdentities.values()) if (saved.serverId === serverId) count++;
        return count;
    })();
    let meta = state.serverDrainMeta.get(serverId);
    if (active && !meta) {
        meta = { startedAt: 0, initialClients: currentClients, readyNotified: false };
    }
    const initialClients = Math.max(Number(meta && meta.initialClients || 0), currentClients);
    const completed = Math.max(0, initialClients - currentClients);
    const progress = !active ? 0 : initialClients <= 0 ? 100 : Math.max(0, Math.min(100, Math.round((completed / initialClients) * 100)));
    return {
        active,
        startedAt: Number(meta && meta.startedAt || 0),
        initialClients,
        currentClients,
        savedClients,
        completed,
        progress,
        ready: active && !!live && currentClients === 0,
        readyNotified: Boolean(meta && meta.readyNotified)
    };
}

function CheckDrainReadiness() {
    let changed = false;
    for (const serverId of Array.from(state.drainingServers)) {
        if (!ServerExists(serverId)) {
            state.drainingServers.delete(serverId);
            state.serverDrainMeta.delete(serverId);
            changed = true;
            continue;
        }
        const live = GetOnlineServer(serverId);
        const currentClients = live ? live.clients.size : 0;
        let meta = state.serverDrainMeta.get(serverId);
        if (!meta) {
            meta = { startedAt: Now(), initialClients: currentClients, readyNotified: false };
            state.serverDrainMeta.set(serverId, meta);
            changed = true;
        }
        if (currentClients > meta.initialClients) {
            meta.initialClients = currentClients;
            changed = true;
        }
        if (live && currentClients === 0 && !meta.readyNotified) {
            meta.readyNotified = true;
            changed = true;
            LogEvent('SERVER_DRAIN_READY', `${serverId} READY_FOR_MAINTENANCE`);
        } else if (live && currentClients > 0 && meta.readyNotified) {
            meta.readyNotified = false;
            changed = true;
            LogEvent('SERVER_DRAIN_ACTIVE', `${serverId} clients=${currentClients}`);
        } else if (!live && meta.readyNotified) {
            meta.readyNotified = false;
            changed = true;
        }
    }
    if (changed) SaveDatabase();
}

module.exports = { StartDrain, StopDrain, ClearDrainMeta, GetDrainStatus, CheckDrainReadiness };
