# Prompt cho dev / AI coding agent — Sleepbox Phase 5: Swap Sheet repo sang POS Sleepbox Webhook thật

Dán nguyên văn cho dev. Sleepbox Phase 1-4 đã done, chạy được đầy đủ trên cả Telegram lẫn Zalo với
dữ liệu phòng/booking lưu trong Sheet (`Rooms`, `Bookings`). Phase này thay datastore đó bằng POS
thật — **đúng lộ trình FnB đã đi qua** (`SheetOrderRepository` → `BotOrderWebhookClient`/
`BotOrderRepository`, xem `docs/bot-order-webhook-integration.md`).

## Điều kiện bắt buộc trước khi bắt đầu — KHÔNG code khi chưa có

Cần contract thật từ bên POS, dạng tài liệu envelope giống hệt "Bot Order Webhook" doc đã dùng cho
FnB (`{secret, requestId, action, payload}`). Nếu chưa có, **dừng lại, không đoán field name** —
đọc kỹ phần "Known assumptions and limitations" trong `docs/bot-order-webhook-integration.md` để
thấy hậu quả của việc đoán field name sai (`normalizeProduct` phải sửa lại sau khi có response thật:
`id` không phải `productId`, `basePrice` không phải `price`, v.v.) — đừng lặp lại việc đó cho
sleepbox. Câu hỏi cụ thể cần có câu trả lời (đã liệt kê ở `docs/sleepbox-booking-plan.md`, mục "Việc
cần làm trước khi code"):

1. Tên action chính xác cho: list/check availability, tạo booking, đọc booking, huỷ booking, hoàn
   tất/thanh toán booking.
2. POS tự tính availability hay Clawbot phải tự tính (đã có `findAvailableRooms` từ Phase 1 làm
   phương án dự phòng nếu POS không tự làm).
3. Giá theo giờ/đêm nằm ở đâu trong response.
4. Id format của booking (để quyết định lại cách phân biệt với `orderId` đã tạm làm ở Phase 3 —
   nếu POS dùng chung 1 dải id với order thì phương án tiền tố ở Phase 3 không dùng được nữa, phải
   chuyển sang fallback thử-cả-2-nơi).
5. `secret`/`requestId` dùng chung `BOT_ORDER_WEBHOOK_URL`/`_SECRET` hay endpoint riêng.

## Yêu cầu bắt buộc

### 1. `SleepboxWebhookClient.gs` — mirror đúng convention `BotOrderWebhookClient.gs`

- Cùng file `call(action, payload, idempotencyKey)` helper (copy pattern, không viết lại từ đầu):
  request JSON, `muteHttpExceptions: true`, throw `BotOrderWebhookError`-style riêng
  (`SleepboxWebhookError`) khi HTTP status lỗi hoặc body không parse được JSON — đây chính xác là
  loại lỗi đã gặp thật ngoài production cho FnB (`"Bot order webhook returned invalid JSON (HTTP
  404)"` khi URL sai, `HTTP 200` khi POS trả HTML thay vì JSON) — xử lý lỗi phải rõ ràng ngay từ đầu,
  đừng để lộ ra dạng lỗi khó hiểu.
- Mutation (`createBooking`, `cancelBooking`, `completeBooking`) dùng **idempotency key ổn định**
  theo business key (`'createBooking:' + clawbotBookingId`, giống `'createOrder:' +
  clawbotOrderId` đã làm) — KHÔNG dùng random UUID cho mutation, chỉ dùng cho read-only actions.
- `id`/số liệu do POS sở hữu (tương đương `points`/`totalSpend` bên member) không được gửi lên khi
  tạo/sửa — chỉ đọc về.
- `normalizeRoom`/`normalizeBooking`: viết dựa trên response THẬT (yêu cầu 1 sample response JSON từ
  POS dev, lưu vào `src/tests/fixtures/sleepbox-webhook-live-response.json` để làm fixture test, đúng
  cách `bot-order-webhook-live-response.json` đã làm cho FnB — xem Low #3 trong
  `codebase-review-fix-prompt.md` đã áp dụng, tránh lặp lại việc chỉ test bằng mock tay).

### 2. `BookingRepository.gs` — thay `SheetBookingRepository` tại các call site

Giữ nguyên contract (`save`, `findById`, `findByCustomerId`, `updateStatus`,
`findAwaitingPaymentOlderThan` nếu sleepbox cũng cần expiry timeout giống order — xem mục 4) — chỉ
đổi implementation bên trong từ gọi `SpreadsheetApp` sang gọi `SleepboxWebhookClient`. Theo đúng note
đã ghi trong `BotOrderRepository.gs`'s header comment: nếu POS tự sinh `bookingId` và ignore id
client gửi lên, `save()` phải **mutate object `booking` truyền vào tại chỗ** để ghi đè `bookingId`
POS-assigned, giữ nguyên id gốc dưới dạng `raw.clawbotBookingId` cho truy vết — làm y hệt
`BotOrderRepository.save()` đã làm, đọc lại comment trong file đó trước khi viết.

### 3. Availability — quyết định lại theo câu trả lời POS (mục 2 phần điều kiện)

- Nếu POS tự check availability: `BookingRepository` gọi thẳng action đó, **xoá**
  `findAvailableRooms` khỏi luồng chính (giữ lại trong core làm fallback/test, không xoá file).
- Nếu POS không tự check: giữ nguyên `findAvailableRooms` (Phase 1), chỉ đổi nguồn dữ liệu đầu vào
  (`rooms`/`bookings`) từ đọc Sheet sang đọc qua `SleepboxWebhookClient.listSleepboxRooms()`/tương
  đương. Cảnh báo race condition double-booking nếu POS không tự lock — nếu không có cơ chế
  idempotency/lock phía POS cho `createBooking`, cân nhắc thêm 1 bước re-check availability ngay
  trước khi gọi `createBooking` trong cùng `withLock`, chấp nhận vẫn có khe hở race nhỏ (ghi rõ giới
  hạn này vào doc, đừng giả vờ đã giải quyết triệt để).

### 4. Payment timeout cho booking (nếu áp dụng)

Nếu nghiệp vụ cần tự động huỷ booking `AWAITING_PAYMENT` quá hạn (giống `PaymentExpiry.gs` đã làm
cho order) — thêm `findAwaitingPaymentOlderThan` vào `BookingRepository`, và 1 scheduled function
`scanAndExpireStaleBookings` mirror `scanAndExpireStalePayments`, kể cả phần cảnh báo ops chat khi
scan lỗi toàn bộ (đã fix cho order ở Medium #2 của `codebase-review-fix-prompt.md` — áp dụng luôn
từ đầu cho booking, đừng đợi review lần 2 mới thêm).

### 5. Cấu hình

Thêm `SLEEPBOX_WEBHOOK_URL`/`SLEEPBOX_WEBHOOK_SECRET` (hoặc tái dùng `BOT_ORDER_WEBHOOK_*` nếu POS
xác nhận dùng chung endpoint — xem câu hỏi 5 ở điều kiện) vào `SystemSetup.gs`'s
`REQUIRED_PROPERTIES`, cập nhật README theo đúng format bảng đã có cho `BOT_ORDER_WEBHOOK_*`.

## Deliverable & acceptance criteria

1. `npm run check` pass toàn bộ, boundary check không có `SpreadsheetApp`/`UrlFetchApp`/
   `LockService`/tên nền tảng nào lọt vào `src/core/booking*.js`.
2. Test `SleepboxWebhookClient.gs` dùng fixture response thật (mục 1), không chỉ mock tay.
3. Test `BookingRepository.gs` (mirror `botOrderRepository.test.js`): tạo mới mutate id đúng, trạng
   thái PAID/CANCELLED gọi đúng action, lỗi permission-gap (nếu có, giống
   `findOrdersByCustomerId`'s "not allowed" đã gặp) fail-soft đúng chỗ không critical.
4. Test tay thật: đặt phòng qua Telegram/Zalo, xác nhận booking tồn tại thật bên phía POS (không chỉ
   trong Sheet Clawbot), thanh toán, huỷ — đối chiếu dữ liệu 2 bên khớp nhau.
5. Cập nhật/viết mới `docs/sleepbox-booking-integration.md` theo đúng cấu trúc
   `docs/bot-order-webhook-integration.md` (mục "Known assumptions and limitations" bắt buộc phải có
   — ghi lại mọi giả định đã đưa ra trong lúc chờ xác nhận từ POS, để phase sau/dev sau biết chỗ nào
   cần double-check nếu có bug lạ).
6. Xoá/deprecate `SheetRoomRepository.gs`/`SheetBookingRepository.gs` theo đúng cách đã làm với
   `SheetOrderRepository.gs` (giữ lại file + test làm phương án rollback, không wire vào code sống —
   xem Medium #3 của `codebase-review-fix-prompt.md` để copy đúng cách ghi chú "dead code nhưng giữ
   lại có chủ đích").
