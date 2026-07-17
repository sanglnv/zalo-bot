## Runbook: Triggers & Quota Monitoring — Zalo Clawbot

**Owner:** Sang (Le Nguyen Vinh Sang) | **Frequency:** Weekly, plus after any deploy that touches triggers
**Last Updated:** 2026-07-17 | **Last Run:** —

### Purpose

Verify that the project's installable triggers are healthy and that GAS usage is staying inside quota, before quota exhaustion silently breaks payment expiry, Telegram delivery, or the staff confirmation menu.

### Prerequisites

- [ ] Editor access to the Apps Script project (`clasp open` or Apps Script editor URL)
- [ ] Access to the backing Google Sheet (`SPREADSHEET_ID`) — tabs `OperationMetrics`, `ErrorLogs`
- [ ] Knowledge of account tier: consumer Gmail vs Google Workspace (quota ceilings differ)
- [ ] `clasp` CLI installed and authenticated, repo cloned locally

### Current known triggers (from source)

| Handler function | Type | Schedule | Registered by |
|---|---|---|---|
| `scanAndExpireStalePayments` | Time-driven | Every 10 minutes | `registerPaymentExpiryTrigger()` in `src/admin/PaymentExpiry.gs` |
| Staff Sheet menu handler | Installable open trigger | On spreadsheet open | `registerSheetMenuTrigger()` |

Both registration functions are idempotent — safe to re-run, they will not create duplicates (checked via `ScriptApp.getProjectTriggers()`).

### Procedure

#### Step 1: List active triggers

```
Apps Script editor → Triggers (clock icon in left sidebar)
```
**Expected result:** Exactly one `scanAndExpireStalePayments` (every 10 min) and one open-trigger for the Sheet menu. No duplicates, no triggers pointing at removed/renamed functions.
**If it fails:** Delete duplicate or orphaned triggers manually, then re-run `registerPaymentExpiryTrigger()` / `registerSheetMenuTrigger()` from the editor to restore the canonical single trigger.

#### Step 2: Check trigger execution history for failures

```
Apps Script editor → Executions (left sidebar) → filter by function name, last 7 days
```
**Expected result:** `scanAndExpireStalePayments` runs roughly every 10 minutes with `Completed` status. No `Failed` entries.
**If it fails:** Open the failed execution, read the stack trace. Cross-check `ErrorLogs` sheet for the same timestamp — entries there include `context`, `message`, `stack`. A recurring `Could not acquire script lock within 30 seconds` (see `SheetRepositorySupport.withScriptLock`, 30s timeout) indicates lock contention — check for overlapping long-running operations rather than a quota issue.

#### Step 3: Review `OperationMetrics` for duration drift

```
Open the Sheet → OperationMetrics tab → sort/filter by operation, look at last 7 days of durationMs
```
**Expected result:** `doPost`, `confirmSelectedOrderPayment`, and `scanAndExpireStalePayments` durations are stable relative to their historical baseline. This is raw data, not a dashboard — eyeball the trend.
**If it fails:** A steady upward trend in `durationMs` (especially for `scanAndExpireStalePayments`, which processes up to 50 orders per run) is the leading indicator of approaching the 6-minute per-execution ceiling. Investigate before it starts truncating batches.

#### Step 4: Check quota usage against known ceilings

```
Apps Script editor → Project Settings → or Google Cloud Console → APIs & Services → Quotas (if project is linked to a GCP project)
```
**Expected result:** Usage comfortably under the limits below.

| Quota | Consumer (gmail.com) | Google Workspace |
|---|---|---|
| Max execution time per run | 6 minutes | 6 minutes |
| Total trigger runtime per day | 90 minutes | 6 hours |
| Time-driven triggers per script | 20 | 20 |
| `UrlFetchApp` calls per day | 20,000 | 100,000 |

Source: [Quotas for Google Services — Apps Script, Google for Developers](https://developers.google.com/apps-script/guides/services/quotas)

**Rough math for this project:** `scanAndExpireStalePayments` firing every 10 minutes is 144 runs/day. If each run stays well under a few seconds, cumulative trigger runtime is nowhere near the 90-minute (consumer) ceiling. Each webhook `doPost` and the expiry scan issue `UrlFetchApp` calls (Telegram Bot API, ZBS Template API) — at low order volume this is far from 20,000/day, but re-check the math if daily order volume grows materially.

**If it fails / usage is climbing:** Identify which operation dominates (`OperationMetrics` + `UrlFetchApp` call sites: `TelegramClient.gs`, `ZaloClient.gs`, `ZbsTemplateClient.gs`, `FastPathPaymentClient.gs`). Consider raising `PAYMENT_TIMEOUT_MINUTES` / lowering scan frequency, or moving high-frequency work to the Cloudflare Worker/Durable Object fast path (see `docs/latency-observability.md`) rather than the GAS trigger.

#### Step 5: Confirm webhook health (Telegram side)

```
Apps Script editor → run healthCheck() from src/admin/SystemSetup.gs
```
**Expected result:** JSON output with `telegramWebhook.status: "ok"` and `pendingUpdates: 0`. `configuration` and `sheets` both report OK.
**If it fails:** `status: "misconfigured"` means the live Telegram webhook URL no longer matches `TELEGRAM_WEBHOOK_URL` script property — re-register via the Telegram Bot API `setWebhook`. `pendingUpdates > 0` for a sustained period means GAS isn't draining the queue fast enough — check Step 3 for duration drift first.

### Verification

- [ ] Triggers list has no duplicates or orphans
- [ ] No `Failed` executions in the last 7 days (or all explained/resolved)
- [ ] `OperationMetrics` durations flat/expected, not trending toward 6 min
- [ ] Quota usage stays under consumer/Workspace ceilings in the table above
- [ ] `healthCheck()` returns all-OK

### Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| Duplicate `scanAndExpireStalePayments` triggers | Manual re-run of registration without checking `ScriptApp.getProjectTriggers()` first (shouldn't happen — function is idempotent) | Delete extras in Triggers UI, keep one |
| `Could not acquire script lock within 30 seconds` in `ErrorLogs` | Long-running operation holding `LockService.getScriptLock()` (see `SheetRepositorySupport.withScriptLock`, `LOCK_TIMEOUT_MS = 30000`) | Check concurrent executions in the Executions log at that timestamp; look for an abnormally slow `doPost` or expiry scan blocking others |
| `expired_but_notification_failed` entries piling up in logs | Telegram/ZBS API outage or bad token, not a quota issue | Check `ErrorLogs` `stage: "expiry_notification_dispatch"` for the underlying delivery error; orders are still correctly expired |
| `scanAndExpireStalePayments` execution time climbing toward 6 min | Order volume growing past what 50-per-run batching can clear in time, or a slow Sheet read | Reduce `batchLimit` impact by increasing trigger frequency isn't an option (fixed at 10 min in code) — consider indexing/filtering `Orders` more efficiently, or plan the fast-path migration noted in `docs/latency-observability.md` |
| `pendingUpdates > 0` from `healthCheck()` persistently | GAS webhook processing slower than Telegram delivery rate, or webhook URL mismatch | Confirm `TELEGRAM_WEBHOOK_URL` matches live webhook; check execution durations (Step 3) |

### Rollback

Trigger/quota monitoring is read-only by default. If Step 1 required deleting a duplicate trigger and it turns out to have been the live one:
1. Re-run `registerPaymentExpiryTrigger()` (payment expiry) or `registerSheetMenuTrigger()` (staff menu) from the Apps Script editor — both are idempotent and safe.
2. Confirm via Step 1 that exactly one trigger per handler exists again.

### Escalation

Solo-maintained project — no formal on-call. If a quota hard-stop is hit in production (script throws quota exception), the fastest mitigation is:
- Temporarily raise `PAYMENT_TIMEOUT_MINUTES` to reduce scan frequency's relative load, or
- Manually delete the time-driven trigger via the editor to stop the bleeding while investigating, then re-register once fixed.

### History

| Date | Run By | Notes |
|---|---|---|
| — | — | First version of this runbook, no run logged yet |
