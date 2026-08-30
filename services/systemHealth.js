'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config/config');
const state = require('../core/state');
const { Now } = require('../core/utils');
const { HealthSnapshot } = require('./dashboard');

function FileStat(file) {
    try {
        const stat = fs.statSync(file);
        return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
    } catch (_) {
        return { exists: false, size: 0, mtimeMs: 0 };
    }
}

function DirWritable(dir) {
    try {
        fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
        return true;
    } catch (_) {
        return false;
    }
}

function BackupSnapshot() {
    try {
        const files = fs.readdirSync(config.BACKUP_DIR)
            .filter(file => file.endsWith('.json'))
            .map(file => {
                const stat = fs.statSync(path.join(config.BACKUP_DIR, file));
                return { file, size: stat.size, mtimeMs: stat.mtimeMs };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
        return {
            writable: DirWritable(config.BACKUP_DIR),
            count: files.length,
            latest: files[0] || null,
            lastRuntimeBackupAt: state.runtimeStats.lastBackupAt || 0,
            lastRuntimeBackupFile: state.runtimeStats.lastBackupFile || ''
        };
    } catch (_) {
        return { writable: false, count: 0, latest: null, lastRuntimeBackupAt: 0, lastRuntimeBackupFile: '' };
    }
}

function AuditSnapshot() {
    try {
        const files = fs.readdirSync(config.AUDIT_DIR)
            .filter(file => file.endsWith('.jsonl'))
            .map(file => {
                const stat = fs.statSync(path.join(config.AUDIT_DIR, file));
                return { file, size: stat.size, mtimeMs: stat.mtimeMs };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
        return { writable: DirWritable(config.AUDIT_DIR), count: files.length, latest: files[0] || null };
    } catch (_) {
        return { writable: false, count: 0, latest: null };
    }
}

function BuildSystemHealth() {
    const memory = process.memoryUsage();
    const activeDbFile = config.STORAGE_ENGINE === 'sqlite' ? config.SQLITE_FILE : config.DB_FILE;
    const db = FileStat(activeDbFile);
    const sqlite = config.STORAGE_ENGINE === 'sqlite' ? require('../storage/sqliteDatabase').Status() : null;
    const backup = BackupSnapshot();
    const audit = AuditSnapshot();
    let sessions = { total: 0, roles: { admin: 0, operator: 0, viewer: 0 } };
    try { sessions = require('../web/webAuth').SessionSummary(); } catch (_) {}

    return {
        time: Now(),
        overall: HealthSnapshot(),
        node: {
            version: process.version,
            pid: process.pid,
            platform: process.platform,
            arch: process.arch,
            uptimeMs: Math.floor(process.uptime() * 1000),
            rss: memory.rss,
            heapUsed: memory.heapUsed,
            heapTotal: memory.heapTotal,
            external: memory.external,
            cpuCount: os.cpus().length,
            load1m: Number((os.loadavg()[0] || 0).toFixed(2)),
            load5m: Number((os.loadavg()[1] || 0).toFixed(2)),
            load15m: Number((os.loadavg()[2] || 0).toFixed(2))
        },
        database: {
            provider: config.STORAGE_ENGINE === 'sqlite' ? 'SQLite' : 'JSON',
            file: path.basename(activeDbFile),
            exists: db.exists,
            size: db.size,
            mtimeMs: db.mtimeMs,
            dataDirWritable: DirWritable(config.DATA_DIR),
            lastSaveAt: state.runtimeStats.lastDatabaseSaveAt || db.mtimeMs || 0,
            lastSaveOk: state.runtimeStats.lastDatabaseSaveOk !== false,
            runtimeSize: state.runtimeStats.lastDatabaseSize || db.size,
            sqlite
        },
        backup,
        audit,
        web: {
            version: config.WEB_ADMIN_VERSION,
            sessionMs: config.WEB_ADMIN_SESSION_MS,
            sessions
        },
        relay: {
            connections: state.runtimeStats.totalConnections,
            serversOnline: state.servers.size,
            clientsOnline: state.clients.size,
            pendingAcks: state.pendingRequests.size,
            requestTraces: state.requestTraces.size,
            notifications: state.notifications.length,
            ackOk: state.runtimeStats.ackOk,
            ackError: state.runtimeStats.ackError,
            ackTimeout: state.runtimeStats.ackTimeout,
            ackRetries: state.runtimeStats.ackRetries,
            offlineQueue: state.offlineQueue.size,
            activeDeadLetters: Array.from(state.deadLetters.values()).filter(x => x.status === 'ACTIVE').length,
            replayedRequests: state.runtimeStats.replayedRequests,
            dequeuedRequests: state.runtimeStats.dequeuedRequests
        }
    };
}

module.exports = { BuildSystemHealth };
