# Telegram fast path — Phase 2 pilot

Phase 2 moves Telegram interaction processing into a per-chat SQLite Durable Object. The existing Queue → GAS path remains the default and is unchanged while `FAST_PATH_ENABLED` is `false`.

## Safety boundary

Fast path requires both conditions:

1. `FAST_PATH_ENABLED` in `wrangler.jsonc` is exactly `"true"`.
2. The Telegram chat ID appears in the comma-separated `FAST_PATH_CHAT_IDS` secret.

An empty allowlist routes every chat through Queue → GAS. Use only dedicated pilot accounts in Phase 2. Fast-path orders are stored in Durable Object SQLite and are not yet mirrored to Sheets; staff confirmation and expiry remain on the GAS data model until Phase 3 and Phase 4.

## Storage model

Each Telegram chat ID maps deterministically to one `TelegramSession` Durable Object located with the `apac-se` hint. Each object stores:

- customer record;
- conversation state and cart;
- orders;
- processed update IDs and rendered Telegram commands.

The shared `OrderService`, state machine, billing, inbound mapper and outbound renderer are bundled from the repository root, avoiding a second implementation of business rules. SQLite writes and the processed update record run inside `transactionSync()`.

## Configure pilot secrets

From `telegram-gateway/`, set the values through Wrangler prompts so they do not enter shell history:

```sh
npx wrangler secret put FAST_PATH_CHAT_IDS
npx wrangler secret put VIETQR_BANK_ID
npx wrangler secret put VIETQR_ACCOUNT_NO
npx wrangler secret put VIETQR_ACCOUNT_NAME
npx wrangler secret put VIETQR_TEMPLATE
npx wrangler secret put VIETQR_TRANSFER_PREFIX
```

Keep `FAST_PATH_ENABLED` false during secret setup and initial deployment. Then add only test chat IDs to `FAST_PATH_CHAT_IDS`, change the variable to `"true"`, run checks, and deploy.

> Phase 3 replaces the Worker `CATALOG_JSON` secret with D1. Follow the Phase 3 runbook for catalog migration and Sheets mirroring.

## Pilot test

For each allowlisted test chat:

1. Send `/start`, open catalog, add two products, edit cart and checkout.
2. Confirm the order and verify QR amount/content.
3. Send the same callback update through a test fixture and confirm `duplicate: true` in `telegram_fast_path_domain_completed`.
4. Confirm no `telegram_update_queued` event exists for the allowlisted update.
5. Confirm a non-allowlisted chat still emits `telegram_update_queued` and reaches GAS.
6. Compare `telegram_fast_path_completed.totalDurationMs` against `telegram_update_forwarded.endToEndMs` from Phase 1.

## Rollback

Set `FAST_PATH_ENABLED` back to `"false"` and deploy. All new updates immediately return to Queue → GAS; no Telegram webhook re-registration is needed. Do not use pilot accounts for real payment orders until Sheets mirroring and staff confirmation are migrated.
