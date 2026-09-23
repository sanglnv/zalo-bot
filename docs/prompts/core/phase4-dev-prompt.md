# Prompt cho dev / AI coding agent — Phase 4: Hardening

Dán nguyên văn cho dev. Phase 1-3 đã done (2 vòng review mỗi phase, đã fix hết Critical/High/Medium tìm được). **Không sửa `stateMachine.js`/`billing.js`/`domain.js`**, chỉ thêm hàm mới vào `orderService.js` theo đúng khuôn mẫu đã có từ `confirmPayment`.

## Bối cảnh — phần lớn hardening gốc đã làm xong dọc đường, Phase 4 chỉ còn 3 việc cụ thể

Theo lộ trình 6 phase ban đầu, Phase 4 gồm: áp lock (đã xong từ Phase 1), logging lỗi (đã xong từ Phase 2), tự động hết hạn đơn chưa thanh toán (**chưa làm — đây là việc chính của phase này**), đo tải so với quota GAS, và rà soát state machine không để trạng thái nào "kẹt". Không cần làm lại 2 việc đã xong.

## Yêu cầu bắt buộc

### 1. Tự động hết hạn đơn quá hạn thanh toán — theo đúng khuôn mẫu `confirmPayment`

`StateMachine` đã có sẵn transition `AWAITING_PAYMENT --PAYMENT_EXPIRED--> EXPIRED` nhưng chưa có nơi nào gọi tới — giống hệt tình trạng `PAYMENT_CONFIRMED` trước khi có Phase 3. Thêm vào `orderService.js`:

- Hàm `expireOrder(orderId)`: cùng shape với `confirmPayment` — chạy trong `withLock`, kiểm tra order tồn tại (`OrderNotFoundError`), kiểm tra `conversationState` đang đúng `AWAITING_PAYMENT` và khớp `orderId` (nếu không, ném lỗi — **tái sử dụng `PaymentAlreadyResolvedError` đã có** thay vì tạo loại lỗi mới, vì bản chất là cùng 1 loại guard "order không còn ở trạng thái chờ xử lý mong đợi"). Để tránh trùng lặp code với `confirmPayment`, tách phần kiểm tra "order + state có đang khớp `AWAITING_PAYMENT`" thành 1 hàm dùng chung cho cả 2.
- Transition dùng event `PAYMENT_EXPIRED`, set `order.status = 'EXPIRED'`, trả về `{ customer, outboundMessages }` với nội dung kiểu "Đơn hàng #{orderId} đã hết hạn do quá thời gian chờ thanh toán. Vui lòng đặt lại nếu quý khách vẫn muốn mua." — dùng đúng cơ chế `notificationDispatcher`/registry đã có, không tạo đường gửi tin riêng.
- **Áp dụng ngay từ đầu pattern đã fix ở Phase 3** (tách lỗi "xác nhận/hết hạn thất bại thật" khỏi "thành công nhưng gửi thông báo thất bại") — không được lặp lại lỗi Medium đã tìm thấy ở Phase 3. Hàm gọi `expireOrder` + dispatch (xem mục 2) phải trả về `reason: 'expired_but_notification_failed'` riêng khi cần, tương tự `confirmed_but_notification_failed`.

### 2. Batch runner + time-driven trigger — quét đơn quá hạn định kỳ

Thêm 1 Script Property `PAYMENT_TIMEOUT_MINUTES` (ví dụ mặc định 30). Thêm hàm quét:

```js
function scanAndExpireStalePayments() {
  // đọc Orders có status === 'AWAITING_PAYMENT' và createdAt cũ hơn PAYMENT_TIMEOUT_MINUTES
  // với MỖI order: gọi orderService.expireOrder(orderId), rồi dispatchNotifications,
  // xử lý lỗi độc lập cho từng order (1 order lỗi không được chặn các order còn lại)
}
```

Ràng buộc GAS bắt buộc:
- Giới hạn số order xử lý mỗi lần chạy (ví dụ tối đa 50/lần) để không vượt 6 phút thực thi nếu `Orders` phình to — nếu còn dư, để lần chạy kế tiếp (trigger định kỳ) xử lý tiếp, không cần cơ chế phân trang phức tạp.
- Hàm phải an toàn khi chạy lại nhiều lần / chồng lấn với các entry point khác — dùng đúng `SheetRepositorySupport.withScriptLock` như mọi nơi khác, để tự động serialize đúng với `doPost` (webhook) và `confirmSelectedOrderPayment` (menu nhân viên). Đây là lý do quyết định "1 lock toàn cục" từ Phase 1 vẫn đúng đắn — không cần cơ chế khóa mới.
- Đăng ký trigger 1 lần, theo đúng pattern idempotent đã dùng ở `registerSheetMenuTrigger()` (kiểm tra trigger đã tồn tại trước khi tạo thêm):

```js
function registerPaymentExpiryTrigger() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'scanAndExpireStalePayments';
  });
  if (exists) return { created: false };
  ScriptApp.newTrigger('scanAndExpireStalePayments').timeBased().everyMinutes(10).create();
  return { created: true };
}
```

- Viết test cho race thực tế: khách bấm "Xác nhận" (webhook) và job quét hết hạn chạy gần như đồng thời cho cùng 1 order — xác nhận chỉ 1 trong 2 thắng, bên còn lại nhận đúng lỗi "đã xử lý" chứ không crash hay đưa order vào trạng thái mâu thuẫn (dùng kỹ thuật interleave qua `afterOrderSave`/mock `withLock` đã dùng ở các phase trước).

### 3. Đo tải — tối giản, không xây APM

Thêm 1 sheet `OperationMetrics` (`timestamp`, `operation`, `durationMs`) và 1 helper đơn giản `recordDuration(operation, fn)` bọc quanh: `doPost` (Phase 2), `confirmSelectedOrderPayment` (Phase 3), `scanAndExpireStalePayments` (mục 2). Không cần dashboard, không cần phân tích — chỉ cần dữ liệu thô để sau này so sánh với quota GAS (thời gian thực thi/ngày, số lần gọi `UrlFetchApp`) khi cần quyết định chuyển sang Supabase. Ghi 1 đoạn ngắn vào README nêu rõ: đây là dữ liệu thô, chưa có ngưỡng cụ thể, để Phase sau tự đánh giá dựa trên số liệu thực tế thay vì đoán.

### 4. Rà soát state machine — checklist bắt buộc, viết thành tài liệu

Viết 1 mục mới trong README (hoặc file `docs/state-machine-audit.md`) liệt kê **từng state** trong `ConversationStates` và xác nhận 1 trong 2:
- Có ít nhất 1 transition đi ra (không phải trạng thái cuối), HOẶC
- Là trạng thái cuối có chủ đích, kèm lý do bằng 1 câu.

Cụ thể phải trả lời rõ: `PAID` hiện có transition `COMPLETE → DONE` trong bảng nhưng **không có nơi nào trong code gọi event `COMPLETE`** — giống hệt tình trạng `PAYMENT_EXPIRED` trước phase này. Đây KHÔNG bắt buộc phải build (theo dõi giao hàng/hoàn tất đơn nằm ngoài phạm vi bot chốt bill), nhưng bắt buộc phải **quyết định rõ và ghi lại**: hoặc (a) coi `PAID` là điểm kết thúc thực tế của bot ở scope hiện tại (nhân viên tự biết đơn đã thanh toán là xong việc, không cần bot theo dõi tiếp), hoặc (b) thêm 1 menu tương tự `confirmSelectedOrderPayment` cho "Đánh dấu hoàn tất". Không được để nguyên tình trạng mập mờ không ai biết `DONE` có bao giờ đạt tới được không.

## Cấu trúc file dự kiến

```
/src
  /core
    orderService.js        // thêm expireOrder(), hàm guard dùng chung
  /repositories
    SheetOrderRepository.gs // có thể cần thêm findAwaitingPaymentOlderThan() hoặc lọc ở tầng gọi
  /admin (hoặc /scheduled — tuỳ dev đặt tên nhất quán với PaymentConfirmation.gs)
    PaymentExpiry.gs        // scanAndExpireStalePayments, registerPaymentExpiryTrigger
    Metrics.gs              // recordDuration, SheetOperationMetricsRepository
  /tests
    orderService.expireOrder.test.js (hoặc gộp vào orderService.test.js)
    paymentExpiry.test.js
docs/state-machine-audit.md (hoặc mục mới trong README)
```

## Acceptance criteria

1. `npm test` và `npm run check:boundaries` pass toàn bộ.
2. Test `expireOrder`: hết hạn thành công, gọi lần 2 báo lỗi "đã xử lý" (không đổi gì thêm), order không tồn tại báo lỗi riêng, race với `confirmPayment`/`handleMessage` cho cùng order chỉ 1 bên thắng.
3. Test `scanAndExpireStalePayments`: chỉ xử lý đúng các order quá hạn (không đụng order còn trong hạn hoặc đã `PAID`/`CANCELLED`), 1 order lỗi không chặn các order khác trong cùng lượt quét, giới hạn số lượng xử lý mỗi lần chạy hoạt động đúng.
4. Áp dụng đúng pattern tách lỗi "thất bại thật" khỏi "thành công nhưng gửi thông báo thất bại" ngay từ đầu — có test cho case này, không để lặp lại lỗi Medium của Phase 3.
5. Tài liệu rà soát state machine liệt kê đủ toàn bộ state, có quyết định rõ ràng cho `PAID`/`DONE`.
6. README cập nhật: cách chạy `registerPaymentExpiryTrigger()` 1 lần, ý nghĩa `PAYMENT_TIMEOUT_MINUTES`, và ghi chú `OperationMetrics` là dữ liệu thô chưa có ngưỡng quyết định.
