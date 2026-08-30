'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const state = require('../core/state');
const { BuildDatabaseObject } = require('../storage/database');
const { SCHEMA_VERSION, SQLITE_SCHEMA } = require('../storage/sqliteSchema');
const { CheckCurrentDatabase } = require('./integrityCheck');

const MIGRATION_DIR = path.join(config.DATA_DIR, 'migrations');

function Counts(snapshot) {
    return {
        servers: Object.keys(snapshot.servers || {}).length,
        clients: Object.keys(snapshot.clients || {}).length,
        licenses: Object.keys(snapshot.licenses || {}).length,
        serverFeatureOverrides: Object.keys(snapshot.serverFeatureOverrides || {}).length,
        clientFeatureOverrides: Object.keys(snapshot.clientFeatureOverrides || {}).length,
        deviceSecrets: Object.keys(snapshot.deviceSecrets || {}).length
    };
}

function Status() {
    const integrity = CheckCurrentDatabase();
    const snapshot = BuildDatabaseObject();
    return {
        activeProvider: config.STORAGE_ENGINE === 'sqlite' ? 'SQLite' : 'JSON',
        targetProvider: 'SQLite',
        switched: config.STORAGE_ENGINE === 'sqlite',
        schemaVersion: SCHEMA_VERSION,
        ready: Boolean(integrity && integrity.ok && (!integrity.errors || integrity.errors.length === 0)),
        blockers: (integrity.errors || []).map(x => x.code || String(x)),
        warnings: (integrity.warnings || []).map(x => x.code || String(x)),
        counts: Counts(snapshot),
        licenseRevision: Number(state.licenseRevision) || 0,
        dataDir: config.DATA_DIR,
        strategy: 'SQLITE_PRIMARY_JSON_AUTO_IMPORT_RECOVERY_MIRROR',
        sqlite: config.STORAGE_ENGINE === 'sqlite' ? require('../storage/sqliteDatabase').Status() : null,
        note: config.STORAGE_ENGINE === 'sqlite' ? 'SQLite is authoritative. JSON is maintained only as a recovery mirror.' : 'JSON compatibility mode is enabled by STORAGE_ENGINE=json.'
    };
}

function CanonicalBundle() {
    const snapshot = BuildDatabaseObject();
    return {
        format: 'relay-sqlite-migration-bundle',
        bundleVersion: 1,
        schemaVersion: SCHEMA_VERSION,
        createdAt: Date.now(),
        sourceProvider: config.STORAGE_ENGINE === 'sqlite' ? 'SQLite' : 'JSON',
        targetProvider: 'SQLite',
        counts: Counts(snapshot),
        data: snapshot
    };
}

function ExportBundle() {
    const status = Status();
    if (!status.ready) return { ok: false, reason: 'DATABASE_INTEGRITY_FAILED', status };
    fs.mkdirSync(MIGRATION_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const dir = path.join(MIGRATION_DIR, `sqlite-${stamp}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const bundle = CanonicalBundle();
    const json = JSON.stringify(bundle, null, 2);
    const checksum = crypto.createHash('sha256').update(json).digest('hex');
    fs.writeFileSync(path.join(dir, 'schema.sql'), SQLITE_SCHEMA, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'data.json'), json, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'SHA256.txt'), `${checksum}  data.json\n`, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'README.txt'), [
        'Relay SQLite Migration Preparation Bundle',
        '',
        'This bundle is a portable snapshot of the active Relay database.',
        'SECURITY: data.json contains license data and Device HMAC secrets. Protect it like the production database.',
        '1. Verify SHA256.txt against data.json.',
        '2. Create a new SQLite DB using schema.sql.',
        '3. Import data.json with tools/sqlite-import.js on a copy/staging environment.',
        '4. Compare row counts and integrity before any future cutover.',
        '',
        `Schema version: ${SCHEMA_VERSION}`,
        `Created: ${new Date(bundle.createdAt).toISOString()}`
    ].join('\n'), { encoding: 'utf8', mode: 0o600 });
    return { ok: true, directory: path.basename(dir), checksum, counts: bundle.counts, schemaVersion: SCHEMA_VERSION };
}

function Schema() { return { version: SCHEMA_VERSION, sql: SQLITE_SCHEMA }; }

module.exports = { MIGRATION_DIR, Status, CanonicalBundle, ExportBundle, Schema };
