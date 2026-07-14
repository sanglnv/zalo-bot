# Zalo Clawbot — Ordering, Telegram, and manual payment confirmation

Phase 1 provides a synchronous, platform-neutral order domain for Google Apps Script. It contains no chat API adapter and performs no network calls. Runtime dependencies—including storage, time, ID generation, catalog loading, QR generation, and transaction locking—are injected into `OrderService`.

## Layout

- `src/core/`: domain contracts, pure state machine, pure billing, repository contracts, and order orchestration.
- `src/repositories/`: Google Sheet repository implementations. Every write acquires `LockService.getScriptLock()`.
- `src/adapters/telegram/`: pure Telegram mapping/rendering plus GAS webhook/client glue.
- `src/adapters/zalo/`: pure Zalo mapping/rendering/signature verification plus OA Send API, OAuth token rotation, ZBS, and webhook glue.
- `src/tests/`: Node tests, including complete transition coverage and simulated overlapping Sheet writes.

## Test

Node.js 18 or newer is sufficient; there are no package dependencies.

```sh
npm test
npm run check:boundaries
```

`npm run check` runs both. The boundary check fails if a core file references a platform name or a GAS storage/network API.

## GAS configuration

Set the destination sheet as a Script Property—never commit credentials or tokens:

```js
PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', 'your-sheet-id');
```

Repository tabs (`Orders`, `Customers`, `ConversationStates`, `ProcessedUpdates`, `ErrorLogs`, and `OperationMetrics`) and their header rows are created on the first write. Secrets needed by adapters follow the same Script Properties pattern.

Zalo uses a separate `ZaloProcessedUpdates` tab keyed by `message.msg_id`. Keeping it separate avoids collisions with Telegram `update_id`, preserves the existing Telegram sheet schema, and makes per-channel delivery failures easier to audit. Its delivery statuses have the same `pending` / `delivered` / `failed` meaning as `ProcessedUpdates`.

## Message transaction lock

The lock boundary is the complete `orderService.handleMessage()` call, including customer lookup/creation, conversation-state read, transition validation, order writes, and conversation-state write. The runtime must inject `withLock`, and the GAS wiring uses `SheetRepositorySupport.withScriptLock`.

This message-wide lock prevents two deliveries for the same customer from reading the same state and creating duplicate orders. It also closes the first-message race that could otherwise create two internal customers for one platform identity. Transition validity is checked before order creation, so a queued duplicate confirmation reloads `AWAITING_PAYMENT` and fails without writing another order.

GAS supplies one script-wide lock rather than keyed customer locks, so this design serializes all bot traffic. That is acceptable for the initial small-volume deployment. Phase 4 should revisit the lock/storage strategy if measured contention or execution time becomes material. Telegram webhook idempotency is implemented in Phase 2 using `update_id`.

Sheet repositories retain their own write locks for safe direct use. When called within the message-wide lock, `SheetRepositorySupport` detects the already-owned script lock and executes without trying to acquire it again.

## Phase 2 adapter contract

An adapter has only three responsibilities:

1. Convert a webhook into `{ platform, platformUserId, text, payload }`.
2. Call `orderService.handleMessage(inboundMessage)`.
3. Render each returned `{ type, content }` message using that platform's API.

Conceptual wiring:

```js
var service = OrderService.create({
  orderRepository: SheetOrderRepository(),
  customerRepository: SheetCustomerRepository(),
  conversationStateRepository: SheetConversationStateRepository(),
  getCatalog: loadCatalog,
  createQrContent: createPaymentQr,
  createId: function () { return Utilities.getUuid(); },
  now: function () { return new Date(); },
  withLock: SheetRepositorySupport.withScriptLock
});

function receiveWebhook(rawEvent) {
  var inboundMessage = mapInboundMessage(rawEvent);
  var outboundMessages = service.handleMessage(inboundMessage);
  outboundMessages.forEach(renderAndSend);
}
```

The adapter may use platform SDK fields, HTTP calls, and credentials. None of those details cross into `src/core/`, so a later adapter can use the same service unchanged.

## Telegram adapter

The adapter is split into pure and runtime layers:

- `mapInboundMessage.js` maps text messages and callback queries into the core contract. Callback data uses a URI-safe compact format such as `add_item:p1:1` and enforces Telegram's 64-byte limit.
- `renderOutboundMessage.js` maps all four core output types into Bot API command descriptions.
- `TelegramClient.gs` is the only layer that calls the Telegram Bot API through `UrlFetchApp`.
- `webhook.gs` owns `doPost`, update deduplication, orchestration, delivery, callback acknowledgement, and one-time webhook registration.

For every update, `webhook.gs` acquires the script lock, checks `ProcessedUpdates`, records a new `update_id`, and calls the core service before releasing the lock. Rendering and short Bot API requests happen after the transaction. A duplicate returns `OK` without reaching core or sending the business response again; callback duplicates are still acknowledged to stop the Telegram loading indicator.

This check-and-record placement is the pattern Phase 5 should preserve for the equivalent delivery identifier from another platform: dedupe and domain mutation must share one lock boundary.

### Required Script Properties

Configure these under **Apps Script → Project Settings → Script Properties**:

| Property | Purpose |
| --- | --- |
| `SPREADSHEET_ID` | Datastore spreadsheet ID |
| `TELEGRAM_BOT_TOKEN` | Bot token issued by BotFather |
| `CATALOG_JSON` | JSON array of `{productId,name,price,isAvailable}` |
| `VIETQR_BANK_ID` | Bank BIN or supported bank identifier |
| `VIETQR_ACCOUNT_NO` | Receiving account number |
| `VIETQR_ACCOUNT_NAME` | Receiving account name |
| `VIETQR_TEMPLATE` | Optional; defaults to `compact2` |
| `VIETQR_TRANSFER_PREFIX` | Optional transfer-content prefix; defaults to `DH` |
| `SUPPORT_CONTACT` | Optional phone/name included in delivery-failure messages |
| `WEB_APP_URL` | Deployed Apps Script `/exec` URL |
| `PAYMENT_TIMEOUT_MINUTES` | Optional unpaid-order timeout; defaults to `30` |

Example catalog value:

```json
[{"productId":"p1","name":"Coffee","price":35000,"isAvailable":true}]
```

The QR dependency emits VietQR's documented direct [Quick Link image URL](https://vietqr.io/danh-sach-api/link-tao-ma-nhanh/), including the order amount and order ID in the transfer description. Telegram fetches this URL directly via `sendPhoto`.

### Delivery failure and payment recovery

`ProcessedUpdates` distinguishes receipt from delivery with `deliveryStatus`:

- `pending`: the `update_id` was claimed and domain processing started.
- `delivered`: every business response command was accepted by the Telegram Bot API.
- `failed`: domain processing or at least one business response command failed.

The update is claimed early to prevent duplicate orders. After domain commit, every outbound command is attempted. If any command fails, the webhook marks the update `failed` and independently attempts a plain `sendMessage` fallback using `SUPPORT_CONTACT`. Failure of the original command or of the fallback never changes the required `200 OK` webhook response.

For a failed payment QR, `ErrorLogs.context` records `orderId`, `chatId`, `qrUrl`, `failedMethod`, `fallbackDelivered`, and any `fallbackError`. Staff can filter for `"failedMethod":"sendPhoto"` and manually send the stored `qrUrl` to the stored `chatId`; the customer must not confirm the order again because its state is already `AWAITING_PAYMENT`.

The same fallback applies to catalog, cart, checkout, cancel, and transition errors, so a later customer action cannot disappear silently. Phase 5 should preserve this separation between delivery deduplication and delivery outcome tracking.

### Deploy and register the webhook

The repository includes `appsscript.json` and `.claspignore`; tests and planning files are excluded from upload. For a new standalone project:

```sh
clasp login
clasp create-script --title "Zalo Clawbot" --type standalone --rootDir .
clasp show-file-status
clasp push
```

For an existing project, create `.clasp.json` with its `scriptId` and `rootDir` set to `.` instead of creating another project. Review `clasp show-file-status` before the first push because `clasp push` replaces the remote project contents.

Then:

1. Add all required Script Properties.
2. In Apps Script choose **Deploy → New deployment → Web app**.
3. Execute as the deploying user and allow anonymous access so Telegram can POST without a Google login. See Google's [web app deployment guide](https://developers.google.com/apps-script/guides/web).
4. Copy the deployed `/exec` URL into the `WEB_APP_URL` Script Property.
5. Run `registerWebhook()` once from the Apps Script editor and authorize the requested scopes. It calls Telegram `setWebhook` for `message` and `callback_query` updates.
6. After every code change, push and update the existing deployment; a `/dev` test URL is not suitable for Telegram.

There is no `getUpdates` polling and no sleep/retry loop in the webhook execution path.

## Zalo OA adapter

Phase 5 adds Zalo without changing any file in `src/core/`. Direct replies from `handleMessage` use the OA customer-service Send API at `https://openapi.zalo.me/v3.0/oa/message/cs`. Button actions use `oa.query.hide`; Zalo delivers their compact `zc:...` payload back as a normal `user_send_text` event, which the inbound mapper decodes. Catalogs use a list template, confirmation uses a button template, and VietQR uses the media image URL structure.

The implementation follows the current official contracts checked on 14 July 2026:

- [OA OAuth v4](https://stc-developers.zdn.vn/docs/v2/official-account/bat-dau/xac-thuc-va-uy-quyen-cho-ung-dung-new): OA access tokens last 25 hours; every successful refresh returns a new single-use refresh token. Refresh uses `POST https://oauth.zaloapp.com/v4/oa/access_token`, form-encoded fields, and the `secret_key` header.
- [Webhook signature](https://stc-developers.zdn.vn/docs/v2/official-account/webhook/tin-nhan/su-kien-nguoi-dung-da-xem-tin-nhan-duoc-gui-tu-official-account): `X-ZEvent-Signature` contains `mac=sha256(appId + rawJsonBody + timestamp + OAsecretKey)`. This is a SHA-256 concatenation contract, not HMAC.
- [Button actions](https://stc-developers.zdn.vn/docs/v2/official-account/phu-luc/cau-truc-cua-tham-so-buttons): up to five buttons; `oa.query.show` / `oa.query.hide` payloads are limited to 1,000 characters. The adapter enforces a stricter 1,000 UTF-8 byte ceiling.
- [ZBS Template Message via UID](https://stc-cms-developers.zdn.vn/2025/12/ZBS_Template_Mesage_API_v1.pdf): approved templates are sent through `POST https://openapi.zalo.me/v3.0/oa/message/template` with `user_id`, `template_id`, and template-specific `template_data`.

### Manual prerequisites

Before enabling the adapter in production:

1. Create and verify the Zalo OA, link it to the developer app, enable the required message/webhook permissions, and purchase the applicable OA service package.
2. Register and obtain approval for two ZBS templates: **Xác nhận thanh toán** and **Đơn hàng hết hạn**. Both templates in this implementation expect `order_id` and `message` variables. If the approved variable names differ, update only `renderZbsTemplateMessage.js`.
3. Complete the initial OA OAuth authorization in a browser, then run `bootstrapZaloTokens(accessToken, refreshToken, expiresInSeconds)` once in the Apps Script editor. The third argument is optional and defaults to the documented 90,000 seconds.
4. Configure the signature-forwarding gateway described below and register its public URL as the Zalo webhook. Subscribe at least to the user text-message event.

### Required Zalo Script Properties

| Property | Purpose |
| --- | --- |
| `ZALO_APP_ID` | Zalo developer application ID used during token refresh |
| `ZALO_APP_SECRET` | Application secret sent as OAuth `secret_key` |
| `ZALO_OA_SECRET_KEY` | OA secret used only to verify webhook MACs |
| `ZALO_ACCESS_TOKEN` | Current OA access token; written by `bootstrapZaloTokens` / token manager |
| `ZALO_REFRESH_TOKEN` | Current single-use refresh token; rotated immediately after refresh |
| `ZALO_ACCESS_TOKEN_EXPIRES_AT` | Access-token expiry as epoch milliseconds |
| `ZALO_ZBS_PAYMENT_CONFIRMED_TEMPLATE_ID` | Approved payment-confirmation ZBS template ID |
| `ZALO_ZBS_ORDER_EXPIRED_TEMPLATE_ID` | Approved order-expiry ZBS template ID |

All token read/check/refresh/write work runs inside `SheetRepositorySupport.withScriptLock`. Two executions that see an expired token are serialized: the first rotates and stores both tokens atomically, and the second reuses the newly stored access token.

### Required signature-forwarding gateway

Zalo sends its MAC only in the custom `X-ZEvent-Signature` request header. Google Apps Script web-app events expose query parameters and the raw body but do **not** expose arbitrary request headers. Consequently, a direct Zalo → GAS webhook cannot verify the documented signature.

Production must place a small HTTPS gateway (for example Cloudflare Worker, Cloud Run, or API Gateway) in front of GAS. It must:

1. Read `X-ZEvent-Signature` without modifying the raw JSON body.
2. Forward the same body to `WEB_APP_URL?platform=zalo&signature=<URL-encoded header value>`.
3. Return the GAS response to Zalo and never log the signature or body as credentials.

`ZaloWebhook` accepts the header directly in test/compatible runtimes and accepts `signature` (or `mac`) from the gateway query string in GAS. Missing or invalid signatures are logged to `ErrorLogs` with `stage: "signature_verification"`, return `200 OK`, and never reach the domain service.

### Send API versus ZBS

| Context | Client | Reason |
| --- | --- | --- |
| Catalog, add item, checkout, confirm/cancel, QR | OA customer-service Send API | Immediate response to the user's current interaction |
| Staff `confirmPayment` notification | ZBS Template Message | May occur outside the 48-hour interaction window |
| Scheduled `expireOrder` notification | ZBS Template Message | May occur outside the 48-hour interaction window |

`NotificationRegistry.gs` deliberately registers the Zalo platform with `ZbsTemplateClient`, while `zalo/webhook.gs` deliberately constructs `ZaloClient`. Do not swap these clients: a committed payment or expiry must remain committed even if ZBS delivery fails, and the existing notification-dispatch error path keeps that distinction visible to staff.

## Manual payment confirmation

The `Orders` sheet is the single source of truth for payment state. A successful confirmation updates `status` to `PAID` and writes `confirmedAt` and `confirmedBy`; there is intentionally no separate `PaymentRepository`, avoiding two payment records that could drift apart. Existing `Orders` sheets receive the two new columns automatically on the next write, while older rows read them as `null`.

`OrderService.confirmPayment(orderId, confirmedBy)` runs under the same script-wide lock as chat handling. It verifies that both the order and its customer conversation are still awaiting payment, applies the existing `PAYMENT_CONFIRMED` transition, updates the order/state, and returns normalized notifications plus the customer's platform links. Repeated or concurrent confirmation is reported as already resolved and does not send another customer notification.

Notifications go through `notificationDispatcher.js` and `NotificationRegistry.gs`. The registry currently contains Telegram; Phase 5 can add another registry entry without changing payment confirmation or dispatch logic.

### Install the staff Sheet menu

This is a standalone Apps Script project, so a simple `onOpen()` in the spreadsheet is not used. Run this once manually from the Apps Script editor and approve the new trigger/user-email scopes:

```js
registerSheetMenuTrigger();
```

The function creates one installable open trigger for `SPREADSHEET_ID` and is safe to run again—it will not create a duplicate trigger. Close and reopen the spreadsheet, select exactly one order row in the `Orders` tab, then choose:

**Zalo Clawbot → Xác nhận thanh toán đơn đang chọn**

The menu shows the order ID and total amount and requires explicit confirmation. It records `Session.getActiveUser().getEmail()`; when Apps Script cannot expose that email, it prompts for a staff name or email. On success, the customer receives the payment-confirmed message. A second click shows “Đơn này đã được xác nhận hoặc không còn chờ thanh toán.” without logging a false system error or notifying the customer twice.

The staff workflow reports three outcomes distinctly:

- Confirmation and notification both succeed: the order is `PAID` and the customer was notified.
- Confirmation itself fails: the order was not moved to `PAID`; the UI shows the actual confirmation error and logs `stage: "confirm_payment"` (except the normal already-resolved case).
- Confirmation succeeds but notification delivery fails: the order is already `PAID`; the UI explicitly asks staff to notify the customer manually, and `ErrorLogs` records `stage: "notification_dispatch"`, `orderId`, `customerId`, and `platformLinks`.

This separation is required when another channel is added to the notification registry in Phase 5: an adapter outage must never make a committed payment appear unconfirmed.

Do not replace this workflow with a simple `onEdit` trigger. Simple triggers cannot use services that require authorization, while this workflow reads another spreadsheet, identifies the user, and calls the Bot API. Google documents this distinction in its [simple trigger](https://developers.google.com/apps-script/guides/triggers/) and [installable trigger](https://developers.google.com/apps-script/guides/triggers/installable) guides.

## Payment expiry hardening

`OrderService.expireOrder(orderId)` uses the same awaiting-payment guard and global script lock as manual payment confirmation. It applies `PAYMENT_EXPIRED`, updates the order and conversation to `EXPIRED`, and returns normalized notifications. If payment confirmation and expiry race, the lock serializes them; the loser reloads the resolved state and exits without changing it.

`scanAndExpireStalePayments()` selects only `AWAITING_PAYMENT` orders older than `PAYMENT_TIMEOUT_MINUTES`. It processes the oldest 50 at most per run, isolates each order's errors, and leaves overflow for the next trigger execution. Notification delivery is outside each short domain lock. A committed expiry whose notification fails is reported as `expired_but_notification_failed` and logged under `stage: "expiry_notification_dispatch"`; it is never misreported as a failed expiry.

Run this once from the Apps Script editor after deploying Phase 4:

```js
registerPaymentExpiryTrigger();
```

The registration is idempotent and creates a time-driven trigger every 10 minutes. To change the expiry window, set `PAYMENT_TIMEOUT_MINUTES` to a positive number; when absent, the default is 30 minutes.

## Operation metrics

`recordDuration` wraps `doPost`, `confirmSelectedOrderPayment`, and `scanAndExpireStalePayments`. It appends raw `timestamp`, `operation`, and `durationMs` rows to `OperationMetrics`, including failed operations. Metrics-write failures never replace the original operation result.

These rows are intentionally raw measurements, not an APM system or dashboard. No migration threshold is assumed yet. Phase 4/5 operators should compare observed execution volume and duration with current GAS quotas before deciding whether storage or orchestration needs to move beyond Sheets.

## State-machine audit

The complete per-state review is in [docs/state-machine-audit.md](docs/state-machine-audit.md). The explicit decision is that `PAID` is the practical terminal state for the current bill/payment scope. `COMPLETE → DONE` remains reserved for a future fulfilment workflow; Phase 4 does not add a completion menu or pretend that `DONE` is currently reachable.
