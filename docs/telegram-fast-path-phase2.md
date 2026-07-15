# Telegram fast path — Phase 2

Phase 2 moves Telegram interaction processing into a per-chat SQLite Durable Object. The existing Queue → GAS path remains available as a global fallback while `FAST_PATH_ENABLED` is `false`.

## Safety boundary

Fast path is controlled globally: `FAST_PATH_ENABLED` in `wrangler.jsonc` must be exactly `"true"`. When enabled, every update with a Telegram chat ID is processed by its per-chat Durable Object. Set the flag to `"false"` to route all chats through Queue → GAS.

## Storage model

Each Telegram chat ID maps deterministically to one `TelegramSession` Durable Object located with the `apac-se` hint. Each object stores:

- customer record;
- conversation state and cart;
- orders;
- processed update IDs and rendered Telegram commands.

The shared `OrderService`, state machine, billing, inbound mapper and outbound renderer are bundled from the repository root, avoiding a second implementation of business rules. SQLite writes and the processed update record run inside `transactionSync()`.

## Configure secrets

From `telegram-gateway/`, set the values through Wrangler prompts so they do not enter shell history:

```sh
npx wrangler secret put VIETQR_BANK_ID
npx wrangler secret put VIETQR_ACCOUNT_NO
npx wrangler secret put VIETQR_ACCOUNT_NAME
npx wrangler secret put VIETQR_TEMPLATE
npx wrangler secret put VIETQR_TRANSFER_PREFIX
```

Configure the required secrets, set `FAST_PATH_ENABLED` to `"true"`, run checks, and deploy.

> Phase 3 replaces the Worker `CATALOG_JSON` secret with D1. Follow the Phase 3 runbook for catalog migration and Sheets mirroring.

## Pilot test

For each test chat:

1. Send `/start`, open catalog, add two products, edit cart and checkout.
2. Confirm the order and verify QR amount/content.
3. Send the same callback update through a test fixture and confirm `duplicate: true` in `telegram_fast_path_domain_completed`.
4. Confirm no `telegram_update_queued` event exists while fast path is enabled.
5. Compare `telegram_fast_path_completed.totalDurationMs` against `telegram_update_forwarded.endToEndMs` from Phase 1.

## Rollback

Set `FAST_PATH_ENABLED` back to `"false"` and deploy. All new updates immediately return to Queue → GAS; no Telegram webhook re-registration is needed.
