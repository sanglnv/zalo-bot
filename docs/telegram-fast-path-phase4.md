# Telegram fast path — Phase 4 payment lifecycle

Phase 4 makes each `TelegramSession` Durable Object the source of truth for payment confirmation and expiry of fast-path orders.

## Staff confirmation

The existing Sheets menu remains the staff UI. For a Telegram order, GAS resolves its Telegram chat ID and calls the Worker's `/internal/payment` endpoint using `X-GAS-Gateway-Token`. The Worker routes the request to the same per-chat Durable Object that created the order.

The DO atomically validates `AWAITING_PAYMENT`, changes the order/state to `PAID`, writes a notification outbox record, then delivers the Telegram message and publishes a new Sheets snapshot. A repeated click returns `already_resolved` and cannot notify twice after the outbox is marked delivered. Legacy/Zalo orders absent from the DO continue through the existing Sheets OrderService.

## Automatic expiry

When a fast-path order enters `AWAITING_PAYMENT`, its DO schedules one alarm at `createdAt + PAYMENT_TIMEOUT_MINUTES`. The default is 30 minutes. At alarm time the same atomic guard changes the order/state to `EXPIRED`, writes the outbox, notifies Telegram and mirrors the snapshot.

The existing GAS expiry scan remains as a compatibility fallback. It asks the Worker to resolve Telegram fast-path orders first and processes only orders that the DO reports as unknown.

Cloudflare alarms are at-least-once. The outbox makes Queue/Telegram delivery retryable after the state transaction commits. Queue snapshot upserts remain idempotent through `FastPathSyncedUpdates`.

## Verification

1. Create a pilot order and confirm it from the Sheets menu.
2. Confirm the DO result logs `telegram_fast_path_payment_resolved` with `status: PAID`.
3. Confirm Telegram receives one payment message and Sheets changes to `PAID`.
4. Click confirmation again and confirm `already_resolved` without a second message.
5. For expiry testing, temporarily use a short positive `PAYMENT_TIMEOUT_MINUTES` in a non-production test chat, deploy, create an order and verify `EXPIRED`; restore 30 immediately.

## Rollback

Set `FAST_PATH_ENABLED` to `false` to stop creation of new fast-path orders. Existing fast-path orders must still resolve through the Worker because their source-of-truth state is already in Durable Objects. Roll back the Worker deployment only after all existing pilot orders are resolved or migrated.
