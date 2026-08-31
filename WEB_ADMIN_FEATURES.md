# Web Admin Feature Matrix // v3.4.0

01. Live Event Console
02. Request Trace
03. Server / Client Alias
04. Real-time Health Monitor
05. Reconnect Flapping Detection
06. Notification Center
07. License Expiry Dashboard
08. License Tags
09. Server / Client Notes
10. Admin Activity
11. Web Admin Session Management
12. System Health
13. DB Integrity Check
14. Backup Verify
15. Dashboard Statistics
16. Ctrl+K Global Command Palette
17. Quick Command Terminal (allowlist only, no OS shell)
18. Server Client Distribution
19. Graceful Drain UX (persistent progress / READY notification)
20. Danger Zone (Service Stop / Backup Restore+Delete / Version Apply / Bulk License Delete)
21. Primary / Backup Server Binding (explicit backup first, optional automatic fallback)
22. Offline Queue (global OFF by default, per-client opt-in, FIFO, TTL and attempt limits)
23. Request Replay (ERROR/TIMEOUT only, always generates a new Request ID)
24. Dead Letter Queue (ACK timeout / server offline / process error, retry or discard with audit history)
25. SQLite authoritative storage with automatic JSON import and recovery mirror
26. Relay A/B Active/Standby status, HMAC replication, promotion and revision-safe failback
27. Source-built ApkWinSock dark/green operator UI
28. Clean license authorization card
29. Fixed-value 1/2 checkbox transmission UI

Legacy TCP Admin remains disabled by default. Relay protocol stays at Protocol 2 / App 2.2.0. Android adds optional QUEUED/DEQUEUED and Relay endpoint failover without changing the CONNECT/SEND/ACK handshake.
