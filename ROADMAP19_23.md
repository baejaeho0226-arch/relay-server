# Operations Roadmap 19–23

Web Admin `3.4.0` · Node Relay `6.4.0` · ApkWinSock `2.6.0` · Protocol `2`

## 19 — SQLite primary

The default storage provider is the built-in Node `node:sqlite` module. The
minimum Node version is `22.13`. `relay.db` is authoritative; the legacy JSON
file is automatically imported on first boot and then maintained only as a
recovery mirror.

```text
STORAGE_ENGINE=sqlite
DATA_DIR=/data
```

The Web Admin **SQLite Storage** page shows schema version, snapshot revision,
file size, checksum-backed integrity, source instance, and normalized counts.

## 20 — Relay A/B HA

Configure reciprocal Web Admin peer URLs and the same 32+ character secret:

```text
HA_ENABLED=1
HA_INSTANCE_ID=relay-a
HA_PRIORITY=200
HA_PEER_URL=https://relay-b-admin.example.com
HA_SHARED_SECRET=<random shared secret>
HA_POLL_MS=2000
HA_FAILOVER_TIMEOUT_MS=10000
```

The latest SQLite content revision leads. Equal revisions use priority, then
instance ID. Standby rejects TCP traffic and Web mutations. Internal status
and replication endpoints require timestamped HMAC-SHA256 authentication.

Set `RELAY_BACKUP_HOST` and `RELAY_BACKUP_PORT` in both Delphi config units.
The clients rotate endpoints after connection failure or a Standby response.

## 21–23 — ApkWinSock operator UI

`ApkWinSock.pas` constructs its FMX surface entirely in source using the Web
Admin dark/green visual language. The license and send states are separate
cards. After authorization, free-form number input is hidden and unreachable;
only mutually exclusive fixed values `1` and `2` can be sent.

## Source-only update staging

WinSockServer no longer uses `ShellExecute`, `cmd.exe`, batch files, process
enumeration, or self-termination. Signed update artifacts are downloaded and
hash-verified by Delphi HTTP code, placed in the source-managed update area,
and published through an atomic `pending-update.json` manifest. Mandatory
updates report `STAGED_RESTART_REQUIRED` for the service deployment lifecycle.

## Tests

```bash
npm run check
npm run test:roadmap18
npm run test:roadmap23
```

The Roadmap 23 test launches two real Relay processes, verifies SQLite magic,
replicates a license, promotes Standby after Active shutdown, writes during
failover, restarts the priority node, verifies revision-safe synchronization,
and confirms failback.
