# Web Admin 기능 기준표

`AdminMain.pas`는 폐기하고 아래 Web Admin 기능을 기준으로 유지한다.

| 영역 | Web Admin 기능 | 상태 |
|---|---|---|
| Session | Admin / Operator / Viewer 로그인 | 지원 |
| Dashboard | 전체 상태 / ACK / 최근 이벤트 | 지원 |
| Server | List / Detail / Tree 성격의 Client 목록 | 지원 |
| Server | Kick 60초 | 지원 |
| Server | Disable / Enable | 지원 |
| Server | Drain ON / OFF | 지원 |
| Client | List / Detail | 지원 |
| Client | Kick 60초 | 지원 |
| Client | Disable / Enable | 지원 |
| Client | Move | 지원 + 대상 Server 안전검증 |
| Client | Notice | 지원 |
| License | Create / List / Search | 지원 |
| License | Extend / Unbind / Suspend / Resume | 지원 |
| License | Reissue / Transfer / Delete | 지원 |
| License | Bulk Extend / Unbind / Suspend / Resume / Delete | 지원 |
| Audit | List / Search / Type filter | 지원 |
| Backup | Create / List / Restore / Delete | 지원 |
| Service | Start / Stop | 지원 |
| Maintenance | ON / OFF / Schedule / Clear | 지원 |
| Notice | All Clients | 지원 |
| Version | Status / Policy Apply | 지원 |

## 상태 동작

- `Kick`: 60초 동안 임시 재접속 차단.
- `Disable`: `Enable` 전까지 재접속 차단.
- `Drain ON`: 기존 연결은 유지하고 신규 Client 배정만 막음.
- `Client Move`: ONLINE + 정상 수용 가능한 Server로만 허용.
- 작업 성공 후 Web UI는 즉시 새로고침되고 SSE로 주기적으로 상태를 동기화함.

## Legacy TCP Admin

기본 비활성화. `ENABLE_LEGACY_TCP_ADMIN=1`일 때만 예전 TCP Admin 프로토콜이 열림.
