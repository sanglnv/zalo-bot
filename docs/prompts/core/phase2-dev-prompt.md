# Prompt cho dev / AI coding agent — Phase 2: Telegram adapter

Dán nguyên văn cho dev khi bắt đầu implement. Phase 1 (core domain, platform-agnostic) đã done và đã qua review — không được sửa bất kỳ file nào trong `src/core/` ở phase này. Nếu thấy cần sửa core để adapter chạy được, dừng lại và báo cáo trước, đừng tự ý sửa.

## Bối cảnh

Core hiện có sẵn:
- `OrderService.create(dependencies)` trả về `{ handleMessage(inboundMessage) → outboundMessage[] }`.
- Contract bắt buộc: `InboundMessage { platform, platformUserId, text, payload }`, `OutboundMessage { type: 'text'|'list'|'button'|'image', content }`.
- `dependencies.withLock` bắt buộc phải là `SheetRepositorySupport.withScriptLock` khi chạy thật trên GAS (đã ghi trong README) — đây là lock bọc toàn bộ 1 lượt xử lý tin nhắn, không được bỏ qua khi wiring.
- Repository Sheet (`SheetOrderRepository`, `SheetCustomerRepository`, `SheetConversationStateRepository`) đã sẵn sàng dùng thẳng.
- Idempotency theo `messageId`/`update_id` được ghi nhận là backlog của Phase 2 trong README Phase 1 — nghĩa là **phase này phải giải quyết nó**, không được đẩy tiếp.

Nhiệm vụ Phase 2: xây adapter để bot chạy thật trên Telegram, KHÔNG đụng vào core, và giữ được tính testable đã có.

## Yêu cầu bắt buộc

### 1. Tách adapter thành 2 lớp: pure mapping và GAS glue

Để giữ được khả năng unit test ngoài GAS (bài học từ Phase 1), **không được viết logic mapping/rendering trộn lẫn với lệnh gọi `UrlFetchApp` trong cùng 1 hàm**. Cấu trúc bắt buộc:

```
/src/adapters/telegram
  mapInboundMessage.js       // pure: Telegram update object -> InboundMessage
  renderOutboundMessage.js   // pure: OutboundMessage -> { method, params } mô tả lệnh gọi Telegram Bot API
  TelegramClient.gs          // GAS glue: nhận { method, params }, thực sự gọi UrlFetchApp
  webhook.gs                 // doPost entry point: parse JSON, gọi mapInboundMessage, orderService.handleMessage, renderOutboundMessage, TelegramClient
```

`mapInboundMessage.js` và `renderOutboundMessage.js` phải chạy được bằng Node thuần (không import `UrlFetchApp`/`PropertiesService`) để viết unit test giống style `src/tests/*.test.js` ở Phase 1.

### 2. Mapping Inbound — 2 dạng update cần xử lý

Telegram gửi 2 loại update khác nhau qua cùng 1 webhook:
- `update.message` — tin nhắn text thường. Map: `platform: 'telegram'`, `platformUserId: String(update.message.chat.id)`, `text: update.message.text || ''`, `payload: null`.
- `update.callback_query` — khi khách bấm nút inline keyboard (catalog, confirm, cancel). Map: `platformUserId: String(update.callback_query.message.chat.id)`, `text: ''`, `payload` giải mã từ `callback_query.data`.

Lưu ý bắt buộc: `callback_data` của Telegram giới hạn 64 byte — không được nhét JSON đầy đủ `{action, productId, quantity}` vào đó. Dùng format compact dạng chuỗi, ví dụ `add_item:p1:2` (action:productId:quantity), rồi parse lại trong `mapInboundMessage.js` thành `payload.action`, `payload.productId`, `payload.quantity`. Viết test riêng cho việc encode/decode format này, kể cả trường hợp thiếu quantity.

Nếu update không phải `message` cũng không phải `callback_query` (Telegram có nhiều loại update khác), `mapInboundMessage` phải trả `null` và `webhook.gs` bỏ qua, không gọi `orderService.handleMessage` với input rác.

### 3. Idempotency theo `update_id` — bắt buộc, không được bỏ qua

Telegram sẽ gửi lại webhook nếu không nhận được response 200 trong thời gian timeout của nó. Phải chặn xử lý trùng:
- Thêm 1 repository mới `SheetProcessedUpdateRepository.gs` (cùng pattern với các repository khác trong Phase 1: có lock, có sheet riêng tên `ProcessedUpdates`, cột `updateId, processedAt`).
- Trong `webhook.gs`: trước khi gọi `orderService.handleMessage`, kiểm tra `update.update_id` đã tồn tại trong sheet chưa — nếu có thì bỏ qua và trả về 200 ngay (không xử lý lại, không throw lỗi). Nếu chưa có, ghi nhận `update_id` trước hoặc trong cùng transaction rồi mới xử lý.
- Việc kiểm tra + ghi `update_id` cũng phải nằm trong cùng phạm vi `withLock` như phần xử lý tin nhắn, để tránh chính bản thân bước kiểm tra idempotency lại bị race.

### 4. Rendering Outbound — map từng `type` sang đúng Telegram Bot API method

- `text` → `sendMessage` với `chat_id`, `text`.
- `list` (catalog) → `sendMessage` kèm `reply_markup.inline_keyboard`, mỗi sản phẩm 1 hàng nút, `callback_data` dạng `add_item:<productId>:1`.
- `button` (xác nhận/huỷ) → `sendMessage` kèm `reply_markup.inline_keyboard` build từ `content.buttons` (đã có `action`/`label` sẵn từ core).
- `image` (QR thanh toán) → `sendPhoto` với `photo` là **URL trực tiếp** trả về từ VietQR (không tự tải ảnh về rồi upload binary qua GAS — Telegram tự fetch URL, tránh phải xử lý Blob trong GAS gây phức tạp không cần thiết). Nghĩa là `createQrContent` (dependency đã có từ Phase 1) phải trả về 1 URL ảnh QR, không phải base64 hay JSON.
- Sau khi xử lý `callback_query`, bắt buộc gọi thêm `answerCallbackQuery` (để tắt icon loading trên nút phía Telegram client) — đây là lệnh phụ, không đến từ `OutboundMessage` của core, nên gọi riêng trong `webhook.gs` sau khi có `callback_query.id`, không nhét vào `renderOutboundMessage.js`.

### 5. `webhook.gs` — ràng buộc GAS bắt buộc

- `doPost(e)` phải luôn trả về `ContentService` response 200 kể cả khi xử lý nội bộ lỗi (không để GAS trả 500 — Telegram sẽ coi là chưa nhận được và retry vô hạn, gây loop). Bắt lỗi bằng try/catch bao quanh toàn bộ logic, log lỗi vào 1 sheet riêng (đã có pattern log lỗi được đề cập ở lộ trình gốc, nếu chưa có thì tạo `SheetErrorLogRepository.gs` đơn giản: `timestamp, context, message, stack`).
- Không polling `getUpdates` — dùng webhook (`setWebhook`) hoàn toàn, phải có hướng dẫn/script 1 lần để gọi `setWebhook` trỏ về URL Web App đã deploy (ghi vào README Phase 2, có thể làm 1 hàm `registerWebhook()` gọi thủ công từ Apps Script editor, không cần chạy tự động).
- Token bot lấy qua `PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN')` — không hardcode.
- Vì `withLock` serialize toàn bộ traffic (quyết định đã chốt ở Phase 1), giữ mọi lệnh gọi `UrlFetchApp` trong `webhook.gs`/`TelegramClient.gs` ngắn gọn, không thêm bất kỳ vòng lặp chờ (`Utilities.sleep`) nào trong luồng xử lý webhook.

### 6. Testability

- `mapInboundMessage.js`, `renderOutboundMessage.js`: unit test thuần Node, cover cả 2 loại update, cả 4 loại `OutboundMessage`, cả trường hợp update không xác định (trả `null`), cả encode/decode `callback_data`.
- `TelegramClient.gs`/`webhook.gs`: test theo đúng kỹ thuật đã dùng ở `sheetRepositoryLock.test.js` (mock `UrlFetchApp`, `PropertiesService`, `LockService` bằng `global.*`, `require.extensions['.gs']`). Viết ít nhất 1 test end-to-end giả lập: gửi 1 update Telegram giả (dạng JSON thật của Telegram) vào `doPost`, xác nhận `UrlFetchApp.fetch` được gọi đúng method/params mong đợi, và xác nhận gửi lại đúng `update_id` lần 2 thì không tạo thêm order/side-effect nào (test idempotency thực sự, không chỉ đọc code).

## Cấu trúc thư mục hoàn chỉnh sau Phase 2

```
/src
  /core            (không đổi — không sửa)
  /repositories
    SheetOrderRepository.gs
    SheetCustomerRepository.gs
    SheetConversationStateRepository.gs
    SheetProcessedUpdateRepository.gs   // mới
    SheetErrorLogRepository.gs          // mới, nếu chưa có
  /adapters
    /telegram
      mapInboundMessage.js
      renderOutboundMessage.js
      TelegramClient.gs
      webhook.gs
  /tests
    ...(giữ nguyên các test Phase 1)
    telegram/mapInboundMessage.test.js
    telegram/renderOutboundMessage.test.js
    telegram/webhook.test.js
```

## Acceptance criteria

1. `npm test` và `npm run check:boundaries` (Phase 1) vẫn pass nguyên vẹn — không file nào trong `src/core` bị đổi.
2. Test mới cho `mapInboundMessage`/`renderOutboundMessage` pass, cover cả `message` và `callback_query`, cả input rác.
3. Test idempotency: gửi cùng 1 `update_id` 2 lần, xác nhận lần 2 không gọi `orderService.handleMessage` (hoặc gọi nhưng không tạo side-effect trùng), và cả 2 lần đều trả về response thành công cho Telegram (không phải lỗi).
4. Test end-to-end catalog → add 2 món khác nhau → checkout → confirm → nhận đúng lệnh `sendPhoto` với URL QR.
5. Deploy thử thật lên GAS Web App, gọi `setWebhook` trỏ về URL đó, nhắn tin thật từ Telegram, xác nhận luồng chạy đúng tay-to-tay ngoài đời thật (không chỉ test giả lập) trước khi coi Phase 2 là done.
6. README cập nhật thêm mục "Telegram adapter" giải thích cách deploy + gọi `setWebhook`, và ghi rõ vị trí đặt idempotency check để Phase 5 (Zalo adapter) áp dụng đúng pattern tương tự (Zalo cũng có khái niệm tương đương cần dedupe).
