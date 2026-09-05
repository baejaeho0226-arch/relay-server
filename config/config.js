'use strict';

const path = require('path');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const HEALTH_PORT = Number(process.env.HEALTH_PORT || 0);
const WEB_ADMIN_PORT = Number(process.env.WEB_ADMIN_PORT || 8080);
const WEB_ADMIN_SESSION_MS = Number(process.env.WEB_ADMIN_SESSION_MS || 30 * 60 * 1000);
const ENABLE_LEGACY_TCP_ADMIN = String(process.env.ENABLE_LEGACY_TCP_ADMIN || '') === '1';
const WEB_ADMIN_VERSION = '3.5.2';
const WEB_UI_REVISION = 'fix7a';
const UPDATE_BASE_URL = String(process.env.UPDATE_BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/+$/, '');

const DATA_DIR = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.resolve(__dirname, '..');
const DB_FILE = path.join(DATA_DIR, 'relay-identities.json');
const DB_BAK_FILE = path.join(DATA_DIR, 'relay-identities.bak.json');
const SQLITE_FILE = path.join(DATA_DIR, 'relay.db');
const STORAGE_ENGINE = String(process.env.STORAGE_ENGINE || 'sqlite').toLowerCase() === 'json' ? 'json' : 'sqlite';
const LICENSE_SNAPSHOT_FILE = path.join(DATA_DIR, 'relay-licenses.json');
const LICENSE_SNAPSHOT_BAK_FILE = path.join(DATA_DIR, 'relay-licenses.bak.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const AUDIT_DIR = path.join(DATA_DIR, 'audit');

const CURRENT_PROTOCOL_VERSION = 2;
const DEFAULT_MIN_PROTOCOL_VERSION = Number(process.env.MIN_PROTOCOL_VERSION || 1);
const DEFAULT_MIN_SERVER_VERSION = String(process.env.MIN_SERVER_VERSION || '1.0.0');
const DEFAULT_MIN_CLIENT_VERSION = String(process.env.MIN_CLIENT_VERSION || '1.0.0');

const ADMIN_CREDENTIALS = {
    admin: String(process.env.ADMIN_SECRET || ''),
    operator: String(process.env.OPERATOR_SECRET || ''),
    viewer: String(process.env.VIEWER_SECRET || '')
};

const ADMIN_AUTH_WINDOW_SECONDS = 60;
const ADMIN_SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const CONFIRM_TOKEN_TTL_MS = 60 * 1000;

const SERVER_KICK_BLOCK_MS = 60 * 1000;
const CLIENT_KICK_BLOCK_MS = 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 30);
// Product invariant: one APK is paired with exactly one WinSockServer.
// This is intentionally not environment-overridable; increasing it would
// silently reconnect several waiting APKs to the first PC that comes online.
const MAX_CLIENTS_PER_SERVER = 1;

const REQUEST_HISTORY_TIMEOUT_MS = 10 * 60 * 1000;
const ACK_RETRY_MS = 3000;
const ACK_TIMEOUT_MS = 10000;
const ACK_MAX_RETRIES = 2;
const OFFLINE_QUEUE_PROCESS_LIMIT = Math.max(1, Number(process.env.OFFLINE_QUEUE_PROCESS_LIMIT || 50));
const MAX_OFFLINE_QUEUE_ITEMS = Math.max(100, Number(process.env.MAX_OFFLINE_QUEUE_ITEMS || 5000));
const MAX_DEAD_LETTERS = Math.max(100, Number(process.env.MAX_DEAD_LETTERS || 5000));

const MAX_INPUT_BUFFER = 64 * 1024;
const MAX_BULK_KEYS = 500;
const MAX_SEARCH_RESULTS = 500;
const MAX_EVENT_MEMORY = 2000;
const MAX_REQUEST_TRACES = 2000;
const MAX_NOTIFICATIONS = 500;
const NOTIFICATION_DEDUPE_MS = 60 * 1000;
const RECONNECT_WINDOW_MS = 5 * 60 * 1000;
const RECONNECT_FLAPPING_THRESHOLD = 5;
const RECONNECT_ALERT_COOLDOWN_MS = 5 * 60 * 1000;
const AUTO_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_BACKUPS = 30;
const DAILY_REPORT_TIMEZONE = String(process.env.DAILY_REPORT_TIMEZONE || 'Asia/Seoul');
const DAILY_REPORT_RETENTION_DAYS = Math.max(30, Number(process.env.DAILY_REPORT_RETENTION_DAYS || 365));
const VAPID_PUBLIC_KEY = String(process.env.VAPID_PUBLIC_KEY || '');
const VAPID_PRIVATE_KEY = String(process.env.VAPID_PRIVATE_KEY || '');
const VAPID_SUBJECT = String(process.env.VAPID_SUBJECT || 'mailto:relay-admin@example.invalid');

const HA_ENABLED = String(process.env.HA_ENABLED || '') === '1';
const HA_INSTANCE_ID = String(process.env.HA_INSTANCE_ID || process.env.RAILWAY_REPLICA_ID || 'relay-a').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'relay-a';
const HA_PRIORITY = Math.max(1, Math.min(1000, Number(process.env.HA_PRIORITY || 100)));
const HA_PEER_URL = String(process.env.HA_PEER_URL || '').replace(/\/+$/, '');
const HA_SHARED_SECRET = String(process.env.HA_SHARED_SECRET || '');
const HA_POLL_MS = Math.max(500, Number(process.env.HA_POLL_MS || 2000));
const HA_FAILOVER_TIMEOUT_MS = Math.max(3000, Number(process.env.HA_FAILOVER_TIMEOUT_MS || 10000));

const QR_AUTH_TTL_MS = 60 * 1000;
const QR_AUTH_MAX_IMAGE_BYTES = Math.max(512 * 1024, Math.min(12 * 1024 * 1024, Number(process.env.QR_AUTH_MAX_IMAGE_BYTES || 8 * 1024 * 1024)));
const QR_AUTH_MAX_REQUESTS = Math.max(100, Math.min(5000, Number(process.env.QR_AUTH_MAX_REQUESTS || 500)));
const QR_AUTH_DEFAULT_DAYS = Math.max(1, Math.min(3650, Number(process.env.QR_AUTH_DEFAULT_DAYS || 30)));
const QR_APPROVAL_SECRET = String(process.env.QR_APPROVAL_SECRET || '');

const buildWaitTtlInput = Number(process.env.BUILD_GATE_WAIT_TTL_MS || 30 * 60 * 1000);
const sessionTtlInput = Number(process.env.BUILD_SESSION_TTL_MINUTES || 30);
const sessionHistoryInput = Number(process.env.MAX_BUILD_SESSION_HISTORY || 2000);
const BUILD_WAIT_TTL_MS = Math.max(60 * 1000, Math.min(24 * 60 * 60 * 1000,
    Number.isFinite(buildWaitTtlInput) ? buildWaitTtlInput : 30 * 60 * 1000));
const DEFAULT_BUILD_SESSION_TTL_MINUTES = Math.max(1, Math.min(1440,
    Number.isFinite(sessionTtlInput) ? Math.trunc(sessionTtlInput) : 30));
const MAX_BUILD_SESSION_HISTORY = Math.max(100, Math.min(10000,
    Number.isFinite(sessionHistoryInput) ? Math.trunc(sessionHistoryInput) : 2000));

const DANGEROUS_PREFIXES = [
    'SERVICE_STOP',
    'BACKUP_RESTORE|',
    'LIC_BULK_DELETE|',
    'SERVER_DISABLE|',
    'CLIENT_DISABLE|',
    'VERSION_SET|'
];

module.exports = {
    HOST, PORT, HEALTH_PORT, WEB_ADMIN_PORT, WEB_ADMIN_SESSION_MS, ENABLE_LEGACY_TCP_ADMIN, WEB_ADMIN_VERSION, WEB_UI_REVISION, UPDATE_BASE_URL,
    DATA_DIR, DB_FILE, DB_BAK_FILE, SQLITE_FILE, STORAGE_ENGINE, LICENSE_SNAPSHOT_FILE, LICENSE_SNAPSHOT_BAK_FILE, BACKUP_DIR, AUDIT_DIR,
    CURRENT_PROTOCOL_VERSION,
    DEFAULT_MIN_PROTOCOL_VERSION, DEFAULT_MIN_SERVER_VERSION, DEFAULT_MIN_CLIENT_VERSION,
    ADMIN_CREDENTIALS, ADMIN_AUTH_WINDOW_SECONDS, ADMIN_SESSION_TIMEOUT_MS, CONFIRM_TOKEN_TTL_MS,
    SERVER_KICK_BLOCK_MS, CLIENT_KICK_BLOCK_MS,
    RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, MAX_CLIENTS_PER_SERVER,
    REQUEST_HISTORY_TIMEOUT_MS, ACK_RETRY_MS, ACK_TIMEOUT_MS, ACK_MAX_RETRIES,
    OFFLINE_QUEUE_PROCESS_LIMIT, MAX_OFFLINE_QUEUE_ITEMS, MAX_DEAD_LETTERS,
    MAX_INPUT_BUFFER, MAX_BULK_KEYS, MAX_SEARCH_RESULTS, MAX_EVENT_MEMORY, MAX_REQUEST_TRACES,
    MAX_NOTIFICATIONS, NOTIFICATION_DEDUPE_MS, RECONNECT_WINDOW_MS, RECONNECT_FLAPPING_THRESHOLD, RECONNECT_ALERT_COOLDOWN_MS,
    AUTO_BACKUP_INTERVAL_MS, MAX_BACKUPS,
    DAILY_REPORT_TIMEZONE, DAILY_REPORT_RETENTION_DAYS,
    VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT,
    HA_ENABLED, HA_INSTANCE_ID, HA_PRIORITY, HA_PEER_URL, HA_SHARED_SECRET, HA_POLL_MS, HA_FAILOVER_TIMEOUT_MS,
    QR_AUTH_TTL_MS, QR_AUTH_MAX_IMAGE_BYTES, QR_AUTH_MAX_REQUESTS, QR_AUTH_DEFAULT_DAYS, QR_APPROVAL_SECRET,
    BUILD_WAIT_TTL_MS, DEFAULT_BUILD_SESSION_TTL_MINUTES, MAX_BUILD_SESSION_HISTORY,
    DANGEROUS_PREFIXES
};
