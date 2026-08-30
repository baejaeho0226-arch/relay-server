# Operations Roadmap 15–18

Web Admin `2.8.0` · Node `5.2.0` · Protocol `2`

## Number Processing

`Number Processing` manages the DEFAULT processor policy and shows per-
processor ACK statistics. The Node sends policy only after WinSockServer
advertises `PROCESSOR_POLICY`.

Packet:

```text
PROCESSOR_CONFIG|revision|enabled|processor|min|max|blockedCsv
PROCESSOR_CONFIG_ACK|revision|OK|processor
```

Minimum/maximum may be empty (`~` on the wire). Values are signed Int64 strings. A rule failure
returns `NUMBER_BELOW_MIN`, `NUMBER_ABOVE_MAX`, or `NUMBER_BLOCKED`.

## PWA Push

Generate a VAPID pair once and retain it across deployments:

```bash
npx web-push generate-vapid-keys
```

Railway variables:

```text
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:operations@example.com
```

Open `Push / Daily Report` over HTTPS and press `이 브라우저 구독`.
WARNING and CRITICAL Notification Center events are pushed automatically.

## Daily Health

Optional variables:

```text
DAILY_REPORT_TIMEZONE=Asia/Seoul
DAILY_REPORT_RETENTION_DAYS=365
```

The report rolls over at midnight in the selected timezone. The current day
can also be saved manually from Web Admin.
