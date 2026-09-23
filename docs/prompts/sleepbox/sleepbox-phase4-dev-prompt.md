# Prompt cho dev / AI coding agent — Sleepbox Phase 4: Wire vào Zalo webhook

Dán nguyên văn cho dev. Sleepbox Phase 1-3 (core, Telegram, thanh toán) đã done và test thật trên
Telegram. Phase này lặp lại đúng việc đã làm ở Phase 2/3 nhưng cho `src/adapters/zalo/webhook.gs` —
**không thiết kế lại gì mới**, chỉ áp dụng cùng router/pattern.

## Bối cảnh

`zalo/webhook.gs`'s `createDefaultZaloWebhook()` hiện chỉ tạo `orderService`. Cấu trúc gần như song
song với `telegram/webhook.gs` (cùng dùng `BotOrderRepository`, `SheetCustomerRepository`,
`SheetConversationStateRepository`, `MemberRepository`) — điểm khác biệt chính giữa 2 platform nằm ở
`mapInboundMessage`/`renderOutboundMessage`/`verifySignature`, không nằm ở phần orchestration
service.

## Yêu cầu bắt buộc

### 1. Router giống hệt Phase 2, áp cho Zalo

Copy đúng logic router (`orderService` vs `bookingService` theo `/phong` hoặc `activeFlow`) đã viết ở
Sleepbox Phase 2 — nếu Phase 2 đã tách router ra file riêng
(`src/adapters/telegram/routeToService.js`), cân nhắc generalize file đó thành platform-neutral
(nhận `conversationStateRepository`/`inbound`, không biết gì về Telegram/Zalo) rồi dùng chung cho cả
2 adapter, thay vì copy-paste 2 lần. Đây là lúc hợp lý để làm việc đó — nếu Phase 2 đã code router
inline trong `telegram/webhook.gs` mà không tách, **tách ra ngay bây giờ** trước khi nhân đôi logic
sang Zalo.

### 2. Callback data / action mapping cho Zalo

Zalo dùng payload dạng khác Telegram (`ZaloInboundMapper`/`zc:<action>:<args>` — đọc
`src/adapters/zalo/mapInboundMessage.js` để thấy đúng convention hiện có cho `zc:add_item:p1:1`
kiểu). Thêm case cho `zc:select_unit:hourly`, `zc:select_room:<roomId>`, `zc:confirm_booking`,
`zc:cancel_booking` — dùng đúng namespace `zc:` đã có, không tạo prefix mới.

### 3. `createDefaultZaloWebhook()` — thêm `bookingService`

Copy đúng cách Phase 2 đã thêm vào `createDefaultTelegramWebhook()`, dùng `ZaloRuntime.loadCatalog`/
`createId`/`createPaymentQrUrl` tương ứng thay cho `TelegramRuntime.*`. **Nhắc lại vì đã từng bị sót
ở phần member/loyalty**: đảm bảo `memberRepository: MemberRepository()` có mặt trong constructor
thật (`createDefaultZaloWebhook`), không chỉ trong test.

### 4. Ops notify cho booking từ Zalo

Không có gì mới về hạ tầng — `OperationsNotifier.notifyStaffOfNewBooking(booking, 'zalo', ...)`
(hàm đã có từ Phase 3) đổ vào cùng `TELEGRAM_OPERATIONS_CHAT_ID`, đúng nguyên tắc "Zalo không có ops
chat riêng" đã áp dụng cho FnB. Chỉ cần trong `zalo/webhook.gs`'s `doPost`, thêm block gọi hàm này
song song với `notifyStaffOfNewOrder` hiện có, dùng `confirmedBookingSummary` (tương tự
`confirmedOrderSummary` đã có trong file này cho order).

### 5. Zalo không có `/thanhtoan` riêng của nó

`/thanhtoan` luôn được gõ trong **Telegram ops chat**, kể cả để xử lý booking đến từ khách Zalo
(đúng nguyên tắc đã áp dụng cho order — xem `docs/bot-order-webhook-integration.md`). Không cần thêm
gì ở `zalo/webhook.gs` cho việc thanh toán — `BookingQrDispatch.gs` (Phase 3) đã dùng
`buildInteractivePushRegistry()` có sẵn cả 2 platform, tự biết đẩy QR đúng kênh khách đang dùng dựa
trên `customer.platformLinks`.

## Deliverable & acceptance criteria

1. `npm run check` pass toàn bộ, không phá test hiện có của `zalo/webhook.test.js`.
2. Test router cho Zalo (giống mục 2 của Phase 2 dev-prompt, áp cho `zc:` action).
3. Test end-to-end giả lập: khách Zalo gõ tương đương `/phong` → hoàn tất luồng chọn giờ/đêm → chọn
   phòng → xác nhận → `notifyStaffOfNewBooking` được gọi đúng 1 lần với `sourcePlatform: 'zalo'`.
4. Test tay thật trên Zalo OA (sandbox/test account) — đặt phòng, xác nhận, staff gõ `/thanhtoan` bên
   Telegram ops chat, khách Zalo nhận QR đúng.
5. Cập nhật `docs/sleepbox-booking-plan.md`/`docs/sleepbox-booking-integration.md` (tạo ở Phase 6)
   xác nhận cả 2 platform đã wire xong.
