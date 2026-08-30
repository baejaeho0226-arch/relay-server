# Relay New Series 20 - Final

Web Admin version: 2.3.0
Relay protocol remains: 2
WinSockServer target: Windows 64-bit
ApkWinSock target: Android 64-bit / ARM64

## 01-04 Central control foundation
1. Remote Command System
2. Device Info
3. Capability System
4. Configuration Sync

## 05-08 Connection quality
5. Exponential Reconnect Backoff + Jitter
6. Connection Quality Score
7. Remote Diagnostics
8. Heartbeat / Packet Loss / RTT Min-Avg-Max / Jitter

## 09-12 Processing / live client state
9. Number Processor interface/registry
10. Extended Processing Result
11. APK UI State reporting
12. Notice levels (INFO/WARNING/CRITICAL) + target groups

## 13-17 protocol/security preparation
13. License QR deep link
14. Global + per-device Feature Flags
15. Protocol v3 readiness only (no v3 cutover)
16. Per-connection Device HMAC challenge
17. Optional Event Sequence framing

## 18-20 operations / deployment
18. External Load Simulator (connect/full modes)
19. Web Admin PWA shell
20. SQLite Migration Preparation

### Important compatibility
- REGISTER and CONNECT handshakes remain Protocol 2.
- Existing License/SEND/NUMBER/ACK flow remains supported.
- Protocol 3 is NOT activated.
- Device HMAC enforcement is feature-flag controlled.
- Event Sequence is optional and capability/feature controlled.
- Active database remains JSON. SQLite is preparation/export only.

### Web fixes retained
- Web CONFIRM_REQUIRED/confirmText flow removed.
- License snapshot/revision recovery retained.
- Backup Restore revision behavior retained.
- Runtime config and feature flag persistence are independent.
