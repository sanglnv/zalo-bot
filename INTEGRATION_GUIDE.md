# Zalo Clawbot — Integration Guide (Tech)

Tài liệu kỹ thuật tổng hợp cho dev tích hợp/vận hành/mở rộng hệ thống. Đây là bản consolidation của toàn bộ README + quyết định kiến trúc qua 5 phase, viết lại theo mạch một người mới join có thể đọc từ trên xuống và triển khai được ngay.

## 1. Kiến trúc tổng quan

Runtime: 100% Google Apps Script (GAS), không có server riêng. Datastore: 1 Google Sheet duy nhất. Hai kênh chat: Telegram Bot API và Zalo OA, cùng chia sẻ 1 core logic không biết gì về nền tảng chat.

```
Webhook (Telegram / Zalo) ──► doPost (webhookRouter.gs)
                                   │
                                   ├─► adapter riêng từng platform (map inbound, render outbound)
                                   │
                                   ▼
                         OrderService (src/core) ── platform-agnostic
                                   │
                                   ▼
                    Sheet repositories (Orders, Customers, ConversationStates, ...)
```

Nguyên tắc bất biến xuyên suốt dự án: **`src/core/` không bao giờ import `SpreadsheetApp`, `UrlFetchApp`, `LockService`, hay bất kỳ tên nền tảng nào (`telegram`, `zalo`)**. Việc này được enforce tự động bằng `scripts/check-core-boundaries.js`, chạy trong `npm run check`.

## 2. Cấu trúc thư mục

```
/src
  /core                     # domain logic thuần, test được bằng Node, không phụ thuộc GAS
    domain.js               # type contracts: Customer, Order, Payment, InboundMessage, OutboundMessage...
    stateMachine.js         # pure state machine (xem Mục 4)
    billing.js               # tính bill/discount
    repositoryContracts.js   # duck-typing contract cho repository injection
    orderService.js           # orchestration: handleMessage, confirmPayment, expireOrder
  /repositories              # Google Sheet repository (.gs) — CHỈ nơi được phép gọi SpreadsheetApp
  /adapters
    /telegram                # webhook.gs, mapInboundMessage.js, renderOutboundMessage.js, TelegramClient.gs, TelegramRuntime.gs
    /zalo                    # tương tự Telegram + verifyWebhookSignature.js, ZaloTokenManager.gs, ZaloClient.gs, ZbsTemplateClient.gs
    webhookRouter.gs          # doPost() TOÀN CỤC DUY NHẤT, route theo platform
    notificationDispatcher.js # pure: gửi OutboundMessage[] tới đúng platform theo registry
    NotificationRegistry.gs   # wiring registry thật (Telegram Send API, Zalo Send API/ZBS)
  /admin
    PaymentConfirmation.gs / paymentConfirmation.js   # menu Sheet xác nhận thanh toán thủ công
    PaymentExpiry.gs / paymentExpiry.js               # scan + hết hạn tự động theo lịch
    Metrics.gs                                         # recordDuration wrapper
  /tests                     # Node test, 65 test hiện tại, chạy ngoài GAS hoàn toàn
scripts/check-core-boundaries.js
docs/state-machine-audit.md
```

## 3. Core contract — không được phá vỡ khi mở rộng

```js
InboundMessage  { platform: string, platformUserId: string, text: string, payload: Object|null }
OutboundMessage { type: 'text'|'list'|'button'|'image', content: Object }

OrderService.create(dependencies) => {
  handleMessage(inboundMessage) -> OutboundMessage[]
  confirmPayment(orderId, confirmedBy) -> { customer, outboundMessages }   // throws OrderNotFoundError | PaymentAlreadyResolvedError
  expireOrder(orderId) -> { customer, outboundMessages }                   // cùng 2 loại lỗi trên
}
```

`dependencies` bắt buộc: `orderRepository`, `customerRepository`, `conversationStateRepository` (theo contract trong `repositoryContracts.js`), `getCatalog()`, `createQrContent(order)`, `createId()`, `now()`, và `withLock(fn)`. Trong GAS, `withLock` luôn là `SheetRepositorySupport.withScriptLock` — đây là lock toàn cục duy nhất của cả script, dùng chung cho mọi entry point (webhook Telegram, webhook Zalo, menu Sheet, trigger định kỳ).

Một adapter chỉ có đúng 3 việc: map webhook → `InboundMessage`, gọi `handleMessage`, render từng `OutboundMessage` ra đúng API của nền tảng đó. Không được thêm business logic vào adapter.

## 4. State machine

```
IDLE → BROWSING → CART ⟲(ADD_TO_CART) → CONFIRMING → AWAITING_PAYMENT → PAID → DONE (chưa có caller, xem docs/state-machine-audit.md)
                                                     ↘ CANCELLED (từ nhiều state)
                                                     ↘ EXPIRED (qua expireOrder)
```

`PAID` là điểm kết thúc thực tế theo scope hiện tại (quyết định đã ghi trong `docs/state-machine-audit.md`) — không có luồng nào tự động đưa đơn sang `DONE`.

## 5. Pattern bắt buộc phải tái sử dụng khi thêm bất kỳ platform/tính năng mới nào

Đây là các pattern đã bị phát hiện thiếu qua review và fix xuyên suốt 5 phase — **bắt buộc áp dụng ngay từ đầu cho code mới, không phải việc "phát hiện lại"**:

1. **Idempotency theo message id của platform** (`update_id` Telegram / `msg_id` Zalo): kiểm tra + đánh dấu "đã nhận" phải nằm trong cùng `withLock` với phần xử lý nghiệp vụ.
2. **Tách 3 tầng trạng thái của 1 lượt webhook**: đã nhận (`processedUpdateRepository.has/markProcessed`) → đã xử lý xong nghiệp vụ → đã gửi phản hồi thành công cho khách (`deliveryStatus: pending/delivered/failed`). Khi gửi phản hồi thất bại sau khi nghiệp vụ đã commit, phải gửi 1 tin fallback độc lập và log đủ context để nhân viên tự xử lý tay — không được để khách im lặng không nhận được gì.
3. **Tách lỗi "nghiệp vụ thất bại thật" khỏi "nghiệp vụ thành công nhưng gửi thông báo thất bại"** ở mọi hàm gọi `confirmPayment`/`expireOrder` rồi dispatch — dùng `reason` riêng (`confirmed_but_notification_failed`, `expired_but_notification_failed`), không dùng chung 1 nhánh lỗi generic.
4. **`requireAwaitingPayment`/guard dùng chung** giữa `confirmPayment` và `expireOrder` — không copy-paste logic kiểm tra state.
5. **Mọi thao tác ghi Sheet** đi qua `SheetRepositorySupport.withScriptLock`, kể cả khi lock đã được giữ ở tầng ngoài (`lockDepth` tự phát hiện reentrant, không double-acquire).

## 6. Thiết lập & deploy — Telegram

Script Properties bắt buộc: `SPREADSHEET_ID`, `TELEGRAM_BOT_TOKEN`, `CATALOG_JSON`, `VIETQR_BANK_ID`, `VIETQR_ACCOUNT_NO`, `VIETQR_ACCOUNT_NAME`, `WEB_APP_URL`, `TELEGRAM_WEBHOOK_URL`, `TELEGRAM_WEBHOOK_SECRET`, `GAS_GATEWAY_TOKEN`. Tuỳ chọn: `VIETQR_TEMPLATE` (default `compact2`), `VIETQR_TRANSFER_PREFIX` (default `DH`), `SUPPORT_CONTACT`, `PAYMENT_TIMEOUT_MINUTES` (default `30`).

```sh
clasp login
clasp create-script --title "Zalo Clawbot" --type standalone --rootDir .
clasp push
```

Sau đó:

1. Deploy → New deployment → Web app (Execute as deploying user, Anyone access), copy URL `/exec` vào `WEB_APP_URL`.
2. Vào `telegram-gateway/`, tạo 2 Cloudflare Queue `zalo-clawbot-telegram` và `zalo-clawbot-telegram-dlq`, cấu hình 5 Worker secret theo `telegram-gateway/README.md` (bao gồm `TELEGRAM_OPERATIONS_CHAT_ID` để nhận cảnh báo DLQ), rồi chạy `npm run check` và `npm run deploy`.
3. Copy URL Worker vào Script Property `TELEGRAM_WEBHOOK_URL`. `TELEGRAM_WEBHOOK_SECRET` và `GAS_GATEWAY_TOKEN` phải khớp theo từng cặp giữa GAS và Worker; đây là 2 secret khác nhau.
4. Push/deploy GAS mới nhất, chạy `setupProject()` hoặc `registerWebhook(false)` 1 lần trong Apps Script editor.
5. Chạy `healthCheck()`: `telegramWebhook.status` phải là `ok`, `url === expectedUrl`, queue chờ bằng 0 và không có `lastErrorMessage` mới.

Không đăng ký Telegram thẳng vào `WEB_APP_URL?platform=telegram`. Router GAS chỉ nhận update Telegram có `gateway_token` hợp lệ do Worker thêm; request Telegram-shaped không qua gateway được trả `OK` nhưng không chạy nghiệp vụ.

## 7. Thiết lập & deploy — Zalo OA

Script Properties bắt buộc: `ZALO_APP_ID`, `ZALO_APP_SECRET`, `ZALO_OA_SECRET_KEY`, `ZALO_ACCESS_TOKEN`, `ZALO_REFRESH_TOKEN`, `ZALO_ACCESS_TOKEN_EXPIRES_AT`, `ZALO_ZBS_PAYMENT_CONFIRMED_TEMPLATE_ID`, `ZALO_ZBS_ORDER_EXPIRED_TEMPLATE_ID`.

Việc thủ công bắt buộc trước khi bật kênh Zalo (không tự động hoá được):

1. Tạo + xác thực Zalo OA, liên kết app developer, bật quyền webhook/tin nhắn, mua gói dịch vụ OA có API (tối thiểu gói Tăng trưởng).
2. Đăng ký và chờ duyệt 2 template ZBS: "Xác nhận thanh toán" và "Đơn hàng hết hạn" (biến `order_id`, `message` — nếu tên biến duyệt khác, chỉ sửa `renderZbsTemplateMessage.js`).
3. Thực hiện OAuth lần đầu qua trình duyệt, rồi chạy `bootstrapZaloTokens(accessToken, refreshToken, expiresInSeconds)` 1 lần trong Apps Script editor.
4. **Dựng gateway ký chuyển tiếp** (bắt buộc — xem Mục 8) và đăng ký URL gateway làm webhook Zalo.

### Vì sao cần gateway riêng cho Zalo

Zalo ký webhook qua header `X-ZEvent-Signature` (`mac = sha256(appId + rawBody + timestamp + OAsecretKey)` — đây là SHA-256 nối chuỗi, không phải HMAC chuẩn). GAS `doPost(e)` **không expose header tuỳ ý**, chỉ có query string và raw body. Do đó bắt buộc 1 gateway HTTPS nhỏ (Cloudflare Worker / Cloud Run / API Gateway) đặt trước GAS:

1. Đọc `X-ZEvent-Signature`, không sửa raw body.
2. Forward nguyên body tới `WEB_APP_URL?platform=zalo&signature=<đã URL-encode>`.
3. Trả response của GAS lại cho Zalo, không log signature/body như credential.

Gateway này **không nằm trong repo**, không test được bằng `npm test` — phải tự dựng và test thật trước khi mở kênh Zalo cho khách.

### OAuth token — điểm vận hành rủi ro nhất

Access token sống 25 giờ; mỗi lần refresh trả về `refresh_token` mới và **refresh_token cũ mất hiệu lực ngay**. `ZaloTokenManager.getValidAccessToken()` gói toàn bộ đọc/kiểm tra/refresh/ghi trong `withScriptLock` — 2 execution GAS cùng phát hiện hết hạn sẽ tự serialize, chỉ 1 bên refresh thật, bên kia dùng lại token vừa lưu. Không tự ý bỏ lock này khi sửa code.

### Send API thường vs ZBS Template Message

| Ngữ cảnh | Client | Vì sao |
| --- | --- | --- |
| Trả lời trực tiếp trong `handleMessage` (catalog, cart, checkout, confirm/cancel, QR) | OA Send API (`ZaloClient`) | Luôn trong vòng 48h vì là phản hồi tức thời cho tin khách vừa gửi |
| `confirmPayment` (nhân viên bấm menu) | ZBS Template (`ZbsTemplateClient`) | Có thể xảy ra ngoài 48h |
| `expireOrder` (chạy theo lịch) | ZBS Template (`ZbsTemplateClient`) | Có thể xảy ra ngoài 48h |

`NotificationRegistry.gs` cố tình dùng 2 client khác nhau cho cùng 1 platform — không được gộp lại.

## 8. Vận hành sau khi deploy

```js
registerSheetMenuTrigger();       // 1 lần — menu Sheet xác nhận thanh toán thủ công
registerPaymentExpiryTrigger();   // 1 lần — quét đơn quá hạn mỗi 10 phút
```

Cả 2 hàm đều idempotent (kiểm tra trigger đã tồn tại trước khi tạo lại).

Sheet tabs được tự tạo ở lần ghi đầu tiên: `Orders`, `Customers`, `ConversationStates`, `ProcessedUpdates` (Telegram), `ZaloProcessedUpdates` (Zalo — tách riêng theo `msg_id` để tránh đụng độ với `update_id` Telegram), `ErrorLogs`, `OperationMetrics`.

`OperationMetrics` chỉ là số liệu thô (`timestamp`, `operation`, `durationMs`) cho `doPost`, `confirmSelectedOrderPayment`, `scanAndExpireStalePayments` — chưa có ngưỡng quyết định sẵn; dùng để tự đánh giá khi cân nhắc chuyển từ Sheet sang Supabase.

## 9. Test & CI cục bộ

```sh
npm test               # 65 test, Node >= 18, không cần cài dependency ngoài devDependencies test
npm run check:boundaries
npm run check           # cả 2
```

Kỹ thuật mock dùng xuyên suốt: `require.extensions['.gs'] = require.extensions['.js']` để require file `.gs` như module Node; mock `global.SpreadsheetApp`/`global.UrlFetchApp`/`global.LockService`/`global.PropertiesService` theo hành vi tối giản đúng ngữ nghĩa GAS thật (đặc biệt: mô phỏng 2 "execution" độc lập bằng 2 `require()` riêng của `SheetRepositorySupport.gs` khi cần test race thật, không dùng chung 1 instance).

## 10. Mở rộng thêm 1 platform mới (ví dụ Facebook Messenger)

1. Tạo `src/adapters/<platform>/` với đúng 4 file: `mapInboundMessage.js`, `renderOutboundMessage.js`, `<Platform>Client.gs`, `webhook.gs` — theo khuôn Telegram.
2. Idempotency theo message id riêng của platform, sheet `ProcessedUpdates` riêng nếu định dạng id có thể đụng độ.
3. Đăng ký entry mới trong `NotificationRegistry.gs` cho `confirmPayment`/`expireOrder` dispatch — không sửa `notificationDispatcher.js`.
4. Thêm route trong `webhookRouter.gs` (theo `e.parameter.platform` hoặc field nhận diện riêng của payload).
5. Áp dụng nguyên vẹn 5 pattern ở Mục 5 — review sẽ từ chối nếu thiếu bất kỳ pattern nào.
6. Không sửa `src/core/` trừ khi thực sự cần thêm domain concept mới (hiếm khi cần cho adapter thuần).

## 11. Giới hạn đã biết / việc chưa làm

- Lock toàn cục GAS serialize *toàn bộ* traffic (mọi platform, mọi thao tác) — chấp nhận được ở quy mô nhỏ hiện tại, cần đánh giá lại nếu traffic tăng (xem `OperationMetrics`).
- `PAID → DONE` (hoàn tất/giao hàng) chưa có caller — quyết định có chủ đích, xem `docs/state-machine-audit.md`.
- Gateway ký Zalo là hạ tầng ngoài repo, không có test tự động — phải test tay trước khi go-live kênh Zalo.
- Không có APM/dashboard cho `OperationMetrics`, chỉ là dữ liệu thô.
