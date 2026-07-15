# Telegram fast path — Phase 4 payment lifecycle

Phase 4 makes each `TelegramSession` Durable Object the source of truth for payment confirmation and expiry of fast-path orders.

## Staff confirmation

The existing Sheets menu remains the staff UI. For a Telegram order, GAS resolves its Telegram chat ID and calls the Worker's `/internal/payment` endpoint using `X-GAS-Gateway-Token`. The Worker routes the request to the same per-chat Durable Object that created the order.

The DO atomically validates `AWAITING_PAYMENT`, changes the order/state to `PAID`, writes a notification outbox record and a snapshot queue-outbox record. Telegram and Queue calls happen only after commit. If Telegram fails, `/internal/payment` still returns HTTP 200 with `outcome: resolved`, `status: PAID`, `deliveryStatus: pending`; GAS shows staff that payment succeeded but manual customer contact may be needed. Alarm retry resumes at the first unsent Telegram command. A repeated click returns `already_resolved` with the linked outbox delivery state and cannot mutate the order twice. Legacy/Zalo orders absent from the DO continue through the existing Sheets OrderService.

## Automatic expiry

When a fast-path order enters `AWAITING_PAYMENT`, its DO schedules an alarm no later than `createdAt + PAYMENT_TIMEOUT_MINUTES`. The default is 30 minutes. At alarm time the same atomic guard changes the order/state to `EXPIRED`, writes the notification/snapshot outboxes and a durable inventory-release effect. Alarm retries pending inventory, Queue and Telegram effects with backoff.

The existing GAS expiry scan remains as a compatibility fallback. It asks the Worker to resolve Telegram fast-path orders first and processes only orders that the DO reports as unknown.

Cloudflare alarms and Queues are at-least-once. Stable effect IDs, reservation status checks, queue outbox records, notification command progress, snapshot IDs and per-customer revisions make retries safe after the state transaction commits. Inventory release updates stock and reservation status in one D1 batch.

## Verification

1. Create a pilot order and confirm it from the Sheets menu.
2. Confirm the DO result logs `telegram_fast_path_payment_resolved` with `status: PAID`.
3. Confirm Telegram receives one payment message and Sheets changes to `PAID`.
4. Click confirmation again and confirm `already_resolved` without a second message.
5. For expiry testing, temporarily use a short positive `PAYMENT_TIMEOUT_MINUTES` in a non-production test chat, deploy, create an order and verify `EXPIRED`; restore 30 immediately.
6. Force one Telegram delivery failure and verify the payment endpoint reports `PAID` + `deliveryStatus: pending`; restore delivery, trigger/wait for the alarm, and verify the outbox becomes delivered without another state transition.
7. Force D1/Queue side-effect failure in a test environment and verify the durable effect remains pending, then becomes done after recovery without double-adjusting inventory.

## Rollback

Set `FAST_PATH_ENABLED` to `false` to stop creation of new fast-path orders. This is the checked-in default and must remain false during rollout until tests and outboxes are healthy. Existing fast-path orders must still resolve through the Worker because their source-of-truth state is already in Durable Objects. Roll back the Worker deployment only after all existing pilot orders are resolved or migrated.
