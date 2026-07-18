# Bot Order Webhook integration

Zalo Clawbot's menu and order lifecycle (create, read, confirm payment, expire/cancel) are now
served by an external POS Apps Script's "Bot Order Webhook" (`BotOrderWebhookClient.gs` +
`BotOrderRepository.gs`), replacing the local `Orders` Sheet as the source of truth. The
Telegram/Zalo Fast Path (Cloudflare Worker + Durable Object + D1) is a separate, unrelated system
and is intentionally unchanged by this integration.

## Configuration

- `BOT_ORDER_WEBHOOK_URL`: the POS Apps Script web app `/exec` URL.
- `BOT_ORDER_WEBHOOK_SECRET`: shared secret, sent as `secret` in the JSON POST body (not a header
  or query param — Apps Script `doGet`/`doPost` cannot read custom HTTP headers).
- `BOT_ORDER_WEBHOOK_CHANNEL` (optional, default `online_bot`), `BOT_ORDER_WEBHOOK_SOURCE`
  (optional, default `clawbot`), `BOT_ORDER_WEBHOOK_TABLE_ID` (optional, omitted unless set) — sent
  on `createOrder`.

## Known assumptions and limitations

These were necessary judgment calls made without a live response sample from the POS side. Fix
`BotOrderWebhookClient.gs` if reality differs — the mapping is centralized in `normalizeProduct`,
`normalizeOrder`, and `normalizeOrderItem`.

- **Product field names are confirmed against a live response (2026-07-18).** The real shape is
  `id` (not `productId`), `name`, `basePrice` (not `price`), `active` + `soldOut` (not
  `isActive`/`isAvailable`), and `categoryId` only -- `categoryName` is **not** on the product, it
  lives in a separate `patch.categories` array and is joined by `categoryId` in `fetchMenuCatalog`.
  `normalizeProduct` keeps the original guessed field names as fallbacks for forward-compatibility,
  but the real POS response uses the confirmed names above.
- **Multi-size products only use the base price.** Products can carry a `sizeOptionsJson` array
  (e.g. `[{"name":"M","price":20000},{"name":"L","price":25000}]`) for size-based pricing. Clawbot's
  cart UI has no size-selection step, so only `basePrice` (effectively the first/base size) is used
  today. A product with an `L` upcharge is sold at its `M` price until size selection is built.
- **EXPIRED and CANCELLED collapse to `cancelled` on read-back.** The POS only has one terminal
  non-payment status (`cancelled`) for both a customer-initiated cancel and a payment-timeout expiry.
  Clawbot still sends the correct customer-facing message at the moment of expiry/cancellation (that
  logic is local), but a *later* re-read of that order (e.g. a repeat `/status`) will show `CANCELLED`
  even if it was actually an expiry.
- **`findOrdersByCustomerId` only returns open orders.** There is no "order history" action. Once an
  order leaves `open` (paid, completed, or cancelled), `/status` for that customer will report "no
  orders" instead of showing the last resolved order. This is a capability gap of the webhook, not a
  bug in this integration.
- **`orderId` is reassigned by `BotOrderRepository.save()` on create.** `OrderService` (core,
  platform-neutral) generates its own `orderId` before calling `repository.save()`, then keeps using
  that same value for the VietQR content, the confirmation message, and conversation state — all
  read from the same object reference *after* `save()` returns. Since the POS always generates its
  own order id server-side, `save()` mutates the passed-in order object in place, overwriting
  `orderId` with the POS-assigned id. The original Clawbot-generated id is still sent as
  `raw.clawbotOrderId` on `createOrder` for traceability. This only works because every read of
  `order.orderId` in the confirm-order flow happens after `save()` returns — do not reorder that flow
  without re-checking this assumption.
- **`paymentMethod` is hardcoded to `'bank_transfer'`.** `completeOrder` requires it, but Clawbot only
  supports VietQR bank transfer today. Revisit if another payment method is added.
- **`findOrdersByCustomerId` can be action-restricted per secret/integration on the POS side.**
  Observed in production (2026-07-18): the POS returned `ok:false, message: "Webhook action is
  not allowed"` for this action even though it's documented. `BotOrderRepository.findByCustomerId`
  now fails soft to `[]` (with a `console.error` log) whenever the POS message matches
  `/not allowed/i`, so a permission gap on one action doesn't hard-fail `/start` and every other
  message for every customer. This masks the real symptom (no pending-order detection, `/status`
  always empty) instead of surfacing an error — check server logs for
  `bot_order_webhook_action_not_allowed` if pending-order detection seems to silently not work.
  The actual fix is on the POS side: get `findOrdersByCustomerId` enabled/scoped for the
  `BOT_ORDER_WEBHOOK_SECRET` in use.
- **Per-order `confirmedBy` is not tracked by the POS.** The webhook attributes bot actions to a
  single `BOT_ORDER_WEBHOOK_ACTOR_EMAIL` on its own side; Clawbot's own `ErrorLogs`/audit trail is
  still the place to see which staff member triggered a confirmation.

## QR delivery is deferred to a staff /thanhtoan command

As of 2026-07-18, `confirm_order` no longer sends the payment QR to the customer immediately. It
mirrors the Telegram Fast Path's UX (Cloudflare Worker): the customer gets a text confirmation only
("Đơn đang được chuẩn bị..."), and a notification goes out to the **Telegram ops chat**
(`TELEGRAM_OPERATIONS_CHAT_ID`, now a *required* script property — see `OperationsNotifier.gs`) with
the item breakdown, total, and source platform (`telegram` or `zalo`). Staff reply
`/thanhtoan <orderId>` in that chat once the order is ready; `PaymentQrDispatch.gs` intercepts that
message in `telegram/webhook.gs` (before it ever reaches `OrderService.handleMessage` — staff aren't
Clawbot "customers"), calls the new `OrderService.sendPaymentQr(orderId)`, and pushes the QR to
whichever platform(s) the customer is linked to (`NotificationDispatcher` + the *interactive* Telegram/
Zalo clients, not the ZBS-template registry used for payment-confirmed/expired pushes — a QR image
isn't a pre-approved ZBS template, so this relies on the normal Zalo customer-service Send API being
usable within its 48h window, same assumption the old immediate-send flow already made).

This applies to **both** Telegram and Zalo customers — Zalo has no ops channel of its own, so
Zalo-originated confirmations are also notified in the single Telegram ops chat, tagged
`Kênh: zalo`. `TELEGRAM_ADMIN_USER_IDS` (optional, comma-separated Telegram user ids) restricts who
can run `/thanhtoan`; if unset, anyone who can post in the ops chat is trusted.

**Operational risk:** if `TELEGRAM_OPERATIONS_CHAT_ID` is misconfigured or the ops chat is muted,
confirmed orders are silently never notified to staff and the customer never receives a QR at all
(no fallback exists). `SystemSetup.validateConfiguration()`/`healthCheck()` now require this
property to catch the "unset" case, but a wrong/inaccessible chat id will not be caught automatically.

**Telegram-only gotcha: `/thanhtoan` was already claimed by the Worker.** The Cloudflare Worker
(`telegram-gateway/src/index.ts`) has its own, older `/thanhtoan` admin/customer command for Fast
Path's own D1-backed orders, intercepted unconditionally at the edge (`isPaymentQrCommand`), before
any FAST_PATH_ENABLED check. As of 2026-07-18 this is gated behind `FAST_PATH_ENABLED === "true"`
so it doesn't swallow the GAS-side `/thanhtoan` handled by `PaymentQrDispatch.gs` when Fast Path is
off — the two `/thanhtoan` implementations operate on entirely separate order stores (Fast Path's
D1 vs. the POS via `BotOrderRepository`) and must never both be live for the same order.

**Testing note — admin accounts always use Fast Path.** `/start` and any Telegram account listed in
the Worker's `TELEGRAM_ADMIN_USER_IDS` secret route through Fast Path *unconditionally*,
independent of `FAST_PATH_ENABLED` — this is intentional (welcome banner rollout + always-available
Fast Path inventory admin commands like `/quanly`/`/ton`/`/suamon`) and is covered by
`telegram-gateway/test/index.spec.ts`. To actually exercise this GAS/POS flow (including
`confirm_order`, `/thanhtoan`, and the ops notification), test with a Telegram account that is
**not** in `TELEGRAM_ADMIN_USER_IDS`.

## Staff Sheet menu changes

The `Orders` sheet no longer exists as a place staff select a row from — orders are not written to
Sheets at all anymore. `PaymentConfirmation.gs`'s menu now has two items:

- **Xem đơn chờ thanh toán**: lists currently pending (`AWAITING_PAYMENT`) orders read live from the
  webhook.
- **Xác nhận thanh toán theo mã đơn**: prompts staff to type/paste an `orderId` (read from the list
  above, or from wherever the POS/customer surfaces it), looks it up via the webhook, and proceeds
  with the same confirmation flow as before.

## Member/loyalty: name+phone collection and points accrual

As of 2026-07-18 the POS exposes member actions (`getMemberProfile`, `listMembers`, `createMember`,
`updateMember`), so Clawbot now registers a member automatically instead of leaving orders anonymous.

- **Name/phone collection gate** (`core/orderService.js`): a customer with no `displayName` on file
  is asked for their name, then their phone, before any other command is processed (button taps and
  other free text during collection just re-prompt). This runs via a `contextData.profileStep` flag
  (`awaiting_name`/`awaiting_phone`/`null`) alongside `currentState`, not as a real state-machine
  transition. Typing "bỏ qua"/"bo qua"/"skip" for the phone step skips member resolution entirely —
  name-only customers are supported.
- **`MemberRepository.gs`** (optional `dependencies.memberRepository`, duck-typed
  `{resolve({name, phone}): {memberId}|null}`): finds an existing POS member by exact phone match via
  `listMembers(phone)`, or creates one via `createMember` if none exists. `id`/`points`/`totalSpend`
  are POS-owned and never sent on write. A POS outage during resolution is swallowed — ordering must
  never block on this — so `customer.memberId` simply stays unset for that session.
- **`Customers` sheet** gained a 5th column, `memberId` (nullable), alongside the existing
  `phone`/`displayName`.
- **`memberId` flows into `createOrder`**: `BotOrderRepository.save()` passes `order.memberId` through
  to `BotOrderWebhookClient.createOrder()`, which attaches it to the order payload only when present.
  This lets the POS's own loyalty pipeline accrue points on `completeOrder` — Clawbot never writes
  points directly.
- **Ops notification shows the customer name**: `confirm_order`'s outbound text now carries
  `customerName`, threaded through `confirmedOrderSummary` in both `telegram/webhook.gs` and
  `zalo/webhook.gs` into `OperationsNotifier.operationsOrderText()`, which renders a `Khách: <name>`
  line (omitted entirely if no name was ever collected, e.g. very old customers pre-dating this
  feature).
- **Fast Path is unaffected.** The Telegram Fast Path (Cloudflare Worker/D1) does not wire a
  `memberRepository` into its `OrderService.create(...)` call in `fastpath.ts`, so member
  resolution/loyalty only happens for the GAS/POS-routed flow, not Fast Path orders. This is
  consistent with Fast Path being kept intentionally separate from the POS integration.

## What still uses Sheets

`SheetOrderRepository.gs` and its test remain in the repo, fully working and unit-tested, but nothing
in the live app wires it in anymore — kept only in case of rollback. `Customers`, `ConversationStates`,
`ProcessedUpdates`, `ErrorLogs`, `OperationMetrics`, and the Fast Path sync tables are unaffected.
