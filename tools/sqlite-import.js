'use strict';

// Offline migration helper using the same Node built-in SQLite engine as Relay.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const bundlePath = process.argv[2];
const outputPath = process.argv[3] || 'relay.db';
if (!bundlePath) {
    console.error('Usage: node tools/sqlite-import.js <data.json> [relay.db]');
    process.exit(2);
}

const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
if (!bundle || bundle.format !== 'relay-sqlite-migration-bundle' || !bundle.data) throw new Error('INVALID_MIGRATION_BUNDLE');
const schemaPath = path.join(path.dirname(bundlePath), 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');
const data = bundle.data;
const db = new DatabaseSync(outputPath);

db.exec(schema);
db.exec('BEGIN IMMEDIATE');
try {
    const insServer = db.prepare('INSERT INTO servers(device_key,server_id,alias,note,disabled,draining,drain_meta_json) VALUES(?,?,?,?,?,?,?)');
    for (const [deviceKey, serverId] of Object.entries(data.servers || {})) {
        insServer.run(deviceKey, serverId, data.serverAliases?.[serverId] || '', data.serverNotes?.[serverId] || '', (data.disabledServers || []).includes(serverId) ? 1 : 0, (data.drainingServers || []).includes(serverId) ? 1 : 0, JSON.stringify(data.serverDrainMeta?.[serverId] || {}));
    }
    const insClient = db.prepare('INSERT INTO clients(device_key,client_id,server_id,created_at,last_seen_at,last_auth_at,last_ip,auth_count,send_count,reconnect_count,alias,note,disabled) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const [deviceKey, c] of Object.entries(data.clients || {})) {
        insClient.run(deviceKey, c.id, c.serverId, Number(c.createdAt)||0, Number(c.lastSeenAt)||0, Number(c.lastAuthAt)||0, c.lastIP||'', Number(c.authCount)||0, Number(c.sendCount)||0, Number(c.reconnectCount)||0, data.clientAliases?.[c.id] || '', data.clientNotes?.[c.id] || '', (data.disabledClients || []).includes(c.id) ? 1 : 0);
    }
    const insLicense = db.prepare('INSERT INTO licenses(license_key,created_at,expires_at,bound_client,bound_at,last_auth_at,last_seen_at,last_ip,auth_count,send_count,suspended,memo,tags_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const [key, l] of Object.entries(data.licenses || {})) {
        insLicense.run(key, Number(l.createdAt)||0, Number(l.expiresAt)||0, l.boundClient||'', Number(l.boundAt)||0, Number(l.lastAuthAt)||0, Number(l.lastSeenAt)||0, l.lastIP||'', Number(l.authCount)||0, Number(l.sendCount)||0, l.suspended ? 1 : 0, l.memo||'', JSON.stringify(l.tags || []));
    }
    const insOverride = db.prepare('INSERT INTO feature_overrides(device_type,device_id,flags_json) VALUES(?,?,?)');
    for (const [id, flags] of Object.entries(data.serverFeatureOverrides || {})) insOverride.run('SERVER', id, JSON.stringify(flags || {}));
    for (const [id, flags] of Object.entries(data.clientFeatureOverrides || {})) insOverride.run('CLIENT', id, JSON.stringify(flags || {}));
    const insSecret = db.prepare('INSERT INTO device_secrets(device_key,secret_value,created_at,updated_at) VALUES(?,?,?,?)');
    for (const [deviceKey, secret] of Object.entries(data.deviceSecrets || {})) insSecret.run(deviceKey, String(secret || ''), 0, 0);
    const insProfile = db.prepare('INSERT INTO protocol_profiles(device_type,device_id,profile_json) VALUES(?,?,?)');
    for (const [id, p] of Object.entries(data.serverProtocolProfiles || {})) insProfile.run('SERVER', id, JSON.stringify(p || {}));
    for (const [id, p] of Object.entries(data.clientProtocolProfiles || {})) insProfile.run('CLIENT', id, JSON.stringify(p || {}));
    const insMeta = db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)');
    insMeta.run('source_db_version', String(data.version || 0));
    insMeta.run('license_revision', String(data.licenseRevision || 0));
    insMeta.run('desired_runtime_config', JSON.stringify(data.desiredRuntimeConfig || {}));
    insMeta.run('service_enabled', data.serviceEnabled ? '1' : '0');
    insMeta.run('maintenance_mode', data.maintenanceMode ? '1' : '0');
    const snapshotJson = JSON.stringify(data);
    const checksum = crypto.createHash('sha256').update(snapshotJson).digest('hex');
    db.prepare('INSERT OR REPLACE INTO state_snapshot(id,snapshot_revision,saved_at,source_instance,checksum_sha256,snapshot_json) VALUES(1,?,?,?,?,?)').run(1, Date.now(), 'offline-import', checksum, snapshotJson);
    db.exec('COMMIT');
} catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
}
console.log(JSON.stringify({ ok: true, output: outputPath, counts: bundle.counts, schemaVersion: bundle.schemaVersion }, null, 2));
db.close();
