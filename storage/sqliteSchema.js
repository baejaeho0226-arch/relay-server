'use strict';

const SCHEMA_VERSION = 2;

const SQLITE_SCHEMA = `PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS state_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  snapshot_revision INTEGER NOT NULL,
  saved_at INTEGER NOT NULL,
  source_instance TEXT NOT NULL DEFAULT '',
  checksum_sha256 TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS servers (
  device_key TEXT PRIMARY KEY,
  server_id TEXT NOT NULL UNIQUE,
  alias TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  disabled INTEGER NOT NULL DEFAULT 0,
  draining INTEGER NOT NULL DEFAULT 0,
  drain_meta_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS clients (
  device_key TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  server_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  last_auth_at INTEGER NOT NULL DEFAULT 0,
  last_ip TEXT NOT NULL DEFAULT '',
  auth_count INTEGER NOT NULL DEFAULT 0,
  send_count INTEGER NOT NULL DEFAULT 0,
  reconnect_count INTEGER NOT NULL DEFAULT 0,
  alias TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  disabled INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(server_id) REFERENCES servers(server_id)
);

CREATE INDEX IF NOT EXISTS idx_clients_server_id ON clients(server_id);

CREATE TABLE IF NOT EXISTS licenses (
  license_key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  bound_client TEXT NOT NULL DEFAULT '',
  bound_at INTEGER NOT NULL DEFAULT 0,
  last_auth_at INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  last_ip TEXT NOT NULL DEFAULT '',
  auth_count INTEGER NOT NULL DEFAULT 0,
  send_count INTEGER NOT NULL DEFAULT 0,
  suspended INTEGER NOT NULL DEFAULT 0,
  memo TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_licenses_bound_client ON licenses(bound_client);
CREATE INDEX IF NOT EXISTS idx_licenses_expires_at ON licenses(expires_at);

CREATE TABLE IF NOT EXISTS device_secrets (
  device_key TEXT PRIMARY KEY,
  secret_value TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS feature_overrides (
  device_type TEXT NOT NULL,
  device_id TEXT NOT NULL,
  flags_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(device_type, device_id)
);

CREATE TABLE IF NOT EXISTS protocol_profiles (
  device_type TEXT NOT NULL,
  device_id TEXT NOT NULL,
  profile_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(device_type, device_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_time INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_events(event_time);
CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events(event_type);

PRAGMA user_version = ${SCHEMA_VERSION};
`;

module.exports = { SCHEMA_VERSION, SQLITE_SCHEMA };
