'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config/config');
const { SCHEMA_VERSION, SQLITE_SCHEMA } = require('./sqliteSchema');

let database = null;

function Checksum(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function Open() {
    if (database) return database;
    fs.mkdirSync(path.dirname(config.SQLITE_FILE), { recursive: true });
    database = new DatabaseSync(config.SQLITE_FILE);
    database.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;');
    database.exec(SQLITE_SCHEMA);
    database.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('schema_version', String(SCHEMA_VERSION));
    database.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('provider', 'sqlite');
    return database;
}

function InsertNormalized(db, snapshot) {
    db.exec('DELETE FROM clients; DELETE FROM servers; DELETE FROM licenses; DELETE FROM device_secrets; DELETE FROM feature_overrides; DELETE FROM protocol_profiles;');
    const serverInsert = db.prepare('INSERT INTO servers(device_key,server_id,alias,note,disabled,draining,drain_meta_json) VALUES(?,?,?,?,?,?,?)');
    for (const [deviceKey, serverId] of Object.entries(snapshot.servers || {})) {
        serverInsert.run(deviceKey, serverId, (snapshot.serverAliases || {})[serverId] || '', (snapshot.serverNotes || {})[serverId] || '', (snapshot.disabledServers || []).includes(serverId) ? 1 : 0, (snapshot.drainingServers || []).includes(serverId) ? 1 : 0, JSON.stringify((snapshot.serverDrainMeta || {})[serverId] || {}));
    }
    const clientInsert = db.prepare('INSERT INTO clients(device_key,client_id,server_id,created_at,last_seen_at,last_auth_at,last_ip,auth_count,send_count,reconnect_count,alias,note,disabled) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const [deviceKey, value] of Object.entries(snapshot.clients || {})) {
        clientInsert.run(deviceKey, value.id || value.clientId, value.serverId, Number(value.createdAt) || 0, Number(value.lastSeenAt) || 0, Number(value.lastAuthAt) || 0, String(value.lastIP || ''), Number(value.authCount) || 0, Number(value.sendCount) || 0, Number(value.reconnectCount) || 0, (snapshot.clientAliases || {})[value.id || value.clientId] || '', (snapshot.clientNotes || {})[value.id || value.clientId] || '', (snapshot.disabledClients || []).includes(value.id || value.clientId) ? 1 : 0);
    }
    const licenseInsert = db.prepare('INSERT INTO licenses(license_key,created_at,expires_at,bound_client,bound_at,last_auth_at,last_seen_at,last_ip,auth_count,send_count,suspended,memo,tags_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const [key, value] of Object.entries(snapshot.licenses || {})) {
        licenseInsert.run(key, Number(value.createdAt) || 0, Number(value.expiresAt) || 0, String(value.boundClient || ''), Number(value.boundAt) || 0, Number(value.lastAuthAt) || 0, Number(value.lastSeenAt) || 0, String(value.lastIP || ''), Number(value.authCount) || 0, Number(value.sendCount) || 0, value.suspended ? 1 : 0, String(value.memo || ''), JSON.stringify(value.tags || []));
    }
    const secretInsert = db.prepare('INSERT INTO device_secrets(device_key,secret_value,created_at,updated_at) VALUES(?,?,?,?)');
    for (const [key, secret] of Object.entries(snapshot.deviceSecrets || {})) {
        const meta = (snapshot.deviceSecretMeta || {})[key] || {};
        secretInsert.run(key, secret, Number(meta.createdAt) || 0, Number(meta.rotatedAt) || 0);
    }
    const featureInsert = db.prepare('INSERT INTO feature_overrides(device_type,device_id,flags_json) VALUES(?,?,?)');
    for (const [type, source] of [['SERVER', snapshot.serverFeatureOverrides], ['CLIENT', snapshot.clientFeatureOverrides]]) {
        for (const [id, flags] of Object.entries(source || {})) featureInsert.run(type, id, JSON.stringify(flags || {}));
    }
    const protocolInsert = db.prepare('INSERT INTO protocol_profiles(device_type,device_id,profile_json) VALUES(?,?,?)');
    for (const [type, source] of [['SERVER', snapshot.serverProtocolProfiles], ['CLIENT', snapshot.clientProtocolProfiles]]) {
        for (const [id, profile] of Object.entries(source || {})) protocolInsert.run(type, id, JSON.stringify(profile || {}));
    }
}

function SaveSnapshot(snapshot, options = {}) {
    const db = Open();
    const text = JSON.stringify(snapshot);
    const checksum = Checksum(text);
    const savedAt = Date.now();
    const previous = db.prepare('SELECT snapshot_revision,checksum_sha256 FROM state_snapshot WHERE id=1').get();
    const previousRevision = Number(previous && previous.snapshot_revision) || 0;
    const contentRevision = previous && previous.checksum_sha256 === checksum ? previousRevision : previousRevision + 1;
    const revision = Math.max(Number(options.revision) || 0, contentRevision || 1);
    db.exec('BEGIN IMMEDIATE');
    try {
        InsertNormalized(db, snapshot);
        db.prepare('INSERT INTO state_snapshot(id,snapshot_revision,saved_at,source_instance,checksum_sha256,snapshot_json) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET snapshot_revision=excluded.snapshot_revision,saved_at=excluded.saved_at,source_instance=excluded.source_instance,checksum_sha256=excluded.checksum_sha256,snapshot_json=excluded.snapshot_json').run(revision, savedAt, String(options.sourceInstance || config.HA_INSTANCE_ID || ''), checksum, text);
        db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('last_saved_at', String(savedAt));
        db.exec('COMMIT');
    } catch (error) {
        try { db.exec('ROLLBACK'); } catch (_) {}
        throw error;
    }
    return { revision, savedAt, checksum, size: Buffer.byteLength(text) };
}

function LoadSnapshot() {
    const row = Open().prepare('SELECT snapshot_revision,saved_at,source_instance,checksum_sha256,snapshot_json FROM state_snapshot WHERE id=1').get();
    if (!row) return null;
    if (Checksum(row.snapshot_json) !== row.checksum_sha256) throw new Error('SQLITE_SNAPSHOT_CHECKSUM_MISMATCH');
    return { revision: Number(row.snapshot_revision), savedAt: Number(row.saved_at), sourceInstance: row.source_instance, checksum: row.checksum_sha256, data: JSON.parse(row.snapshot_json) };
}

function Status() {
    try {
        const db = Open();
        const quick = db.prepare('PRAGMA quick_check').get();
        const row = db.prepare('SELECT snapshot_revision,saved_at,source_instance,checksum_sha256 FROM state_snapshot WHERE id=1').get() || {};
        const stat = fs.statSync(config.SQLITE_FILE);
        return { ok: Object.values(quick || {})[0] === 'ok', file: path.basename(config.SQLITE_FILE), size: stat.size, schemaVersion: SCHEMA_VERSION, revision: Number(row.snapshot_revision) || 0, savedAt: Number(row.saved_at) || 0, sourceInstance: row.source_instance || '', checksum: row.checksum_sha256 || '' };
    } catch (error) {
        return { ok: false, file: path.basename(config.SQLITE_FILE), size: 0, schemaVersion: SCHEMA_VERSION, revision: 0, savedAt: 0, sourceInstance: '', checksum: '', error: error.message };
    }
}

function Close() {
    if (!database) return;
    database.close();
    database = null;
}

module.exports = { Open, SaveSnapshot, LoadSnapshot, Status, Close };
