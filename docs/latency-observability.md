# Telegram latency instrumentation

Phase 1 records structured timing events without adding network or Sheet writes to the request path. `update_id` is the correlation key across Cloudflare Worker, Queue and Apps Script logs.

## Events

| Event | Runtime | Meaning |
| --- | --- | --- |
| `telegram_received` | Worker ingress | Valid Telegram update parsed |
| `worker_authenticated` | Worker ingress | Secret verification completed |
| `telegram_update_queued` | Worker ingress | Queue durably accepted the update |
| `queue_received` | Queue consumer | Consumer received the update; includes `queueWaitMs` |
| `gas_received` | GAS | Authenticated request reached the Telegram webhook |
| `state_loaded` | Core | Customer and conversation state loaded |
| `domain_started` / `domain_completed` | GAS/core | Domain processing, including current Sheet persistence |
| `transaction_completed` | GAS | Dedupe and business lock transaction completed |
| `telegram_send_started` / `telegram_send_completed` | GAS | One Bot API command delivery |
| `telegram_request_completed` | GAS | GAS webhook processing completed |
| `telegram_update_forwarded` | Queue consumer | GAS returned authenticated `OK`; includes end-to-end time |
| `telegram_fast_path_domain_completed` | Worker/DO | Per-customer Durable Object committed domain state |
| `telegram_fast_path_completed` | Worker | Fast-path domain and Telegram delivery completed |

Telemetry failures are swallowed and never change business behavior. No message text, token, QR content or bank data is logged.

## Collect a baseline

1. Deploy both Apps Script and the gateway instrumentation.
2. Run at least 100 representative actions: start, catalog, add item, cart, checkout, confirm and status. Include both warm and idle periods.
3. Export structured logs from Cloudflare Workers and Apps Script executions as JSON Lines, then combine them into one local file.
4. Generate the percentile report:

```sh
npm run latency:report < latency.jsonl
```

The report prints sample count, p50, p95 and max for each stage. Do not make an architecture decision with fewer than 30 samples per important event; target 100 or more.

## Interpretation

- High `queueWaitMs`: Queue delivery is material; a synchronous or edge-native path can help.
- High `domain_completed` or `transaction_completed`: Sheets and the global Script Lock dominate.
- High `telegram_send_completed`: Telegram Bot API or outbound network dominates.
- High `gasRoundTripMs` with low domain/send durations: GAS startup, routing or the final OperationMetrics Sheet write dominates.
- High `endToEndMs` but no single high stage: cumulative hops are the problem; move the interactive path to Worker + per-customer Durable Object.
