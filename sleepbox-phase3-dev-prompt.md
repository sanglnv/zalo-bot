# Prompt cho dev / AI coding agent — Sleepbox Phase 3: Ops notify + QR thanh toán qua `/thanhtoan`

Dán nguyên văn cho dev. Sleepbox Phase 1 (core) + Phase 2 (wire Telegram, router `orderService`
vs `bookingService`) đã done. Phase này chỉ thêm phần thanh toán — **không sửa lại router hay
`bookingStateMachine.js`**.

## Bối cảnh

Luồng thanh toán FnB hiện tại (đọc kỹ trước khi bắt đầu, đây là pattern bắt buộc phải tái dùng,
không tự nghĩ ra cách khác):

1. Khách xác nhận đơn → `OperationsNotifier.notifyStaffOfNewOrder(...)` gửi tin vào
   `TELEGRAM_OPERATIONS_CHAT_ID` (`src/admin/OperationsNotifier.gs`).
2. Staff gõ `/thanhtoan <orderId>` trong đúng chat đó → `telegram/webhook.gs`'s
   `handleOpsThanhToanCommand` bắt lệnh này TRƯỚC KHI nó chạm `OrderService.handleMessage` (staff
   không phải "customer"), check `OperationsNotifier.isAuthorizedOpsAdmin`, gọi
   `PaymentQrDispatch.dispatchPaymentQr(orderId)`.
3. `PaymentQrDispatch.gs`: dựng lại `OrderService` (dùng `BotOrderRepository`/`SheetCustomerRepository`
   thật, không mock), gọi `orderService.sendPaymentQr(orderId)`, rồi
   `NotificationDispatcher.dispatchNotifications(customer, outboundMessages, registry)` để đẩy QR tới
   đúng platform khách đang dùng (registry có cả `telegram` và `zalo`, không qua ZBS template vì QR
   là ảnh tuỳ ý, không phải template có sẵn).

Sleepbox cần đúng luồng y hệt, chỉ khác domain: `bookingId` thay vì `orderId`, `BookingRepository`
thay vì `BotOrderRepository`.

## Yêu cầu bắt buộc

### 1. `OperationsNotifier.gs` — thêm `notifyStaffOfNewBooking` + tách hàm dựng text

`operationsOrderText(order, sourcePlatform)` hiện build text cho đơn đồ ăn. Thêm hàm song song
`operationsBookingText(booking, sourcePlatform)`:

```
🔔 ĐẶT PHÒNG MỚI #<bookingId>
Kênh: <sourcePlatform>
Khách: <customerName>            (nếu có, giống pattern order đã làm)

Phòng: <roomName> (<roomType>)
<unit === 'hourly' ? 'Khung giờ: <startAt> — <durationHours>h' : 'Nhận phòng: <startAt> — <nights> đêm'>
Tổng: <totalAmount>
Trạng thái: Chờ thanh toán

Khi xác nhận, gõ: /thanhtoan <bookingId>
```

Thêm `notifyStaffOfNewBooking(booking, sourcePlatform, errorLogRepository)` — copy nguyên cấu trúc
try/catch/best-effort của `notifyStaffOfNewOrder` (không được throw ra ngoài, luôn log lỗi vào
`ErrorLogs` thay vì làm hỏng luồng khách hàng).

### 2. Phân biệt `orderId` vs `bookingId` trong `/thanhtoan` — quyết định bắt buộc trước khi code

Xem `docs/sleepbox-booking-plan.md`, mục "Thanh toán: phân biệt orderId vs bookingId". Cách làm
theo tiền tố id:

- Nếu id sinh bởi `BookingRepository`/POS sleepbox có tiền tố phân biệt được với đơn hàng (ví dụ đơn
  luôn dạng `HD...`, booking luôn dạng `PB...` hoặc tương tự) → `handleOpsThanhToanCommand` trong
  `telegram/webhook.gs` chỉ cần thêm 1 nhánh: parse tiền tố, gọi
  `PaymentQrDispatch.dispatchPaymentQr(id)` (đơn) hoặc `BookingQrDispatch.dispatchBookingQr(id)`
  (booking) tương ứng.
- Nếu KHÔNG đảm bảo được tiền tố phân biệt (id do Sheet tự sinh ở Phase 1, có thể trùng dạng với
  `createId()` của order) → fallback: thử `BotOrderRepository.findById(id)` trước, nếu `null` thì thử
  `BookingRepository.findById(id)`. Chấp nhận đánh đổi chậm hơn 1 network/sheet-read call, **nhưng
  bắt buộc viết test cho case "id đó thực ra không tồn tại ở đâu cả"** để không rơi vào lỗi mơ hồ.
- Việc này phải chốt và ghi rõ vào code comment ở `handleOpsThanhToanCommand` lý do chọn cách nào,
  để Phase 5 (swap sang POS thật) biết có cần giữ nguyên logic phân biệt hay đổi lại.

### 3. `BookingQrDispatch.gs` (mirror `PaymentQrDispatch.gs`)

```js
function buildBookingQrOrderService() { // hoặc đặt tên buildBookingQrBookingService cho rõ domain
  return BookingService.create({
    bookingRepository: SheetBookingRepository(),  // Phase 5 sẽ đổi sang POS thật
    roomRepository: SheetRoomRepository(),
    customerRepository: SheetCustomerRepository(),
    conversationStateRepository: SheetConversationStateRepository(),
    memberRepository: MemberRepository(),
    createId: TelegramRuntime.createId,
    now: function () { return new Date(); },
    withLock: SheetRepositorySupport.withScriptLock
  });
}

function dispatchBookingQr(bookingId) {
  // y hệt dispatchPaymentQr: gọi bookingService.sendPaymentQr(bookingId) (cần thêm hàm này vào
  // bookingService.js theo đúng pattern OrderService.sendPaymentQr đã có — validate trạng thái
  // AWAITING_PAYMENT, không tự chuyển trạng thái, chỉ trả QR + outboundMessages),
  // dùng chung buildInteractivePushRegistry() đã có sẵn trong PaymentQrDispatch.gs (không viết lại).
}
```

`bookingService.js` cần thêm hàm `sendPaymentQr(bookingId)` tương tự `OrderService.sendPaymentQr` —
copy đúng cách validate (`requireAwaitingPayment`-style) đã dùng ở `orderService.js`, đừng nghĩ lại
từ đầu.

### 4. `telegram/webhook.gs` — wire notify + thanhtoan

- Trong `doPost`, sau khi có `transaction.confirmedBookingSummary` (đã chuẩn bị dữ liệu ở Phase 2),
  gọi `OperationsNotifier.notifyStaffOfNewBooking(...)` — copy đúng pattern gọi
  `notifyStaffOfNewOrder` đang có, đặt song song, không lồng vào nhau.
- Trong `handleOpsThanhToanCommand`, áp dụng logic phân biệt id ở mục 2.

### 5. Zalo — CHƯA cần làm ở phase này

`docs/bot-order-webhook-integration.md` đã ghi rõ: Zalo không có ops chat riêng, mọi thông báo (kể cả
Zalo-originated) đều đổ vào **cùng 1** `TELEGRAM_OPERATIONS_CHAT_ID`. Sleepbox giữ nguyên nguyên tắc
này — `notifyStaffOfNewBooking` nhận `sourcePlatform` là `'zalo'` khi booking đến từ Zalo, nhưng vẫn
gửi vào Telegram ops chat. Việc wire `bookingService` vào `zalo/webhook.gs` thuộc Phase 4, **không
làm ở đây** — Phase 3 chỉ cần đảm bảo `notifyStaffOfNewBooking`/`BookingQrDispatch` nhận đúng
`sourcePlatform` làm tham số để Phase 4 gọi được ngay, không phải sửa lại chữ ký hàm.

## Deliverable & acceptance criteria

1. `npm run check` pass toàn bộ.
2. Test `operationsBookingText`/`notifyStaffOfNewBooking` (giống style
   `src/tests/operationsNotifier.test.js`): hiện đúng thông tin phòng/giờ/đêm, best-effort khi ops
   chat chưa cấu hình, log lỗi đúng `stage` khi gửi thất bại.
3. Test `BookingQrDispatch.dispatchBookingQr`: thành công, `not_found`, `already_resolved`,
   `sent_but_delivery_failed` — 4 case y hệt `botOrderRepository`/`PaymentQrDispatch` đã test cho
   order (xem file test tương ứng làm mẫu).
4. Test phân biệt id ở `handleOpsThanhToanCommand`: `/thanhtoan <orderId>` vẫn gọi đúng
   `PaymentQrDispatch`, `/thanhtoan <bookingId>` gọi đúng `BookingQrDispatch`, id không tồn tại ở cả
   2 nơi → trả lời rõ ràng "không tìm thấy", không throw lỗi hệ thống.
5. Test tay thật: đặt phòng qua Telegram → thấy thông báo đúng format trong ops chat → gõ
   `/thanhtoan <bookingId>` → khách nhận QR đúng số tiền phòng (không lẫn với đơn đồ ăn nếu khách có
   cả 2 loại giao dịch cùng lúc).
