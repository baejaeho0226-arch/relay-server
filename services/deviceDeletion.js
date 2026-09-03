'use strict';

const crypto = require('crypto');
const state = require('../core/state');
const { NormalizeID, Now, SafeField, SendLine } = require('../core/utils');

function Type(value) {
    value = String(value || '').toUpperCase();
    return value === 'SERVER' || value === 'CLIENT' ? value : '';
}

function Fingerprint(type, deviceKey) {
    type = Type(type);
    deviceKey = String(deviceKey || '').trim();
    if (!type || !deviceKey) return '';
    return crypto.createHash('sha256').update(`${type}\0${deviceKey}`, 'utf8').digest('hex').toUpperCase();
}

function MapKey(type, deviceKey) {
    const hash = Fingerprint(type, deviceKey);
    return hash ? `${Type(type)}:${hash}` : '';
}

function Public(record) {
    if (!record) return null;
    return {
        tombstoneId: record.tombstoneId,
        type: record.type,
        lastId: record.lastId,
        deviceRef: record.deviceRef,
        deletedAt: record.deletedAt,
        deletedBy: record.deletedBy,
        blockedAttempts: Number(record.blockedAttempts || 0),
        lastBlockedAt: Number(record.lastBlockedAt || 0)
    };
}

function Add(type, deviceKey, lastId, actor = 'WEB_ADMIN') {
    type = Type(type);
    deviceKey = String(deviceKey || '').trim();
    lastId = NormalizeID(lastId);
    const key = MapKey(type, deviceKey);
    if (!key || !lastId) return null;
    const now = Now();
    const existing = state.deletedDevices.get(key);
    const record = existing || {
        tombstoneId: `DEL-${crypto.randomBytes(12).toString('hex').toUpperCase()}`,
        type,
        deviceKey,
        deviceRef: key.split(':')[1].slice(0, 16),
        lastId,
        deletedAt: now,
        deletedBy: SafeField(actor).slice(0, 64),
        blockedAttempts: 0,
        lastBlockedAt: 0
    };
    record.lastId = lastId;
    record.deletedAt = now;
    record.deletedBy = SafeField(actor).slice(0, 64);
    state.deletedDevices.set(key, record);
    return Public(record);
}

function Get(type, deviceKey) {
    const key = MapKey(type, deviceKey);
    return key ? state.deletedDevices.get(key) || null : null;
}

function IsBlocked(type, deviceKey) {
    return !!Get(type, deviceKey);
}

function RejectConnection(connection, type, deviceKey) {
    const record = Get(type, deviceKey);
    if (!record) return false;
    record.blockedAttempts = Number(record.blockedAttempts || 0) + 1;
    record.lastBlockedAt = Now();
    if (connection) {
        connection.administrativelyDeleted = true;
        connection.superseded = true;
        SendLine(connection.socket, `ERROR|DEVICE_DELETED|ADMIN_RESTORE_REQUIRED|${record.tombstoneId}`);
        setTimeout(() => { try { connection.socket.destroy(); } catch (_) {} }, 150);
    }
    // Reconnecting clients can be aggressive.  Persist counters at a bounded
    // cadence while the tombstone itself remains durable from the DELETE.
    if (record.blockedAttempts === 1 || record.blockedAttempts % 20 === 0) {
        try { require('../storage/database').SaveDatabase(); } catch (_) {}
        try { require('../storage/audit').LogEvent('DELETED_DEVICE_BLOCKED', `${record.type} ${record.lastId} ${record.deviceRef} attempts=${record.blockedAttempts}`); } catch (_) {}
    }
    return true;
}

function List(type = '') {
    type = Type(type);
    const rows = [];
    for (const record of state.deletedDevices.values()) {
        if (!record || (type && record.type !== type)) continue;
        rows.push(Public(record));
    }
    return rows.sort((a, b) => Number(b.deletedAt) - Number(a.deletedAt));
}

function Restore(tombstoneId, actor = 'WEB_ADMIN') {
    tombstoneId = String(tombstoneId || '').toUpperCase();
    for (const [key, record] of state.deletedDevices) {
        if (!record || record.tombstoneId !== tombstoneId) continue;
        state.deletedDevices.delete(key);
        // A previous rejected/pending enrollment must not keep the restored
        // installation locked for a second unrelated reason.
        state.deviceEnrollments.delete(`${record.type}:${record.deviceKey}`);
        const saved = require('../storage/database').SaveDatabase();
        if (!saved) {
            state.deletedDevices.set(key, record);
            return { ok: false, reason: 'RESTORE_PERSIST_FAILED' };
        }
        try { require('../storage/audit').LogEvent('DELETED_DEVICE_RESTORED', `${record.type} ${record.lastId} ${record.deviceRef} / ${SafeField(actor).slice(0, 64)}`); } catch (_) {}
        return { ok: true, restored: Public(record) };
    }
    return { ok: false, reason: 'DELETED_DEVICE_NOT_FOUND' };
}

function Import(raw) {
    state.deletedDevices.clear();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    for (const value of Object.values(raw).slice(0, 10000)) {
        if (!value || typeof value !== 'object') continue;
        const type = Type(value.type);
        const deviceKey = String(value.deviceKey || '').trim();
        const lastId = NormalizeID(value.lastId);
        const tombstoneId = String(value.tombstoneId || '').toUpperCase();
        const key = MapKey(type, deviceKey);
        if (!key || !lastId || !/^DEL-[0-9A-F]{24}$/.test(tombstoneId)) continue;
        state.deletedDevices.set(key, {
            tombstoneId,
            type,
            deviceKey,
            deviceRef: key.split(':')[1].slice(0, 16),
            lastId,
            deletedAt: Math.max(0, Number(value.deletedAt) || 0),
            deletedBy: SafeField(value.deletedBy).slice(0, 64),
            blockedAttempts: Math.max(0, Number(value.blockedAttempts) || 0),
            lastBlockedAt: Math.max(0, Number(value.lastBlockedAt) || 0)
        });
    }
}

module.exports = { Type, Fingerprint, Add, Get, IsBlocked, RejectConnection, List, Restore, Import, Public };
