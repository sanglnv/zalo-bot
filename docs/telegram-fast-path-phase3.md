# Telegram fast path — Phase 3

Phase 3 removes the oversized `CATALOG_JSON` Worker secret. The shared product catalog is stored in Cloudflare D1, while each chat still owns its strongly consistent conversation/order state in a Durable Object.

## Data flow

`Telegram → Worker → TelegramSession DO → Telegram API`

Trong cùng transaction với thay đổi domain, DO ghi snapshot vào local queue outbox. Sau commit, outbox publish tới `zalo-clawbot-fast-path-sync`; alarm retry nếu Queue tạm lỗi. Consumer xác thực tới GAS và upsert Customer, ConversationState và Orders vào Sheets. Telegram delivery không chờ GAS execution.

Snapshot schema v2 gồm `snapshotId`, `customerId` và `revision` tăng đơn điệu trong từng DO/customer. GAS ghi revision cuối vào `FastPathSyncState`, bỏ qua snapshot trùng hoặc cũ, và áp dụng customer/state/orders dưới cùng Script Lock. Vì vậy Queue có giao lại hoặc đảo thứ tự cũng không thể rollback Sheets về state cũ.

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
2. Run Apps Script `setupSystem()` so `FastPathSyncedUpdates` và `FastPathSyncState` exist, then push/deploy GAS.
3. Create the sync queue.
4. Run gateway checks and deploy the Worker with `FAST_PATH_ENABLED` still false.
5. Enable only allowlisted test chats and verify `telegram_fast_path_synced` logs.
6. Confirm the same customer, conversation and order appear once in Sheets.

## Failure and rollback

Sync messages retry with exponential backoff and eventually enter the existing Telegram DLQ. `snapshotId` dedupe cùng per-customer revision guard làm replay idempotent và chặn out-of-order overwrite. A sync outage does not slow the customer reply, but operations must resolve the DLQ before staff confirms payment.

Set `FAST_PATH_ENABLED` to `false` and deploy to route all new updates back through Queue → GAS. D1 and Durable Object data are preserved for investigation.
