# Prompt cho dev bên POS — Expose "Sleepbox Booking Webhook"

Dán nguyên văn phần dưới đây cho dev phụ trách POS Apps Script (bên vận hành sleepbox). Đây là bên
đang giữ dữ liệu phòng/lịch đặt thật; Clawbot (bot Telegram/Zalo) chỉ là client gọi vào, y hệt mô
hình "Bot Order Webhook" đã dùng cho đặt món đồ ăn — nếu bạn là người đã viết Bot Order Webhook, tài
liệu này **cố tình giữ đúng format envelope, idempotency, error code convention** để không phải học
lại từ đầu.

## Bối cảnh

Clawbot đã build xong toàn bộ luồng hội thoại đặt phòng sleepbox (chọn theo giờ/theo đêm, chọn phòng
trống, xác nhận, thanh toán qua QR) và đang chạy thử với dữ liệu phòng/booking lưu tạm trong Google
Sheet nội bộ của Clawbot (không phải dữ liệu thật của bạn). Để go-live thật, Clawbot cần đổi sang gọi
API thật từ hệ thống của bạn — đây chính là phần cần bạn expose.

## Envelope — giữ nguyên định dạng Bot Order Webhook

```
POST <URL của bạn>
Content-Type: application/json

{
  "secret": "<shared secret>",
  "requestId": "<uuid hoặc key ổn định do Clawbot sinh>",
  "action": "<tên action>",
  "payload": { ... tuỳ action ... }
}
```

Response bắt buộc luôn là JSON (không phải HTML, kể cả khi lỗi), status HTTP 200, body dạng:

```
{ "ok": true, "action": "...", "requestId": "...", ... dữ liệu tuỳ action ... }
```

hoặc khi lỗi:

```
{ "ok": false, "code": "<mã lỗi>", "message": "<mô tả>", "requestId": "..." }
```

**Quan trọng — đã từng gặp sự cố thật với Bot Order Webhook**: nếu web app của bạn throw exception
chưa bắt (uncaught), Apps Script có thể trả về trang HTML lỗi thay vì JSON dù status vẫn 200 — phía
Clawbot sẽ thấy lỗi `"invalid JSON (HTTP 200)"` và không biết chuyện gì xảy ra. Luôn bọc toàn bộ logic
trong `doPost` bằng try/catch, trả `{ok:false, code:'INTERNAL_ERROR', message:...}` thay vì để lộ
stack trace HTML ra ngoài.

## Actions cần expose

Tên action dưới đây là đề xuất — có thể đổi tên nếu hệ thống bạn đã có sẵn action tương đương, chỉ
cần báo lại tên chính xác.

### 1. `checkAvailability` (hoặc `listSleepboxRooms` nếu bạn không tự tính availability)

**Nếu hệ thống bạn có thể tự tính phòng trống** (khuyến nghị — đỡ Clawbot phải tự fetch toàn bộ rồi
tính bù trừ, tránh race condition double-booking):

Request `payload`:
```
{ "startAt": "2026-08-01T10:00:00+07:00", "endAt": "2026-08-01T13:00:00+07:00" }
```

Response mong đợi:
```
{
  "ok": true,
  "patch": { "rooms": [
    { "id": "R1", "name": "Box 1", "roomType": "single", "pricePerHour": 50000,
      "pricePerNight": 300000, "isAvailable": true }
  ] }
}
```
(chỉ trả về phòng THỰC SỰ TRỐNG trong khoảng `[startAt, endAt)` đã cho — không trả phòng đang bị
`inactive`/bảo trì)

**Nếu hệ thống bạn KHÔNG tự tính availability**, đổi thành action `listSleepboxRooms` (không nhận
`startAt`/`endAt`) trả về toàn bộ danh sách phòng + `listBookings` (hoặc field tương đương) để
Clawbot tự tính bù trừ — báo rõ nếu đi theo hướng này, Clawbot cần biết thêm: booking nào coi là
"đang chiếm chỗ" (trạng thái nào chặn, trạng thái nào không).

### 2. `createBooking`

Request `payload`:
```
{
  "booking": {
    "customerId": "<id khách bên Clawbot>",
    "memberId": "<id thành viên, có thể null>",
    "roomId": "R1",
    "unit": "hourly" | "nightly",
    "startAt": "2026-08-01T10:00:00+07:00",
    "durationHours": 3,          // chỉ có khi unit = hourly
    "nights": null,               // chỉ có khi unit = nightly
    "totalAmount": 150000,
    "raw": { "clawbotBookingId": "<id tạm Clawbot tự sinh, chỉ để truy vết>" }
  }
}
```

Response mong đợi (theo đúng convention `createOrder` đã dùng — `id`/timestamps do BẠN sinh, Clawbot
không gửi id thật lên):
```
{
  "ok": true,
  "patch": { "bookings": [
    { "id": "PB2026080100001", "status": "awaiting_payment", "roomId": "R1",
      "totalAmount": 150000, "createdAt": "...", "updatedAt": "..." }
  ] }
}
```

**Idempotency bắt buộc**: `createBooking` là mutation — Clawbot sẽ gửi `requestId` **ổn định** theo
`clawbotBookingId` (không random mỗi lần retry). Nếu nhận lại đúng `requestId` đã xử lý trước đó
(do request đầu bị timeout phía Clawbot rồi retry), trả về theo đúng convention đã dùng cho
`createOrder`: `{ok:true, duplicate:true, bookingId:"<id đã tạo trước đó>"}` — **không tạo booking
thứ 2**. Nếu chưa xử lý xong (đang processing), cũng có thể trả `duplicate:true` không kèm
`bookingId` — Clawbot sẽ tự retry đọc lại qua `getBooking`.

**ID format — quan trọng, ảnh hưởng tới lệnh `/thanhtoan` phía Clawbot**: Clawbot cần phân biệt được
`bookingId` với `orderId` (đơn đồ ăn) chỉ bằng cách nhìn vào chuỗi id, để nhân viên gõ
`/thanhtoan <id>` biết tra đúng chỗ. Đề xuất: **tiền tố riêng** không trùng với tiền tố đơn hàng hiện
tại (ví dụ đơn hàng dạng `HD...`, booking nên là `PB...`/`SB...` — báo lại tiền tố chính xác bạn dùng
để Clawbot code đúng logic phân biệt).

### 3. `getBooking`

Request: `{ "bookingId": "PB2026080100001" }`. Trả về giống shape trong `patch.bookings[0]` ở trên.
Nếu không tìm thấy: `{ "ok": true, "patch": { "bookings": [] } }` (đọc rỗng KHÔNG phải lỗi — giống
`getOrder` đã làm cho đơn đồ ăn, khác với action mutation ở dưới coi not-found LÀ lỗi).

### 4. `cancelBooking`

Request: `{ "bookingId": "...", "reason": "customer_cancelled" | "payment_timeout" }`. Đổi status
booking sang huỷ/cancelled. Idempotency: nếu gọi lại cho booking đã huỷ rồi, trả `ok:true` bình
thường (không lỗi), không thay đổi gì thêm.

### 5. `completeBooking` (đánh dấu đã thanh toán)

Request: `{ "bookingId": "...", "paymentMethod": "bank_transfer" }`. Đổi status sang đã thanh toán
(`paid`/`completed`, tuỳ hệ thống bạn đặt tên). Đây là lúc điểm thành viên (nếu có) nên được cộng —
Clawbot không tự cộng điểm, tin tưởng hoàn toàn vào hệ thống của bạn xử lý loyalty khi nhận được
action này, giống cách `completeOrder` đã làm cho đơn đồ ăn.

## Câu hỏi cần trả lời kèm response mẫu (không trả lời bằng lời, gửi kèm 1 JSON response thật)

Với MỖI action ở trên, nếu có thể, gửi kèm **1 ví dụ response JSON thật** (có thể dùng dữ liệu giả
lập nhưng đúng field name/kiểu dữ liệu thật) — Clawbot sẽ dùng chính xác các file này làm fixture
test, tránh đoán sai field name như đã từng xảy ra với sản phẩm đồ ăn (`normalizeProduct` phải sửa
lại nhiều lần vì đoán field name `productId` nhưng thực tế là `id`).

Ngoài ra cần xác nhận rõ:

1. Giá phòng theo giờ/đêm nằm ở field nào — đúng như đề xuất `pricePerHour`/`pricePerNight`, hay tên
   khác?
2. Có phân loại phòng theo tiện nghi/kích thước không (field `roomType` có ý nghĩa gì, có ảnh hưởng
   giá không ngoài đơn/đôi)?
3. `secret`/URL dùng chung với Bot Order Webhook hiện tại hay endpoint hoàn toàn riêng?
4. Có giới hạn quyền theo action không (giống việc `findOrdersByCustomerId` từng bị chặn "not
   allowed" cho secret của Clawbot) — nếu có, xác nhận các action ở trên đều được bật cho secret sẽ
   dùng.
5. Khách có được tự huỷ/đổi lịch qua bot không, hay chỉ nhân viên xử lý tay bên hệ thống bạn (Clawbot
   hiện chưa có UI đổi lịch, chỉ có huỷ).

## Sau khi có câu trả lời

Clawbot sẽ tiếp tục `sleepbox-phase5-dev-prompt.md` (viết `SleepboxWebhookClient.gs`, swap Sheet
sang gọi API thật) dựa trực tiếp vào tài liệu này — không cần trao đổi thêm nếu đủ 5 câu hỏi + response
mẫu cho cả 5 action.
