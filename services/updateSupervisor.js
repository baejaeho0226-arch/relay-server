'use strict';

const state = require('../core/state');
const { NormalizeID, NormalizeVersion, Now, SafeField } = require('../core/utils');

function Key(type, id, version) { return `${String(type).toUpperCase()}:${NormalizeID(id)}:${NormalizeVersion(version)}`; }
function Begin(type, id, release) {
    if (!release) return null;
    const key = Key(type, id, release.version);
    let tx = state.production.updateTransactions.get(key);
    if (!tx) {
        tx = {
            key, type: String(type).toUpperCase(), id: NormalizeID(id), version: NormalizeVersion(release.version),
            channel: String(release.channel || '').toUpperCase(), artifactId: release.artifactId,
            status: 'OFFERED', offeredAt: Now(), updatedAt: Now(), detail: '', startupDeadline: 0
        };
        state.production.updateTransactions.set(key, tx);
    }
    return tx;
}

function IsFailure(status) { return /FAILED|INVALID|ERROR|ROLLBACK|HASH_MISMATCH|SIGNATURE/.test(status); }
function IsSuccess(status) { return /STARTUP_OK|HEALTHY|APPLIED|STAGED|RECEIVED/.test(status) && !IsFailure(status); }

function Record(type, id, version, status, detail) {
    const key = Key(type, id, version);
    const tx = state.production.updateTransactions.get(key) || {
        key, type: String(type).toUpperCase(), id: NormalizeID(id), version: NormalizeVersion(version),
        channel: require('./releaseManager').ChannelFor(type, id), artifactId: '', offeredAt: Now()
    };
    tx.status = SafeField(status || 'UNKNOWN').toUpperCase();
    tx.detail = SafeField(detail || '').slice(0, 500);
    tx.updatedAt = Now();
    if (/STAGED|APPLIED/.test(tx.status)) tx.startupDeadline = tx.updatedAt + Number(state.production.updatePolicy.startupAckSeconds || 60) * 1000;
    if (/STARTUP_OK|HEALTHY/.test(tx.status)) tx.startupDeadline = 0;
    state.production.updateTransactions.set(key, tx);
    Evaluate(tx.type, tx.channel, tx.version);
    return tx;
}

function Evaluate(type, channel, version) {
    const samples = Array.from(state.production.updateTransactions.values()).filter(x => x.type === type && x.channel === channel && x.version === version && (IsFailure(x.status) || IsSuccess(x.status)));
    const failed = samples.filter(x => IsFailure(x.status)).length;
    const policy = state.production.updatePolicy;
    const failurePercent = samples.length ? failed * 100 / samples.length : 0;
    if (!policy.autoRollback || samples.length < policy.minimumSamples || failurePercent < policy.failureThresholdPercent) return { rolledBack: false, samples: samples.length, failed, failurePercent };
    const result = Rollback(type, channel, `FAILURE_RATE_${failurePercent.toFixed(1)}`);
    return { ...result, samples: samples.length, failed, failurePercent };
}

function Rollback(type, channel, reason) {
    const manager = require('./releaseManager');
    const current = manager.GetRelease(type, channel);
    if (!current) return { ok: false, rolledBack: false, reason: 'RELEASE_NOT_FOUND' };
    if (current.rollbackTriggeredAt) return { ok: true, rolledBack: false, reason: 'ALREADY_ROLLED_BACK' };
    const previous = current.previous && current.previous.fileName ? current.previous : null;
    if (previous) {
        const failed = { ...current, enabled: false, rollbackTriggeredAt: Now(), rollbackReason: SafeField(reason) };
        const restored = { ...previous, enabled: true, rolloutPercent: 100, updatedAt: Now(), rolledBackFrom: failed.version, forceDowngradeFrom: failed.version, previous: previous.previous || null };
        state.releaseCatalog.set(`${String(type).toUpperCase()}:${String(channel).toUpperCase()}`, restored);
    } else {
        current.enabled = false;
        current.rolloutPercent = 0;
        current.rollbackTriggeredAt = Now();
        current.rollbackReason = SafeField(reason);
    }
    require('../storage/database').SaveDatabase();
    require('../storage/audit').LogEvent('UPDATE_AUTO_ROLLBACK', `${type}/${channel} ${current.version} / ${reason}`);
    setTimeout(() => { try { manager.NotifyAll(); } catch (_) {} }, 10);
    return { ok: true, rolledBack: true, restoredVersion: previous ? previous.version : '', disabledVersion: current.version };
}

function SetPolicy(input, actor) {
    state.production.updatePolicy = {
        ...state.production.updatePolicy,
        autoRollback: input.autoRollback !== false,
        startupAckSeconds: Math.max(15, Math.min(3600, Number(input.startupAckSeconds) || 60)),
        failureThresholdPercent: Math.max(1, Math.min(100, Number(input.failureThresholdPercent) || 20)),
        minimumSamples: Math.max(1, Math.min(1000, Number(input.minimumSamples) || 3)),
        updatedAt: Now(), updatedBy: SafeField(actor).slice(0, 64)
    };
    require('../storage/database').SaveDatabase();
    return { ok: true, policy: state.production.updatePolicy };
}

function Overview() {
    return { policy: { ...state.production.updatePolicy }, transactions: Array.from(state.production.updateTransactions.values()).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,500) };
}

module.exports = { Begin, Record, Evaluate, Rollback, SetPolicy, Overview };
