# Relay Operations Roadmap 11-14

Web Admin: 2.7.0  
Node package: 5.1.0  
Relay Protocol: 2

## 11. Primary / Backup Server Binding

- Persistent Client-specific Primary and Backup Server assignment.
- Explicit Backup is selected before automatic fallback candidates.
- `allowAutomaticFallback=false` limits failover to the configured Backup.
- Manual Client Move becomes the new authoritative Primary.
- Active failover records keep the Primary binding and Auto Return behavior.

## 12. Offline Queue

- Global policy defaults OFF and requires per-Client opt-in.
- FIFO order is enforced independently for every Client.
- Queue capacity, TTL, and delivery-attempt limits are configurable.
- The same Request ID is used when a queued request is delivered, preserving WinSockServer RequestCache idempotency.
- Queue state survives Node restart in the JSON database.
- Android understands `QUEUED|OK|requestId|position` and `DEQUEUED|requestId|serverId`.

## 13. Request Replay

- Web Request Trace exposes Replay only for ERROR/TIMEOUT/DLQ states.
- Every Replay receives a new server-generated Request ID.
- `source` and `replayOf` maintain the trace relationship.
- Admin Replay ACK is not injected into the Android Client's active UI request state.

## 14. Dead Letter Queue

- Captures processing errors, ACK timeouts, server-offline failures, and expired/failed queued requests.
- Web Admin supports Retry and Discard.
- Retry always generates a new Request ID.
- Resolved records remain persisted for audit purposes.

## Safety defaults

- Emergency Failover: OFF.
- Offline Queue: OFF.
- Per-Client Failover and Offline Queue opt-in sets: empty.
- Explicit Binding automatic fallback: OFF unless selected by an administrator.
- Maintenance mode pauses automatic Failover and Offline Queue delivery.

## Verification

```text
node scripts/check-modules.js
node scripts/test-roadmap11-14.js
```

The end-to-end test uses temporary ports/data and verifies explicit Backup failover, FIFO delivery after recovery, new Request IDs for Replay, DLQ retry, and persistence across Node restart.
