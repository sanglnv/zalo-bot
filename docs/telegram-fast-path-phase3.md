# Telegram fast path — Phase 3

Phase 3 removes the oversized `CATALOG_JSON` Worker secret. The shared product catalog is stored in Cloudflare D1, while each chat still owns its strongly consistent conversation/order state in a Durable Object.

## Data flow

`Telegram → Worker → TelegramSession DO → Telegram API`

After the DO transaction commits, the Worker durably publishes a snapshot to `zalo-clawbot-fast-path-sync`. Its consumer authenticates to GAS and idempotently upserts Customer, ConversationState and Orders into Sheets. Telegram delivery does not wait for GAS execution.

## One-time infrastructure

The D1 database `zalo-clawbot-catalog` has been created in APAC and bound as `CATALOG_DB`. Before the first deployment, create the sync queue and apply the catalog schema:

```sh
cd telegram-gateway
npx wrangler queues create zalo-clawbot-fast-path-sync
npm run catalog:migrate -- --remote
```

Export the existing catalog array to a local, uncommitted JSON file and import it in batches:

```sh
npm run catalog:import -- /absolute/path/catalog.json --remote
```

The importer validates every product and upserts by `productId`. Product shape remains compatible with the existing Apps Script catalog:

```json
{"productId":"p1","name":"Coffee","price":35000,"isAvailable":true,"sortOrder":0}
```

The current export shape `{ "id", "name", "basePrice" }` is also accepted and normalized during import.

`CATALOG_JSON` is no longer a Worker secret. It remains an Apps Script property during the transition because the Zalo and Queue → GAS paths still read it.

## Deployment order

1. Apply D1 migration and import the catalog.
2. Run Apps Script `setupSystem()` so `FastPathSyncedUpdates` exists, then push/deploy GAS.
3. Create the sync queue.
4. Run gateway checks and deploy the Worker with `FAST_PATH_ENABLED` still false.
5. Enable only allowlisted test chats and verify `telegram_fast_path_synced` logs.
6. Confirm the same customer, conversation and order appear once in Sheets.

## Failure and rollback

Sync messages retry with exponential backoff and eventually enter the existing Telegram DLQ. Snapshot upserts and `FastPathSyncedUpdates` make replay idempotent. A sync outage does not slow the customer reply, but operations must resolve the DLQ before staff confirms payment.

Set `FAST_PATH_ENABLED` to `false` and deploy to route all new updates back through Queue → GAS. D1 and Durable Object data are preserved for investigation.
