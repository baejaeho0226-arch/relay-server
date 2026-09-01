'use strict';

const state = require('../core/state');
const config = require('../config/config');
const { Now, NormalizeID, SendLine } = require('../core/utils');

const serverOfflineSince = new Map();
const serverOnlineSince = new Map();

function SaveDatabase() { return require('../storage/database').SaveDatabase(); }
function LogEvent(type, detail) { return require('../storage/audit').LogEvent(type, detail); }
function AddNotification(item) { try { return require('./notificationCenter').AddNotification(item); } catch (_) { return null; } }
function GetOnlineServer(id) { return require('../identity/identityManager').GetOnlineServer(id); }
function GetOnlineClient(id) { return require('../identity/identityManager').GetOnlineClient(id); }
function GetSavedClientByID(id) { return require('../identity/identityManager').GetSavedClientByID(id); }
function GetServerClientCount(id) { return require('../identity/identityManager').GetServerClientCount(id); }
function GetKickUntil(map, id) { return require('../identity/identityManager').GetKickUntil(map, id); }
function ServerExists(id) { return require('../identity/identityManager').ServerExists(id); }
function GetFixedBuildBinding(clientId) {
    try { return require('./buildGate').BindingForClient(clientId); }
    catch (_) { return null; }
}

function DefaultPolicy() {
    return {
        enabled: false,
        autoReturn: true,
        offlineGraceSeconds: 15,
        returnGraceSeconds: 30,
        maxMovesPerCycle: 50,
        updatedAt: 0
    };
}

function NormalizePolicy(raw) {
    const base = DefaultPolicy();
    if (!raw || typeof raw !== 'object') return base;
    const offlineGrace = Number(raw.offlineGraceSeconds);
    const returnGrace = Number(raw.returnGraceSeconds);
    const maxMoves = Number(raw.maxMovesPerCycle);
    return {
        enabled: Boolean(raw.enabled),
        autoReturn: raw.autoReturn !== false,
        offlineGraceSeconds: Math.max(0, Math.min(3600, Number.isFinite(offlineGrace) ? offlineGrace : base.offlineGraceSeconds)),
        returnGraceSeconds: Math.max(0, Math.min(3600, Number.isFinite(returnGrace) ? returnGrace : base.returnGraceSeconds)),
        maxMovesPerCycle: Math.max(1, Math.min(1000, Number.isFinite(maxMoves) && maxMoves > 0 ? maxMoves : base.maxMovesPerCycle)),
        updatedAt: Math.max(0, Number(raw.updatedAt) || 0)
    };
}

function EnsureState() {
    state.emergencyFailoverPolicy = NormalizePolicy(state.emergencyFailoverPolicy);
    if (!(state.clientFailoverEnabled instanceof Set)) state.clientFailoverEnabled = new Set();
    if (!(state.clientFailoverRecords instanceof Map)) state.clientFailoverRecords = new Map();
    if (!(state.clientServerBindings instanceof Map)) state.clientServerBindings = new Map();
}

function KnownServerIds() {
    return Array.from(new Set(Array.from(state.serverIdentities.values()).map(NormalizeID).filter(Boolean)));
}

function ServerUsability(serverId) {
    serverId = NormalizeID(serverId);
    if (!serverId) return { usable: false, reason: 'SERVER_NOT_FOUND' };
    if (state.disabledServers.has(serverId)) return { usable: false, reason: 'SERVER_DISABLED' };
    if (GetKickUntil(state.kickedServers, serverId) > Now()) return { usable: false, reason: 'SERVER_KICKED' };
    const server = GetOnlineServer(serverId);
    if (!server) return { usable: false, reason: 'SERVER_OFFLINE' };
    // DRAIN intentionally does not evict existing clients. A draining primary remains usable.
    return { usable: true, reason: state.drainingServers.has(serverId) ? 'SERVER_DRAINING_EXISTING_OK' : 'ONLINE', server };
}

function TargetUsable(serverId) {
    serverId = NormalizeID(serverId);
    if (!serverId) return false;
    if (state.disabledServers.has(serverId) || state.drainingServers.has(serverId)) return false;
    if (GetKickUntil(state.kickedServers, serverId) > Now()) return false;
    const server = GetOnlineServer(serverId);
    if (!server) return false;
    try {
        const da = require('./deviceAuth');
        if (da.Enforced('SERVER', serverId) && !da.Verified('SERVER', serverId)) return false;
    } catch (_) {}
    if (server.clients.size >= config.MAX_CLIENTS_PER_SERVER) return false;
    if (GetServerClientCount(serverId) >= config.MAX_CLIENTS_PER_SERVER) return false;
    return true;
}

function UpdateServerTimers() {
    const now = Now();
    const known = KnownServerIds();
    const knownSet = new Set(known);
    for (const serverId of known) {
        const online = !!GetOnlineServer(serverId);
        if (online) {
            serverOfflineSince.delete(serverId);
            if (!serverOnlineSince.has(serverId)) serverOnlineSince.set(serverId, now);
        } else {
            serverOnlineSince.delete(serverId);
            if (!serverOfflineSince.has(serverId)) serverOfflineSince.set(serverId, now);
        }
    }
    for (const id of Array.from(serverOfflineSince.keys())) if (!knownSet.has(id)) serverOfflineSince.delete(id);
    for (const id of Array.from(serverOnlineSince.keys())) if (!knownSet.has(id)) serverOnlineSince.delete(id);
}

function MarkServerOffline(serverId) {
    serverId = NormalizeID(serverId);
    if (!serverId) return;
    serverOnlineSince.delete(serverId);
    if (!serverOfflineSince.has(serverId)) serverOfflineSince.set(serverId, Now());
}

function MarkServerOnline(serverId) {
    serverId = NormalizeID(serverId);
    if (!serverId) return;
    serverOfflineSince.delete(serverId);
    serverOnlineSince.set(serverId, Now());
}

function OfflineAgeMs(serverId) {
    const status = ServerUsability(serverId);
    if (status.usable) return 0;
    if (status.reason === 'SERVER_DISABLED' || status.reason === 'SERVER_KICKED') return Number.MAX_SAFE_INTEGER;
    const since = serverOfflineSince.get(NormalizeID(serverId));
    return since ? Math.max(0, Now() - since) : 0;
}

function OnlineAgeMs(serverId) {
    const status = ServerUsability(serverId);
    if (!status.usable) return 0;
    const since = serverOnlineSince.get(NormalizeID(serverId));
    return since ? Math.max(0, Now() - since) : 0;
}

function FindTarget(primaryServerId, currentServerId = '', clientId = '') {
    primaryServerId = NormalizeID(primaryServerId);
    currentServerId = NormalizeID(currentServerId);
    clientId = NormalizeID(clientId);
    const binding = clientId ? state.clientServerBindings.get(clientId) : null;
    if (binding && binding.backupServerId) {
        const backupServerId = NormalizeID(binding.backupServerId);
        if (backupServerId && backupServerId !== primaryServerId && backupServerId !== currentServerId && TargetUsable(backupServerId)) {
            const live = GetOnlineServer(backupServerId);
            return {
                serverId: backupServerId,
                liveClients: live ? live.clients.size : 0,
                boundClients: GetServerClientCount(backupServerId),
                selectedBy: 'EXPLICIT_BACKUP'
            };
        }
        if (!binding.allowAutomaticFallback) return null;
    }
    if (binding && !binding.backupServerId && !binding.allowAutomaticFallback) return null;
    const candidates = [];
    for (const serverId of KnownServerIds()) {
        if (!serverId || serverId === primaryServerId || serverId === currentServerId) continue;
        if (!TargetUsable(serverId)) continue;
        const live = GetOnlineServer(serverId);
        candidates.push({
            serverId,
            liveClients: live ? live.clients.size : 0,
            boundClients: GetServerClientCount(serverId),
            selectedBy: 'AUTO_FALLBACK'
        });
    }
    candidates.sort((a, b) => (a.liveClients - b.liveClients) || (a.boundClients - b.boundClients) || a.serverId.localeCompare(b.serverId));
    return candidates[0] || null;
}

function DisconnectClientForMove(clientId, serverId, reason) {
    const live = GetOnlineClient(clientId);
    if (!live) return;
    try { SendLine(live.socket, `ERROR|CLIENT_MOVED|${serverId}|${reason}`); } catch (_) {}
    try { live.socket.destroy(); } catch (_) {}
}

function MoveToFailover(clientId, primaryServerId, targetServerId, reason, selectedBy = 'AUTO_FALLBACK') {
    const saved = GetSavedClientByID(clientId);
    if (!saved) return { ok: false, reason: 'CLIENT_NOT_FOUND' };
    targetServerId = NormalizeID(targetServerId);
    if (!TargetUsable(targetServerId)) return { ok: false, reason: 'NO_FAILOVER_TARGET' };
    const now = Now();
    const previousCurrent = NormalizeID(saved.serverId);
    let record = state.clientFailoverRecords.get(clientId);
    if (!record) {
        record = {
            clientId,
            primaryServerId: NormalizeID(primaryServerId || previousCurrent),
            failoverServerId: targetServerId,
            failedOverAt: now,
            lastMoveAt: now,
            moveCount: 1,
            reason: String(reason || 'PRIMARY_UNAVAILABLE'),
            selectedBy: String(selectedBy || 'AUTO_FALLBACK'),
            lastReturnAt: 0
        };
    } else {
        record.failoverServerId = targetServerId;
        record.lastMoveAt = now;
        record.moveCount = Math.max(1, Number(record.moveCount) || 0) + 1;
        record.reason = String(reason || record.reason || 'FAILOVER_TARGET_UNAVAILABLE');
        record.selectedBy = String(selectedBy || record.selectedBy || 'AUTO_FALLBACK');
    }
    saved.serverId = targetServerId;
    state.clientFailoverRecords.set(clientId, record);
    SaveDatabase();
    DisconnectClientForMove(clientId, targetServerId, 'EMERGENCY_FAILOVER');
    LogEvent('CLIENT_EMERGENCY_FAILOVER', `${clientId} primary=${record.primaryServerId} ${previousCurrent}->${targetServerId} reason=${record.reason}`);
    AddNotification({
        severity: 'WARNING', type: 'CLIENT_EMERGENCY_FAILOVER', title: 'Client emergency failover',
        message: `${clientId}: ${record.primaryServerId} -> ${targetServerId} (${record.reason})`,
        entityType: 'CLIENT', entityId: clientId,
        dedupeKey: `CLIENT_EMERGENCY_FAILOVER|${clientId}|${targetServerId}|${record.moveCount}`
    });
    return { ok: true, record: { ...record } };
}

function ReturnToPrimary(clientId, manual = false) {
    clientId = NormalizeID(clientId);
    const record = state.clientFailoverRecords.get(clientId);
    if (!record) return { ok: false, reason: 'NOT_FAILED_OVER' };
    const primary = NormalizeID(record.primaryServerId);
    if (!TargetUsable(primary)) return { ok: false, reason: 'PRIMARY_NOT_READY' };
    const saved = GetSavedClientByID(clientId);
    if (!saved) return { ok: false, reason: 'CLIENT_NOT_FOUND' };
    const old = NormalizeID(saved.serverId);
    saved.serverId = primary;
    record.lastReturnAt = Now();
    state.clientFailoverRecords.delete(clientId);
    SaveDatabase();
    DisconnectClientForMove(clientId, primary, manual ? 'ADMIN_RETURN_PRIMARY' : 'AUTO_RETURN_PRIMARY');
    LogEvent(manual ? 'CLIENT_FAILOVER_RETURN_MANUAL' : 'CLIENT_FAILOVER_RETURN_AUTO', `${clientId} ${old}->${primary}`);
    AddNotification({
        severity: 'INFO', type: 'CLIENT_FAILOVER_RETURN', title: 'Client returned to primary',
        message: `${clientId}: ${old} -> ${primary}`,
        entityType: 'CLIENT', entityId: clientId,
        dedupeKey: `CLIENT_FAILOVER_RETURN|${clientId}|${primary}|${record.lastReturnAt}`
    });
    return { ok: true, clientId, primaryServerId: primary, oldServerId: old };
}

function SetPolicy(raw) {
    EnsureState();
    const current = state.emergencyFailoverPolicy;
    const next = NormalizePolicy({ ...current, ...raw, updatedAt: Now() });
    state.emergencyFailoverPolicy = next;
    SaveDatabase();
    LogEvent('EMERGENCY_FAILOVER_POLICY', JSON.stringify(next));
    return { ...next };
}

function SetClientEnabled(clientId, enabled) {
    EnsureState();
    clientId = NormalizeID(clientId);
    if (!GetSavedClientByID(clientId)) return { ok: false, reason: 'CLIENT_NOT_FOUND' };
    if (enabled) state.clientFailoverEnabled.add(clientId);
    else state.clientFailoverEnabled.delete(clientId);
    SaveDatabase();
    LogEvent(enabled ? 'CLIENT_FAILOVER_ENABLED' : 'CLIENT_FAILOVER_DISABLED', clientId);
    return { ok: true, clientId, enabled: Boolean(enabled) };
}

function GetBinding(clientId) {
    EnsureState();
    clientId = NormalizeID(clientId);
    const saved = GetSavedClientByID(clientId);
    if (!saved) return null;
    const explicit = state.clientServerBindings.get(clientId);
    if (explicit) return { ...explicit, configured: true };
    const record = state.clientFailoverRecords.get(clientId);
    return {
        clientId,
        primaryServerId: record ? NormalizeID(record.primaryServerId) : NormalizeID(saved.serverId),
        backupServerId: '',
        allowAutomaticFallback: true,
        updatedAt: 0,
        configured: false
    };
}

function SetBinding(clientId, primaryServerId, backupServerId = '', allowAutomaticFallback = false) {
    EnsureState();
    clientId = NormalizeID(clientId);
    primaryServerId = NormalizeID(primaryServerId);
    backupServerId = NormalizeID(backupServerId || '');
    const saved = GetSavedClientByID(clientId);
    if (!saved) return { ok: false, reason: 'CLIENT_NOT_FOUND' };
    if (!primaryServerId || !ServerExists(primaryServerId)) return { ok: false, reason: 'PRIMARY_SERVER_NOT_FOUND' };
    if (backupServerId && !ServerExists(backupServerId)) return { ok: false, reason: 'BACKUP_SERVER_NOT_FOUND' };
    if (backupServerId && backupServerId === primaryServerId) return { ok: false, reason: 'PRIMARY_BACKUP_SAME' };
    const oldServerId = NormalizeID(saved.serverId);
    const binding = {
        clientId,
        primaryServerId,
        backupServerId,
        allowAutomaticFallback: Boolean(allowAutomaticFallback),
        updatedAt: Now()
    };
    state.clientServerBindings.set(clientId, binding);
    state.clientFailoverRecords.delete(clientId);
    saved.serverId = primaryServerId;
    SaveDatabase();
    if (oldServerId !== primaryServerId) DisconnectClientForMove(clientId, primaryServerId, 'PRIMARY_BINDING_CHANGED');
    LogEvent('CLIENT_SERVER_BINDING', `${clientId} primary=${primaryServerId} backup=${backupServerId || '-'} autoFallback=${binding.allowAutomaticFallback}`);
    return { ok: true, binding: { ...binding }, oldServerId };
}

function ClearBinding(clientId) {
    EnsureState();
    clientId = NormalizeID(clientId);
    if (!GetSavedClientByID(clientId)) return { ok: false, reason: 'CLIENT_NOT_FOUND' };
    const removed = state.clientServerBindings.delete(clientId);
    state.clientFailoverRecords.delete(clientId);
    SaveDatabase();
    LogEvent('CLIENT_SERVER_BINDING_CLEAR', `${clientId} removed=${removed}`);
    return { ok: true, clientId, removed };
}

function HandleManualMove(clientId, newServerId) {
    EnsureState();
    clientId = NormalizeID(clientId);
    newServerId = NormalizeID(newServerId);
    state.clientFailoverRecords.delete(clientId);
    const binding = state.clientServerBindings.get(clientId);
    if (binding) {
        binding.primaryServerId = newServerId;
        if (binding.backupServerId === newServerId) binding.backupServerId = '';
        binding.updatedAt = Now();
        state.clientServerBindings.set(clientId, binding);
        LogEvent('CLIENT_BINDING_PRIMARY_BY_MANUAL_MOVE', `${clientId} -> ${newServerId}`);
    }
}

function ClearRecordForManualMove(clientId) {
    EnsureState();
    clientId = NormalizeID(clientId);
    if (!state.clientFailoverRecords.has(clientId)) return false;
    state.clientFailoverRecords.delete(clientId);
    SaveDatabase();
    LogEvent('CLIENT_FAILOVER_CANCELLED_BY_MANUAL_MOVE', clientId);
    return true;
}

function Evaluate() {
    EnsureState();
    UpdateServerTimers();
    const policy = state.emergencyFailoverPolicy;
    if (!policy.enabled || !state.serviceEnabled || state.maintenanceMode) return { moves: 0, returns: 0, skipped: true };

    let moves = 0;
    let returns = 0;
    let changed = false;
    const maxMoves = policy.maxMovesPerCycle;
    for (const clientId of Array.from(state.clientFailoverEnabled)) {
        if (moves + returns >= maxMoves) break;
        const saved = GetSavedClientByID(clientId);
        if (!saved) {
            state.clientFailoverEnabled.delete(clientId);
            changed = true;
            continue;
        }
        let record = state.clientFailoverRecords.get(clientId);

        // A successful Build permanently binds this APK to its WinSockServer.
        // Automatic failover/return must never rewrite that binding. Only the
        // explicit Web Admin rebind operation may move a Build-bound client.
        if (GetFixedBuildBinding(clientId)) {
            if (record) {
                state.clientFailoverRecords.delete(clientId);
                LogEvent('CLIENT_FAILOVER_BLOCKED_BUILD_BINDING', `${clientId} BUILD_BINDING_FIXED`);
                changed = true;
            }
            continue;
        }

        if (record) {
            const current = NormalizeID(saved.serverId);
            const primary = NormalizeID(record.primaryServerId);
            const failover = NormalizeID(record.failoverServerId);
            // A manual binding change outside the failover manager becomes authoritative.
            if (current !== failover && current !== primary) {
                state.clientFailoverRecords.delete(clientId);
                LogEvent('CLIENT_FAILOVER_RECORD_CLEARED', `${clientId} manualCurrent=${current}`);
                changed = true;
                continue;
            }
            if (current === primary) {
                state.clientFailoverRecords.delete(clientId);
                changed = true;
                continue;
            }

            if (policy.autoReturn && TargetUsable(primary) && OnlineAgeMs(primary) >= policy.returnGraceSeconds * 1000) {
                const result = ReturnToPrimary(clientId, false);
                if (result.ok) returns++;
                continue;
            }

            const activeStatus = ServerUsability(current);
            if (!activeStatus.usable && OfflineAgeMs(current) >= policy.offlineGraceSeconds * 1000) {
                const target = FindTarget(primary, current, clientId);
                if (target) {
                    const result = MoveToFailover(clientId, primary, target.serverId, activeStatus.reason, target.selectedBy);
                    if (result.ok) moves++;
                }
            }
            continue;
        }

        const binding = GetBinding(clientId);
        const primary = binding ? NormalizeID(binding.primaryServerId) : NormalizeID(saved.serverId);
        const status = ServerUsability(primary);
        if (status.usable) continue;
        if (OfflineAgeMs(primary) < policy.offlineGraceSeconds * 1000) continue;
        const target = FindTarget(primary, '', clientId);
        if (!target) continue;
        const result = MoveToFailover(clientId, primary, target.serverId, status.reason, target.selectedBy);
        if (result.ok) moves++;
    }

    if (moves || returns || changed) SaveDatabase();
    return { moves, returns, skipped: false };
}

function BuildStatus() {
    EnsureState();
    UpdateServerTimers();
    const rows = [];
    for (const saved of state.clientIdentities.values()) {
        if (!saved || !saved.id) continue;
        const clientId = NormalizeID(saved.id);
        const record = state.clientFailoverRecords.get(clientId);
        const binding = GetBinding(clientId);
        const primary = binding ? NormalizeID(binding.primaryServerId) : (record ? NormalizeID(record.primaryServerId) : NormalizeID(saved.serverId));
        const backup = binding && binding.configured ? NormalizeID(binding.backupServerId) : '';
        const current = NormalizeID(saved.serverId);
        const primaryStatus = ServerUsability(primary);
        const backupStatus = backup ? ServerUsability(backup) : { reason: 'NOT_CONFIGURED' };
        const currentStatus = ServerUsability(current);
        const buildBinding = GetFixedBuildBinding(clientId);
        rows.push({
            clientId,
            enabled: state.clientFailoverEnabled.has(clientId),
            buildBindingFixed: Boolean(buildBinding),
            buildBindingServerId: buildBinding ? NormalizeID(buildBinding.serverId) : '',
            failedOver: Boolean(record),
            primaryServerId: primary,
            backupServerId: backup,
            backupStatus: backupStatus.reason,
            bindingConfigured: Boolean(binding && binding.configured),
            allowAutomaticFallback: Boolean(binding && binding.allowAutomaticFallback),
            currentServerId: current,
            failoverServerId: record ? NormalizeID(record.failoverServerId) : '',
            primaryStatus: primaryStatus.reason,
            currentStatus: currentStatus.reason,
            failedOverAt: record ? Number(record.failedOverAt) || 0 : 0,
            moveCount: record ? Number(record.moveCount) || 0 : 0,
            reason: record ? String(record.reason || '') : '',
            selectedBy: record ? String(record.selectedBy || '') : '',
            primaryOnlineForMs: OnlineAgeMs(primary),
            currentOfflineForMs: OfflineAgeMs(current)
        });
    }
    rows.sort((a, b) => Number(b.failedOver) - Number(a.failedOver) || Number(b.enabled) - Number(a.enabled) || a.clientId.localeCompare(b.clientId));
    return {
        policy: { ...state.emergencyFailoverPolicy },
        summary: {
            totalClients: rows.length,
            optedIn: rows.filter(x => x.enabled).length,
            failedOver: rows.filter(x => x.failedOver).length,
            configuredBindings: rows.filter(x => x.bindingConfigured).length,
            primaryUnavailable: rows.filter(x => x.enabled && !x.failedOver && x.primaryStatus !== 'ONLINE' && x.primaryStatus !== 'SERVER_DRAINING_EXISTING_OK').length
        },
        clients: rows
    };
}

module.exports = {
    DefaultPolicy,
    NormalizePolicy,
    EnsureState,
    MarkServerOffline,
    MarkServerOnline,
    SetPolicy,
    SetClientEnabled,
    GetBinding,
    SetBinding,
    ClearBinding,
    HandleManualMove,
    ClearRecordForManualMove,
    ReturnToPrimary,
    Evaluate,
    BuildStatus,
    FindTarget,
    ServerUsability
};
