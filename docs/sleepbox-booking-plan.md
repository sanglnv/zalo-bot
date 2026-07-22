# Plan: Đặt phòng Sleepbox qua bot

## Triển khai hiện tại

- Phase 1–3 hoàn tất: domain Sheet-backed, Telegram, notification ops và QR thanh toán.
- Phase 4 hoàn tất: cả Telegram và Zalo cùng dùng router `activeFlow`; booking từ Zalo thông báo vào
  Telegram ops chat và QR vẫn được staff gửi qua `/thanhtoan <bookingId>` trong chat đó.
- Phase 5 mới thay repository Sheet bằng POS khi contract sleepbox chính thức sẵn sàng.

Ghi lại quyết định + lộ trình implement tính năng đặt phòng sleepbox (Telegram/Zalo), dựa trên
4 lựa chọn đã chốt:

- **Backend**: POS sẽ expose thêm API sleepbox (Clawbot chỉ là client, giống mô hình Bot Order
  Webhook cho FnB) — *nhưng contract thật chưa có, xem "Việc cần làm trước" bên dưới*.
- **Đơn vị đặt**: hỗ trợ cả theo giờ (vd 3h/6h) và theo đêm (check-in/check-out) — khách chọn loại
  hình khi bắt đầu đặt.
- **Quan hệ với FnB**: luồng hoàn toàn riêng biệt, action namespace mới (`/phong`), dùng chung
  customer/profile gate (tên+SĐT+member) nhưng cart/order logic tách biệt khỏi `orderService.js`.
- **Thanh toán**: tái dùng luồng hiện tại — QR VietQR do staff gửi qua lệnh `/thanhtoan` sau khi
  khách xác nhận đặt phòng, giống hệt luồng xác nhận đơn đồ ăn.

## Việc cần làm trước khi code (blocking)

Giống tình huống member/loyalty trước đây — cần contract thật từ bên POS trước khi viết
`SleepboxWebhookClient.gs`. Cần hỏi bên POS dev những câu sau (paste nguyên văn được thì càng tốt,
theo đúng format envelope `{secret, requestId, action, payload}` đã dùng cho Bot Order Webhook):

1. **Danh sách action**: có sẵn `listSleepboxRooms`/`checkAvailability`, `createBooking`,
   `getBooking`, `cancelBooking`, `completeBooking` (đánh dấu đã thanh toán) chưa? Tên action chính
   xác là gì?
2. **Availability**: POS có tự tính "phòng nào trống trong khung giờ/đêm X" không, hay Clawbot phải
   tự fetch toàn bộ phòng + booking rồi tính bù trừ? (ảnh hưởng lớn tới độ phức tạp phía Clawbot)
3. **Đơn vị giá**: giá theo giờ và giá theo đêm cấu hình ở đâu — nằm trong response phòng
   (`pricePerHour`/`pricePerNight`), hay Clawbot phải tự tính?
4. **Số lượng & phân loại phòng**: có phân loại theo size/tiện nghi (đơn/đôi, có cửa sổ...) hay tất
   cả sleepbox đồng nhất một loại?
5. **Huỷ/đổi lịch**: khách có được tự huỷ qua bot không, hay chỉ staff xử lý thủ công qua POS?
6. **ID booking**: POS tự sinh id theo format nào — cần biết để tránh đụng namespace với `orderId`
   (xem mục "Thanh toán" bên dưới).

**Không tự đoán các field này** như đã từng làm với `normalizeProduct` (fallback field names) —
lần này nên đợi doc thật rồi mới viết `normalizeBooking`/`normalizeRoom`, tránh phải sửa lại nhiều
lần như đã xảy ra với Bot Order Webhook.

## Kiến trúc đề xuất

Mirror đúng pattern đã dùng cho FnB, đặt tên riêng để không đụng namespace:

```
src/adapters/menu/SleepboxWebhookClient.gs   -- adapter gọi POS (giống BotOrderWebhookClient.gs)
src/repositories/BookingRepository.gs         -- wrap client (giống BotOrderRepository.gs)
src/core/bookingService.js                    -- platform-neutral flow (giống orderService.js)
```

### Vì sao `bookingService.js` tách riêng thay vì nhét vào `orderService.js`

`orderService.js`'s `StateMachine` (`IDLE → BROWSING → CART → CONFIRMING → AWAITING_PAYMENT → ...`)
mô hình hoá đúng 1 domain: giỏ hàng đồ ăn. Nhét thêm domain đặt phòng vào chung state machine đó sẽ
làm nó phình to và rối (2 domain có luồng hỏi khác nhau: chọn loại hình → chọn slot → chọn phòng,
không có khái niệm "giỏ hàng nhiều món"). Tách riêng module, nhưng **dùng chung**:

- `customerRepository`/`getOrCreateCustomer` — 1 khách hàng dùng chung 1 hồ sơ tên/SĐT/member cho cả
  đặt món và đặt phòng.
- `memberRepository` — điểm thành viên tích luỹ chung, không tách riêng theo dịch vụ.
- Pattern hỏi tên/SĐT lần đầu (`profileGateResponse`) — có thể factor ra thành helper dùng chung
  giữa 2 service, hoặc đơn giản hơn: giữ nguyên trong `orderService.js` vì mọi tin nhắn đều đi qua
  đó trước (xem mục "Điểm cần quyết định" bên dưới).

### Điểm cần quyết định: state riêng hay chung 1 dòng ConversationState?

Đây là quyết định kiến trúc quan trọng nhất, cần chốt trước khi code:

- **Phương án A (đề xuất): `ConversationStates` sheet giữ thêm 1 cột `activeFlow`
  (`'order'|'booking'|null`)**. Cả `orderService.handleMessage` và `bookingService.handleMessage` đọc
  chung 1 row theo `customerId`, nhưng chỉ 1 trong 2 flow active tại 1 thời điểm — action khởi động
  1 flow (`/danhmuc` hay `/phong`) sẽ set `activeFlow` tương ứng; action thuộc flow kia trong lúc
  đang active flow A sẽ bị chặn/nhắc "bạn đang có [đặt món/đặt phòng] dở, gõ X để tiếp tục hoặc Y để
  huỷ" — đúng tinh thần `pendingOrder()` đã có sẵn cho FnB.
- **Phương án B: bảng ConversationState riêng cho booking** (`BookingConversationStates` sheet, giống
  cách Zalo/Telegram `ProcessedUpdates` đã tách theo platform). Sạch hơn về code (không đụng
  `orderService.js`'s state shape) nhưng khách có thể vô tình chạy song song cả đặt món và đặt phòng
  cùng lúc mà không có cơ chế cảnh báo tự nhiên — cần tự xây lại phần "đang có việc dở dang" từ đầu.

**Khuyến nghị: Phương án A** — tái dùng hạ tầng `pendingOrder`-style đã chứng minh hoạt động tốt,
đỡ phải xây 1 bộ conflict-detection riêng cho domain thứ 2.

### Luồng hội thoại (`/phong`)

1. `/phong` (hoặc nút "Đặt phòng sleepbox") → nếu khách đang có đặt món dở dang, nhắc trước
   (theo Phương án A). Nếu chưa qua profile gate (tên/SĐT), gate đó vẫn chạy trước như hiện tại.
2. Hỏi loại hình: **theo giờ** hay **theo đêm** (button 2 lựa chọn).
3. Theo giờ: hỏi giờ nhận phòng + số giờ thuê (preset 3h/6h hoặc nhập tay, tuỳ theo Q3 ở trên).
   Theo đêm: hỏi ngày check-in + số đêm.
4. Gọi POS check availability cho slot đó → hiện danh sách phòng trống (hoặc "hết phòng, chọn khung
   giờ khác").
5. Khách chọn phòng → hiện tóm tắt (loại phòng, thời gian, giá) + nút Xác nhận/Huỷ.
6. Xác nhận → tạo booking bên POS (status tương đương `AWAITING_PAYMENT`), lưu `bookingId`,
   `memberId` (nếu có) vào booking. Thông báo khách: "Đã giữ phòng #X, nhân viên sẽ gửi mã QR thanh
   toán ngay khi xác nhận."
7. Thông báo ops chat (tái dùng `OperationsNotifier` pattern, thêm biến thể cho booking — text khác
   với đơn đồ ăn: loại phòng, khung giờ/đêm, tên khách).
8. Staff gõ `/thanhtoan <bookingId>` trong ops chat → gửi QR cho khách (tái dùng
   `PaymentQrDispatch.gs`, xem mục dưới về việc phân biệt `orderId` vs `bookingId`).

### Thanh toán: phân biệt `orderId` vs `bookingId` trong `/thanhtoan`

`PaymentQrDispatch.gs` hiện chỉ biết tra `orderId` qua `BotOrderRepository`. Khi thêm booking, lệnh
`/thanhtoan <id>` cần biết tra ở đâu. Đề xuất: dùng **tiền tố id để phân biệt** (giống
`VIETQR_TRANSFER_PREFIX` đã dùng cho nội dung chuyển khoản đơn hàng, ví dụ đơn `HD...`) — nếu POS
sleepbox tự sinh id với tiền tố khác (vd `PB...`/`SB...`), `PaymentQrDispatch.gs` chỉ cần switch theo
tiền tố để gọi đúng repository/service. Nếu bên POS **không** đảm bảo tiền tố phân biệt được, phương
án dự phòng: thử `BotOrderRepository.findById` trước, nếu không thấy thì thử `BookingRepository`,
nhưng cách này chậm hơn và có thể nhầm nếu 2 hệ id trùng format — **nên chốt với POS dev về id
format trước khi code phần này**.

## Lộ trình implement (từng PR nhỏ, theo đúng convention repo đang dùng)

1. **Xác nhận contract POS** (xem mục "Việc cần làm trước") — không code trước bước này.
2. `SleepboxWebhookClient.gs` + test — theo đúng pattern `BotOrderWebhookClient.gs`
   (idempotency key cho mutation, `normalizeRoom`/`normalizeBooking`, error code riêng nếu POS có).
3. `BookingRepository.gs` + test — wrap client, contract giống `orderRepository` hiện có nhưng thêm
   field đặc thù (`roomType`, `unit: 'hourly'|'nightly'`, `startAt`, `durationHours`/`nights`).
4. `core/bookingService.js` + test — luồng hội thoại ở trên, dùng chung `customerRepository`/
   `memberRepository`, tự quản lý `contextData.bookingStep`/`activeFlow` (Phương án A).
5. Wire vào `telegram/webhook.gs` + `zalo/webhook.gs`: thêm `bookingService` bên cạnh `orderService`
   trong `createDefaultTelegramWebhook`/`createDefaultZaloWebhook`, router theo `activeFlow`/action.
6. Mở rộng `OperationsNotifier.gs` (text riêng cho booking) + `PaymentQrDispatch.gs` (phân biệt
   `orderId`/`bookingId` theo tiền tố).
7. Test + doc (`docs/sleepbox-booking-integration.md` theo đúng format
   `docs/bot-order-webhook-integration.md`), chạy `npm run check`, sau đó `clasp push` + redeploy.

## Rủi ro / điểm cần theo dõi

- Nếu POS sleepbox dùng **chung 1 secret/URL** với Bot Order Webhook nhưng khác action namespace,
  `SleepboxWebhookClient.gs` có thể tái dùng `BOT_ORDER_WEBHOOK_URL`/`_SECRET` — cần xác nhận. Nếu
  khác endpoint hoàn toàn, cần thêm `SLEEPBOX_WEBHOOK_URL`/`_SECRET` script properties riêng +
  `SystemSetup.gs` update.
- Availability tính sai (double-booking) nếu POS không tự chống race — cần hỏi rõ POS có transaction/
  lock ở tầng tạo booking không, tương tự cách `createOrder` đã có `requestId` idempotency.
- Giống `findOrdersByCustomerId`'s permission-gap đã gặp trước đây — nên chuẩn bị tinh thần action
  mới bên POS có thể chưa được scope đúng cho secret của Clawbot ngay từ đầu, cần fail-soft ở những
  chỗ không critical (vd lịch sử booking) giống cách đã làm với đơn hàng.
