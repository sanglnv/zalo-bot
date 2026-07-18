# Prompt cho dev — Fix các lỗi từ code review toàn bộ codebase

Dán nguyên văn cho dev. Review gốc dùng skill `gas-code-review` (4 hạng mục: Security & Authorization, GAS Platform Constraints, Architecture & Testability, Data Integrity), phạm vi toàn bộ `src/` (GAS backend) + `telegram-gateway/` (Cloudflare Worker fast-path). Không có lỗi Critical. Thứ tự dưới đây là thứ tự ưu tiên fix (High trước, Low có thể gộp vào một PR dọn dẹp riêng).

---

## 🟠 High #1 — Một global script lock cho toàn hệ thống

**File**: `src/repositories/SheetRepositorySupport.gs` (`withScriptLock`), được gọi bởi mọi Sheet repo (`SheetCustomerRepository`, `SheetConversationStateRepository`, `SheetProcessedUpdateRepository`, `SheetZaloProcessedUpdateRepository`, `SheetOrderRepository`) và `ZaloTokenManager.gs`.

**Vấn đề**: `withScriptLock` dùng `LockService.getScriptLock()` — một lock DUY NHẤT cho toàn bộ script. Mọi webhook Zalo, mọi webhook Telegram khi fast-path tắt, và refresh token Zalo đều tranh nhau đúng một lock này, không scope theo `customerId`/order. Hai khách hoàn toàn không liên quan nhắn tin cùng lúc vẫn bị serialize; khi lock timeout (30s), code throw `'Could not acquire script lock within 30 seconds'` và khách nhận fallback error message dù chẳng có xung đột dữ liệu thật.

**Fix bắt buộc**:

1. Thêm khả năng lock theo scope hẹp hơn global — cách khả thi nhất trong giới hạn GAS: dùng `LockService.getScriptLock()` vẫn là cơ chế lock duy nhất GAS cho (không có lock theo key built-in), nhưng **giảm thời gian giữ lock** bằng cách tách rõ phần bắt buộc phải nằm trong lock (đọc-sửa-ghi state của MỘT customer) khỏi phần không cần (gọi `BotOrderWebhookClient`/`UrlFetchApp` ra ngoài POS — hiện đang nằm lồng bên trong `withScriptLock` ở nhiều chỗ, ví dụ `BotOrderRepository.save()` được gọi từ trong `handleMessage`'s `withLock`).
2. Cụ thể: audit lại `createOrderService`'s `handleMessage` (`src/core/orderService.js`) — toàn bộ `handleMessageTransaction` chạy trong `dependencies.withLock(...)`, và bên trong nó gọi `orderRepository.save()` → với `BotOrderRepository` là một `UrlFetchApp.fetch()` ra ngoài (network call giữ lock!). Tách UrlFetchApp calls ra khỏi vùng giữ lock nếu về mặt nghiệp vụ cho phép (cân nhắc kỹ vì đây cũng là nơi đảm bảo tính nhất quán — cần review riêng, đừng tự ý đổi mà không có test tái hiện race).
3. Tối thiểu, đo và log rõ `waitMs` mỗi lần lock timeout ra `ErrorLogs` (hiện chỉ có `console.warn` khi `waitMs >= 1000`, không log khi lock THẤT BẠI hẳn) để có dữ liệu thật về mức độ nghẽn trước khi quyết định giải pháp sâu hơn.
4. Việc so sánh 2 hướng thiết kế (giữ global lock nhưng giảm critical section, vs migrate Zalo path sang kiến trúc fast-path kiểu Telegram) nên là quyết định kiến trúc riêng — không tự ý implement lớn trong PR fix bug này. PR này chỉ cần: (a) đo lường + log lock timeout ra `ErrorLogs`, (b) audit và liệt kê mọi network call đang nằm trong vùng lock, viết thành báo cáo ngắn cho quyết định tiếp theo.

**Acceptance criteria**:
- `ErrorLogs` có entry rõ ràng mỗi khi lock timeout, kèm `stage: 'script_lock_timeout'`.
- Có danh sách (comment hoặc doc ngắn trong `docs/`) liệt kê tất cả các `UrlFetchApp.fetch` hiện đang chạy bên trong `withScriptLock`.
- Không thay đổi hành vi nghiệp vụ hiện tại — đây là PR đo lường + chuẩn bị, không phải PR redesign lock.

---

## 🟠 High #2 — Quét tuyến tính toàn bộ Sheet mỗi tin nhắn (không có index)

**File**: `src/repositories/SheetCustomerRepository.gs` (`findByPlatformUserId`), `SheetConversationStateRepository.gs` (`get`), `SheetProcessedUpdateRepository.gs`/`SheetZaloProcessedUpdateRepository.gs` (`has`).

**Vấn đề**: Mỗi tin nhắn khách gửi vào (kể cả `/start`) trigger `getValues()` toàn bộ sheet rồi `.find()`/`.some()` tuyến tính. Không sao ở quy mô nhỏ, nhưng compound theo số khách × số tin nhắn — đúng loại lỗi "ổn hôm nay, outage khi data lớn".

**Fix bắt buộc**:

1. Thêm cache tra cứu nhanh cho `findByPlatformUserId`: dùng `CacheService.getScriptCache()` với key `customer:<platform>:<platformUserId>` → `customerId`, TTL ngắn (vài phút là đủ, vì mapping platform→customer gần như không đổi sau lần đầu). **Lưu ý theo gas-pitfalls #6**: cache có thể bị evict sớm — code phải luôn fallback về quét sheet khi cache miss, KHÔNG được coi cache là nguồn dữ liệu duy nhất.
2. Với `SheetProcessedUpdateRepository.has()`/`markProcessed()` — đây là hot path nhất (gọi mỗi update). Cân nhắc thêm cache tương tự cho `updateId` gần đây (TTL vài phút đủ để dedupe hầu hết retry của Telegram/Zalo, vốn xảy ra trong vài giây tới vài phút).
3. KHÔNG cần fix trong PR này: việc chuyển hẳn sang datastore có index thật (Supabase/D1) — đó là quyết định kiến trúc lớn hơn, ghi lại thành ghi chú riêng nếu số lượng khách vượt một ngưỡng cụ thể (đề xuất: theo dõi số dòng `Customers` sheet, cảnh báo khi > 2000 dòng).

**Acceptance criteria**:
- `findByPlatformUserId` có test xác nhận cache hit không đọc sheet (đếm số lần gọi `SpreadsheetApp`/mock), và cache miss vẫn trả đúng kết quả + tự động populate cache.
- Test xác nhận nếu cache trả về `customerId` không còn tồn tại trong sheet (dữ liệu bị xoá tay), code không throw mà fallback quét sheet.
- `npm test` pass toàn bộ.

---

## 🟠 High #3 — Coupling ẩn giữa text tiếng Việt và chọn ZBS template

**File**: `src/adapters/zalo/renderZbsTemplateMessage.js:9-14`, nguồn text đến từ `src/core/orderService.js` (`confirmPayment`/`expireOrder`'s outbound text).

**Vấn đề**: `renderZbsTemplateMessage` suy luận loại thông báo (xác nhận thanh toán vs hết hạn) bằng cách match chuỗi con `'đã hết hạn'` / `'Đã xác nhận thanh toán'` trong nội dung text do `orderService.js` sinh ra — hai file này không có ràng buộc kiểu hay test liên kết. Sửa câu chữ ở `orderService.js` (kể cả sửa chính tả) làm khách Zalo lặng lẽ không nhận được thông báo nữa (throw `'No ZBS template mapping'`, bị nuốt thành `confirmed_but_notification_failed`) dù thanh toán đã được xác nhận thật trong hệ thống.

**Fix bắt buộc**:

1. Thêm field tường minh vào outbound message ở `src/core/orderService.js`: trong `confirmPayment()` đổi
   ```js
   outboundMessages: [outbound('text', {
     text: 'Đã xác nhận thanh toán cho đơn #' + orderId + '. Cảm ơn bạn!',
     orderId: orderId
   })]
   ```
   thành thêm `kind: 'payment_confirmed'` vào `content`. Tương tự `expireOrder()` thêm `kind: 'payment_expired'`.
2. Sửa `renderZbsTemplateMessage.js` để chọn template dựa trên `message.content.kind`, không match text nữa:
   ```js
   if (message.content.kind !== 'payment_confirmed' && message.content.kind !== 'payment_expired') {
     throw new Error('No ZBS template mapping for kind: ' + message.content.kind);
   }
   ```
3. Kiểm tra toàn bộ nơi khác đang đọc `outboundMessages` có phụ thuộc vào đúng câu chữ hiện tại không (grep `'đã hết hạn'`, `'Đã xác nhận thanh toán'` trong `src/`) — nếu có chỗ khác cũng đang suy luận từ text, áp dụng cùng cách sửa (thêm field tường minh).
4. Cập nhật `src/tests/zalo/zbs.test.js`: thêm test xác nhận đổi câu chữ trong `orderService.js` (mock outbound text khác đi nhưng giữ `kind` đúng) KHÔNG làm hỏng việc chọn template — đây là regression test trực tiếp cho lỗi đã tìm thấy.

**Acceptance criteria**:
- `renderZbsTemplateMessage` không còn `indexOf`/match text nào để quyết định logic, chỉ đọc `content.kind`.
- Test mới: đổi text tuỳ ý trong outbound message giả (miễn giữ `kind` đúng) → vẫn chọn đúng `templateId`.
- Test cũ (nếu có test dựa vào text cụ thể) được cập nhật tương ứng.
- `npm test` pass toàn bộ.

---

## 🟠 High #4 — `TELEGRAM_ADMIN_USER_IDS` fail-open ở GAS, fail-closed ở Worker

**File**: `src/admin/OperationsNotifier.gs` (`isAuthorizedOpsAdmin`) vs `telegram-gateway/src/index.ts` (`telegramAdminEnabled`, `telegramAdminActorId`).

**Vấn đề**: Cùng biến `TELEGRAM_ADMIN_USER_IDS`, nhưng GAS coi "chưa cấu hình" = "ai cũng là admin" (fail-open), Worker coi "chưa cấu hình" = "không ai là admin" (fail-closed). Khi fast-path bật (mặc định), `/thanhtoan` luôn bị Worker chặn trước nên logic GAS gần như chết — nhưng khi fast-path tắt hoặc lệch cấu hình, đường GAS sống lại với default fail-open, im lặng nới quyền nếu quên set biến.

**Fix bắt buộc**:

1. Đổi `isAuthorizedOpsAdmin` trong `OperationsNotifier.gs` sang fail-closed để nhất quán với Worker:
   ```js
   function isAuthorizedOpsAdmin(userId) {
     var raw = PropertiesService.getScriptProperties().getProperty('TELEGRAM_ADMIN_USER_IDS');
     if (!raw) {
       if (typeof console !== 'undefined' && console.warn) {
         console.warn(JSON.stringify({ event: 'ops_admin_allowlist_not_configured' }));
       }
       return false;
     }
     return raw.split(',').map(function (id) { return id.trim(); }).filter(Boolean)
       .indexOf(String(userId)) !== -1;
   }
   ```
2. Thêm `TELEGRAM_ADMIN_USER_IDS` vào danh sách `REQUIRED_PROPERTIES` trong `src/admin/SystemSetup.gs` nếu tính năng `/thanhtoan` qua GAS path vẫn cần được coi là bắt buộc dùng được — bàn với product trước khi thêm (có thể ops chat tự thân đã đủ kín, xem lại có thật sự cần bắt buộc không).
3. Cập nhật test `src/tests/telegram/webhook.test.js` (phần liên quan `handleOpsThanhToanCommand`) để phủ case: `TELEGRAM_ADMIN_USER_IDS` rỗng/không set → lệnh `/thanhtoan` bị từ chối, không còn pass-through.
4. Ghi rõ trong `docs/openclaw-admin-integration.md` hoặc README: hai runtime (Worker, GAS) đều fail-closed khi thiếu cấu hình — tránh lệch nhận thức trong tương lai.

**Acceptance criteria**:
- Test mới xác nhận: `TELEGRAM_ADMIN_USER_IDS` rỗng → `isAuthorizedOpsAdmin` trả `false` cho mọi `userId`.
- `npm test` pass toàn bộ.
- Không đổi hành vi khi biến ĐÃ được set đúng (test hiện có cho case này vẫn phải pass nguyên).

---

## 🟡 Medium #1 — `totalAmount` không làm tròn khi có giảm giá phần trăm

**File**: `src/core/billing.js:30-42`.

**Fix bắt buộc**:
```js
return {
  subtotal: subtotal,
  discountAmount: discountAmount,
  totalAmount: Math.round(subtotal - discountAmount)
};
```
Thêm test trong `src/tests/billing.test.js`: discount percentage tạo ra subtotal không chia hết (vd. subtotal 33333, discount 10%) → `totalAmount` phải là số nguyên.

**Acceptance criteria**: `npm test` pass; test mới cover trường hợp làm tròn.

---

## 🟡 Medium #2 — Không cảnh báo vận hành khi cả lượt quét hết hạn thanh toán lỗi

**File**: `src/admin/PaymentExpiry.gs` (`scanAndExpireStalePayments`).

**Fix bắt buộc**: Bọc `scanAndExpireStalePayments` bằng try/catch; khi toàn bộ scan throw (không phải lỗi từng đơn — `PaymentExpiryRunner.scan()` đã tự log per-order rồi), gửi cảnh báo vào ops chat qua `TelegramClient.create().execute({ method: 'sendMessage', ... })` giống tinh thần `sendOperationsAlert` bên `telegram-gateway/src/index.ts`. Log lỗi vào `ErrorLogs` với `stage: 'payment_expiry_scan_failed'`.

**Acceptance criteria**: Test mock `orderRepository.findAwaitingPaymentOlderThan` throw → xác nhận có gọi gửi cảnh báo ops chat + ghi `ErrorLogs`. `npm test` pass.

---

## 🟡 Medium #3 — `SheetOrderRepository.gs` là dead code còn sống chung hệ

**File**: `src/repositories/SheetOrderRepository.gs`.

**Fix bắt buộc**: Xác nhận lại với team không còn tham chiếu nào (grep `SheetOrderRepository` ngoài chính file và test của nó). Nếu đúng dead code: xoá file + test tương ứng (`sheetRepositoryLock.test.js` nếu chỉ test riêng file này thì xoá luôn, nếu dùng chung hạ tầng lock test thì giữ nhưng bỏ phần liên quan `SheetOrderRepository`). Nếu team muốn giữ làm phương án dự phòng: đổi tên thành `SheetOrderRepository.deprecated.gs` + comment đầu file giải thích rõ không được wire vào code sống.

**Acceptance criteria**: `npm run check` (bao gồm `check:boundaries`) pass sau khi xoá/đổi tên; không còn reference chết.

---

## ⚪ Low (gộp chung 1 PR dọn dẹp)

1. Xoá `src/adapters/menu/MenuSourceClient.gs` nếu xác nhận không còn tham chiếu ngoài (grep `MenuSourceClient`).
2. Gộp `src/adapters/telegram/TelegramRuntime.gs` và `src/adapters/zalo/ZaloRuntime.gs` thành một module dùng chung (`loadCatalog`, `createPaymentQrUrl`, `createId`, `fallbackMessage` gần như trùng 100%) — tham số hoá phần khác biệt nếu có.
3. Thêm fixture-based contract test cho `BotOrderWebhookClient.normalizeProduct`/`normalizeOrder` dựa trên response JSON thật đã lưu lại (không chỉ mock tay), để tự bắt lỗi nếu POS đổi field trong tương lai.

**Acceptance criteria chung cho Low**: `npm run check` pass, không đổi hành vi runtime.

---

## Ghi chú chung cho toàn bộ prompt này

- Không có lỗi Critical — không cần dừng mọi việc để fix ngay, nhưng nên làm theo thứ tự High trước khi traffic tăng thêm.
- Mỗi mục nên là 1 PR riêng (trừ Low gộp chung), kèm test tái hiện đúng lỗi trước khi fix — theo đúng convention đã thấy ở các fix-prompt trước (`phase3-fix-prompt.md`).
- Sau khi xong toàn bộ High, chạy lại `gas-code-review` skill lần nữa trên các file đã sửa để xác nhận không phát sinh vấn đề mới trước khi merge.
