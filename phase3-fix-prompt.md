# Prompt cho dev — Fix lỗi Medium từ review Phase 3 (paymentConfirmation.js)

Dán nguyên văn cho dev.

---

## Bối cảnh

Code review Phase 3 (`orderService.confirmPayment`, `paymentConfirmation.js`, `notificationDispatcher.js`) đã pass 42/42 test và boundary check. Toàn bộ phần idempotency/concurrency/tách lớp đều đúng. Có 1 lỗi Medium đã được tái hiện bằng cách ghép `OrderService` thật với `PaymentConfirmationHandler` thật (không phải suy đoán): khi bước gửi thông báo cho khách thất bại, nhân viên nhận thông báo sai sự thật rằng việc xác nhận thanh toán đã thất bại — trong khi thực ra nó đã thành công.

## Lỗi (Medium) — Thất bại gửi thông báo bị báo cáo lẫn với thất bại xác nhận thanh toán

**Nguyên nhân**: Trong `src/admin/paymentConfirmation.js`, hàm `process()`:

```js
var confirmation = dependencies.orderService.confirmPayment(orderId, confirmedBy);
var dispatchResults = dependencies.dispatchNotifications(
  confirmation.customer, confirmation.outboundMessages, dependencies.registry || {}
);
```

Cả 2 lệnh gọi nằm trong cùng 1 khối `try`. Nếu `orderService.confirmPayment` chạy xong (order đã chuyển `PAID` thật, ghi `confirmedAt`/`confirmedBy` thật) nhưng `dispatchNotifications` throw ngay sau đó (Telegram lỗi/mất mạng), exception rơi vào `catch` chung — vì lỗi mạng không có `error.code` là `PAYMENT_ALREADY_RESOLVED` hay `ORDER_NOT_FOUND`, nó rơi vào nhánh generic và trả về `{ ok: false, reason: 'error', message: ... }`. Nhân viên thấy "Có lỗi xảy ra: ..." như thể xác nhận thất bại, trong khi order đã `PAID` thật trong hệ thống.

Đã tái hiện bằng script: dùng `OrderService` thật (đơn thật, state thật) + `PaymentConfirmationHandler` thật, ép `dispatchNotifications` throw ở lần gọi đầu — kết quả: order chuyển `PAID` thành công, nhưng `process()` trả `{"ok":false,"reason":"error", ...}`. Nhân viên hợp lý sẽ thử xác nhận lại, lần 2 nhận `already_resolved` — không tạo lỗi dữ liệu (an toàn nhờ cơ chế idempotency đã có), nhưng trải nghiệm rất khó hiểu và không ai biết khách đã nhận được thông báo hay chưa, vì `ErrorLogs` cũng không phân biệt 2 loại thất bại này.

Đây là đúng loại lỗi Phase 2 đã fix ở `webhook.gs` (tách "đã xử lý nghiệp vụ" khỏi "đã gửi thành công cho khách", có `deliveryStatus` + fallback riêng) — nhưng pattern đó chưa được áp dụng lại ở `paymentConfirmation.js`.

**Fix bắt buộc**:

1. Tách `dispatchNotifications` ra khỏi khối `try` chung với `confirmPayment` — dùng try/catch riêng cho từng bước, để phân biệt rõ 2 loại thất bại.
2. Nếu `confirmPayment` thành công nhưng `dispatchNotifications` throw, trả về 1 `reason` mới, ví dụ `'confirmed_but_notification_failed'`, kèm đủ dữ liệu để nhân viên tự xử lý thủ công (`orderId`, danh sách `platformLinks` của khách hoặc `chatId` nếu có sẵn, thông điệp lỗi gốc).
3. Cập nhật `confirmSelectedOrderPayment()` (`PaymentConfirmation.gs`) để xử lý `reason: 'confirmed_but_notification_failed'` bằng 1 `ui.alert` riêng, nội dung kiểu: "Đã xác nhận thanh toán thành công nhưng gửi thông báo cho khách thất bại — vui lòng tự nhắn tin xác nhận cho khách." — không được dùng chung thông điệp "Có lỗi xảy ra" với trường hợp `confirmPayment` thật sự thất bại (order không được xác nhận).
4. `errorLogRepository.log(...)` cho trường hợp này phải ghi rõ `stage: 'notification_dispatch'` (khác với `stage: 'confirm_payment'` hiện có cho lỗi thật) kèm `orderId` và thông tin khách hàng, để phân biệt được trong `ErrorLogs` khi nhân viên hoặc dev tra cứu sau này.
5. Viết test mới đúng kịch bản đã tái hiện: `confirmPayment` thành công (mock trả về customer/outboundMessages hợp lệ), `dispatchNotifications` throw — xác nhận `process()` trả về `reason: 'confirmed_but_notification_failed'` (không phải `'error'`), và log ghi đúng `stage: 'notification_dispatch'`.

## Acceptance criteria

1. `npm test` và `npm run check:boundaries` pass toàn bộ, bao gồm test mới.
2. Chạy lại đúng kịch bản tái hiện ở review (ghép `OrderService` thật + `PaymentConfirmationHandler` thật, ép `dispatchNotifications` throw ở lần gọi đầu): `process()` phải trả về `reason: 'confirmed_but_notification_failed'`, không phải `'error'` chung chung.
3. `confirmSelectedOrderPayment()` hiện đúng thông điệp phân biệt cho trường hợp này, không dùng chung alert "Có lỗi xảy ra" với lỗi xác nhận thật.
4. README (mục "Manual payment confirmation") cập nhật giải thích 3 kết quả có thể xảy ra: xác nhận thành công + gửi thành công, xác nhận thất bại thật (chưa `PAID`), và xác nhận thành công nhưng gửi thông báo thất bại (đã `PAID`, cần nhân viên nhắn tay) — để Phase 5 áp dụng đúng khi thêm kênh Zalo vào registry.
