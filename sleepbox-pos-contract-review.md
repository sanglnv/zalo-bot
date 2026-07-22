# Review: POS Sleepbox contract (Bot Order Webhook doc, bản mới)

Đối chiếu doc POS gửi với 5 câu hỏi trong `sleepbox-pos-webhook-request.md` và giả định đã code ở
Phase 1 (`bookingDomain.js`/`bookingBilling.js`/`bookingService.js`, Sheet-backed). **Kết luận: đủ
điều kiện để bắt đầu Phase 5**, nhưng có 5 điểm sai khác với giả định Phase 1 cần sửa trước khi viết
`SleepboxWebhookClient.gs` — liệt kê bên dưới, không cần hỏi lại POS thêm gì.

## Trả lời 5 câu hỏi đã hỏi

1. **Action list**: đủ cả 5 — `checkAvailability`, `createBooking`, `getBooking`, `cancelBooking`,
   `completeBooking` (tên `completeBooking`, alias `confirm_booking_payment`) — khớp đề xuất.
2. **Availability tự tính bởi POS**: **Có** — `checkAvailability` trả `rooms[]` đã lọc sẵn theo
   `[startAt,endAt)`. Tốt hơn dự kiến: `createBooking` **tự re-validate lại đúng rule overlap ở
   tầng ghi**, nên race double-booking giữa 2 request `createBooking` gần như đồng thời được POS tự
   xử lý — **không cần** Clawbot tự thêm bước re-check trước khi tạo như đã cảnh báo trong
   `sleepbox-phase5-dev-prompt.md` mục 3. Chỉ cần xử lý đúng lỗi `BOT_WEBHOOK_ROOM_OVERLAP` khi thua
   race (xem mục "Cần sửa" #4 bên dưới).
3. **Giá phòng**: field tên **khác** giả định — `hourlyRate`/`overnightRate`/`dailyRate` (3 field,
   không phải `pricePerHour`/`pricePerNight` như Phase 1 đã code), và **có 3 đơn vị** (`hourly`/
   `nightly`/`daily`), không phải 2. Giá luôn tính server-side từ `rate × duration`, **Clawbot không
   được gửi `totalAmount` lên** — khác hẳn cách Phase 1 hiện tính `bill` cục bộ và validate.
4. **Phân loại phòng**: `roomType`/`capacity` chỉ là metadata hiển thị, **không ảnh hưởng giá** — trả
   lời khớp giả định.
5. **Huỷ/đổi lịch**: khách được tự huỷ (`cancelBooking` không giới hạn phía server) — quyết định có
   cho khách tự huỷ qua bot hay không là quyết định phía Clawbot, không phải giới hạn backend.

Ngoài 5 câu, doc còn trả lời sẵn cả những điều chưa hỏi tới: `secret`/endpoint dùng **chung** 1
webhook với đơn hàng/thành viên (không cần config riêng), permission đã bật sẵn cho toàn bộ action
trên, id có tiền tố phân biệt rõ (`BOOKING_...` vs `HD...` vs `MEMBER_...`).

## 5 điểm cần sửa so với giả định Phase 1 (trước khi viết `SleepboxWebhookClient.gs`)

### 1. Field giá + số đơn vị — sửa `bookingDomain.js`/`bookingBilling.js`

- `Room.pricePerHour`/`pricePerNight` → đổi tên/thêm field `hourlyRate`/`overnightRate`/`dailyRate`
  (giữ tên cũ làm alias nội bộ nếu muốn, nhưng field thật phải khớp POS khi Phase 5 map response).
- `calculateBookingBill` hiện chỉ nhận `unit: 'hourly'|'nightly'`. POS hỗ trợ thêm `'daily'` — **đây
  là quyết định sản phẩm, không phải kỹ thuật**: có mở thêm lựa chọn "theo ngày" cho khách trong bot
  hay giữ nguyên 2 lựa chọn (giờ/đêm) như đã chốt ban đầu và chỉ đơn giản không dùng tới `daily`? Nếu
  giữ 2 lựa chọn, không cần đổi `bookingStateMachine`/`bookingService`'s UI, chỉ cần đổi tên field
  giá. Nếu muốn mở thêm "theo ngày", cần thêm 1 lựa chọn nữa ở bước chọn loại hình + billing.

### 2. Giá phải tính server-side, không gửi `totalAmount` lên POS

Phase 1's `confirm_booking` handler hiện tự tính `bill` (qua `calculateBookingBill`) và lưu
`totalAmount` vào booking cục bộ — dùng để hiện cho khách xem TRƯỚC khi xác nhận. Việc này **vẫn
giữ được** cho mục đích hiển thị preview (dùng rate lấy từ `checkAvailability`'s `rooms[]`, vì
response đó cũng có `hourlyRate`/`overnightRate`/`dailyRate` — tính preview bằng đúng công thức
`rate × duration` để khớp với cách POS sẽ tính), nhưng khi Phase 5 gọi `createBooking` thật,
**`totalAmount` cục bộ không được gửi lên** — POS tự tính và trả về `patch.bookings[0].total`
(+`baseAmount`/`extraAmount`). `BookingRepository.save()` phải ghi đè `booking.totalAmount` bằng giá
trị POS trả về sau khi tạo (đúng pattern `BotOrderRepository.save()` đã mutate `orderId` tại chỗ —
áp dụng tương tự cho `totalAmount`, không chỉ `bookingId`).

### 3. Cần gửi `startAt`+`endAt` (không phải `durationHours`/`nights`), và `customerName` bắt buộc

`createBooking` payload cần `startAt`/`endAt` — **dữ liệu này đã có sẵn** trong
`state.contextData.endAt` (từ `interval()` helper ở `bookingService.js`'s `select_slot` handler),
chỉ là hiện chưa được gắn vào object `booking` lúc `confirm_booking` (chỉ có `startAt`, không có
`endAt`). Sửa nhỏ: thêm `endAt` vào object `booking` ở `confirm_booking` handler + `bookingDomain.js`
Booking typedef + `SheetBookingRepository`'s HEADERS (làm ngay ở Phase 1/trước Phase 5 cũng được, vì
đằng nào cũng cần lưu `endAt` thay vì tính lại từ `durationHours`/`nights` mỗi lần).

`customerName` là field bắt buộc phía POS (`BookingService_.createBooking` reject nếu thiếu) —
`BookingRepository.save()` (Phase 5) phải lấy `customer.displayName` (qua `customerRepository`) để
đính kèm, cùng `customerPhone` (không bắt buộc nhưng nên gửi nếu có).

### 4. Mapping error code — POS dùng tiền tố `BOT_WEBHOOK_`, code hiện tại của Clawbot thì không

`bookingService.js`'s `sendPaymentQr` hiện tự throw `error.code = 'BOOKING_NOT_FOUND'`/
`'PAYMENT_ALREADY_RESOLVED'` (tự đặt, không theo POS). POS trả `BOT_WEBHOOK_BOOKING_NOT_FOUND`,
`BOT_WEBHOOK_BOOKING_ALREADY_CANCELLED`, `BOT_WEBHOOK_PAYMENT_AMOUNT_MISMATCH`,
`BOT_WEBHOOK_ROOM_OVERLAP`, `BOT_WEBHOOK_ROOM_INACTIVE`, `BOT_WEBHOOK_BOOKING_NOT_CANCELLABLE`.
`SleepboxWebhookClient.gs` (Phase 5) nên throw lỗi theo đúng code POS trả (giống cách
`BotOrderWebhookClient.gs` đã làm với `BOT_WEBHOOK_MEMBER_NOT_FOUND`), rồi `BookingRepository.gs`
hoặc `bookingService.js` map các code đó về đúng `error.code` nội bộ mà
`BookingQrDispatch.gs`/`bookingService.js` đang check (`BOOKING_NOT_FOUND`/
`PAYMENT_ALREADY_RESOLVED`), **cộng thêm** case mới chưa có ở Phase 1: `BOT_WEBHOOK_ROOM_OVERLAP`
(thua race lúc `confirm_booking` — trả lời khách "phòng vừa bị đặt mất, hãy chọn phòng khác" thay vì
lỗi hệ thống chung chung) và `BOT_WEBHOOK_PAYMENT_AMOUNT_MISMATCH` (chỉ xảy ra nếu logic tính
`amount` gửi lên sai — nên log lỗi rõ ràng vì đây là bug, không phải tình huống người dùng bình
thường).

### 5. `completeBooking` cần gửi `amount`, và **không** đụng cash/shift reconciliation

Khác `completeOrder(orderId, paymentMethod)` hiện tại (không gửi `amount`),
`completeBooking` **bắt buộc** `amount` khớp với `total` đã lưu server-side, nếu không sẽ bị
`BOT_WEBHOOK_PAYMENT_AMOUNT_MISMATCH`. `BookingRepository.save()`'s nhánh `status === 'PAID'`
(Phase 5) phải gửi kèm `booking.totalAmount` (giá trị POS-authoritative đã ghi đè ở mục 2) làm
`amount`. Đồng thời ghi chú rõ trong doc integration cuối cùng: thanh toán booking qua bot **không**
tự động vào sổ quỹ ca (cash drawer)/báo cáo doanh thu ca — nhân viên vẫn phải tự đối soát khoản này
riêng cho tới khi POS có tính năng đó (đúng như doc đã cảnh báo).

## Điểm tốt, không cần sửa gì thêm

- `cancelBooking` gọi lại cho booking đã huỷ → `ok:true` không lỗi (khác `cancelOrder`) — code hiện
  tại của `BookingRepository`/`bookingService` chưa có logic đặc biệt cho case này, nhưng cũng không
  cần — chỉ cần không coi non-error response là lỗi (mặc định đã đúng).
- `getBooking` với id không tồn tại → đọc rỗng, không phải lỗi — khớp đúng giả định
  (`bookingService.sendPaymentQr` hiện coi "không tìm thấy" LÀ lỗi có code riêng — đây là hành vi
  đúng ở **tầng Clawbot** vì mục đích khác (biết để trả lời "không tìm thấy đặt phòng" cho staff), độc
  lập với việc bản thân action `getBooking` phía POS trả rỗng thay vì lỗi — không có xung đột, chỉ
  cần `SleepboxWebhookClient.getBooking()` tự throw lỗi nội bộ khi mảng rỗng, giống cách
  `BotOrderWebhookClient.getMemberProfile` đã làm cho member).
- Secret/URL dùng chung `BOT_ORDER_WEBHOOK_URL`/`_SECRET` — không cần thêm script property mới, đỡ 1
  việc trong `SystemSetup.gs`.
- `raw.clawbotBookingId` không tồn tại như field riêng (POS gộp vào `notes`) — không ảnh hưởng cơ chế
  idempotency thật (vẫn dựa vào `requestId`), chỉ cần đổi cách truyền traceability id từ
  `raw: {clawbotBookingId}` (kiểu Order) sang nhét vào `notes` (kiểu Booking).

## Đề xuất cập nhật `sleepbox-phase5-dev-prompt.md`

Nên bổ sung 1 mục mới liệt kê chính xác 5 điểm sửa ở trên làm checklist implement (thay vì phần
"điều kiện bắt buộc" cũ giờ đã có câu trả lời) — có thể làm ngay khi bắt đầu code
`SleepboxWebhookClient.gs`, không cần file riêng nữa nếu bạn muốn gộp thẳng vào khi code.

## Có thể bắt đầu Phase 5 ngay bây giờ

Không còn gì blocking. Đề xuất thứ tự:

1. (Tuỳ chọn, làm trước cũng được) Thêm `endAt` vào `Booking` domain/Sheet — patch nhỏ, không phá gì
   đang chạy.
2. Viết `SleepboxWebhookClient.gs` theo đúng contract này (mirror `BotOrderWebhookClient.gs`), lấy
   response mẫu từ chính các ví dụ JSON trong doc POS làm fixture test luôn (đã đủ chi tiết, không
   cần xin thêm sample response riêng).
3. `BookingRepository.gs` áp dụng đúng 5 điểm sửa ở trên.
4. Chạy `npm run check`, test tay thật.

Bạn có muốn mình bắt đầu code Phase 5 luôn theo checklist này không, hay chỉ cần review tới đây?
