# Prompt cho dev / AI coding agent — Phase 3: Xác nhận thanh toán thủ công (VietQR đã có sẵn từ Phase 2)

Dán nguyên văn cho dev. Phase 1 (core) và Phase 2 (Telegram adapter, đã fix xong 2 vòng review) đã done. **Không được sửa `src/core/stateMachine.js`, `src/core/billing.js`, `src/core/domain.js` ở phase này** — chỉ được thêm 1 hàm mới vào `orderService.js`, không sửa `handleMessage` hiện có.

## Bối cảnh quan trọng — phần lớn Phase 3 gốc đã xong từ Phase 2

Theo lộ trình 6 phase ban đầu, Phase 3 gồm 2 việc: (a) sinh QR VietQR, (b) luồng xác nhận thủ công. Việc (a) **đã hoàn thành ở Phase 2** (`TelegramRuntime.createPaymentQrUrl`, dùng VietQR Quick Link, đã test kỹ). Phase 3 này chỉ còn việc (b): xây cơ chế để nhân viên xác nhận "đã nhận tiền" và bot tự động báo lại cho khách — hiện tại `StateMachine` đã có sẵn transition `AWAITING_PAYMENT --PAYMENT_CONFIRMED--> PAID` nhưng **chưa có bất kỳ nơi nào trong code gọi tới nó** — đây chính là khoảng trống cần lấp.

## Yêu cầu bắt buộc

### 1. Thêm `confirmPayment` vào core — platform-agnostic, dùng chung `withLock` đã có

Trong `orderService.js`, thêm 1 hàm mới bên cạnh `handleMessage` (không đổi `handleMessage`):

```js
function confirmPayment(orderId, confirmedBy) {
  return dependencies.withLock(function () {
    var order = dependencies.orderRepository.findById(orderId);
    if (!order) throw new OrderNotFoundError(orderId);          // dùng type/class lỗi riêng, xem bên dưới
    var state = dependencies.conversationStateRepository.get(order.customerId);
    if (!state || state.currentState !== d.StateMachine.States.AWAITING_PAYMENT ||
        state.contextData.orderId !== orderId) {
      throw new PaymentAlreadyResolvedError(orderId, order.status);
    }
    var result = d.StateMachine.transition(state.currentState, d.StateMachine.Events.PAYMENT_CONFIRMED, state.contextData);
    var timestamp = dependencies.now().toISOString();
    dependencies.orderRepository.save(Object.assign({}, order, {
      status: 'PAID', confirmedAt: timestamp, confirmedBy: confirmedBy, updatedAt: timestamp
    }));
    dependencies.conversationStateRepository.set(order.customerId, {
      customerId: order.customerId, currentState: result.nextState,
      contextData: result.newContextData, updatedAt: timestamp
    });
    var customer = dependencies.customerRepository.findById(order.customerId);
    return {
      customer: customer,
      outboundMessages: [{ type: 'text', content: {
        text: 'Payment confirmed for order ' + orderId + '. Thank you!', orderId: orderId
      } }]
    };
  });
}
```

(Code trên là minh hoạ ý tưởng, dev điều chỉnh style cho khớp phần còn lại của file — quan trọng là hành vi, không phải cú pháp chính xác.)

Yêu cầu cụ thể:
- Định nghĩa 2 loại lỗi riêng biệt (custom Error subclass hoặc `error.code` gắn kèm) để caller phân biệt được: `OrderNotFoundError` (orderId không tồn tại — lỗi thao tác, có thể do gõ sai) và `PaymentAlreadyResolvedError` (order đã được xác nhận trước đó hoặc không còn ở trạng thái chờ thanh toán — **không phải lỗi**, là tình huống hợp lệ khi nhân viên bấm xác nhận 2 lần hoặc 2 nhân viên cùng xử lý 1 đơn). Việc phân biệt 2 loại này bắt buộc, vì UI Sheet sẽ hiển thị thông báo khác nhau cho từng loại (xem mục 3).
- Toàn bộ thân hàm nằm trong `dependencies.withLock(...)` — **dùng chung 1 lock với `handleMessage`** vì cả 2 đều dùng `SheetRepositorySupport.withScriptLock`, tức cùng 1 GAS script lock toàn cục. Điều này bắt buộc để tránh race giữa nhân viên bấm "Đã nhận tiền" và khách đang thao tác `cancel`/`confirm_order` cùng lúc trên chat.
- Trả về `outboundMessages` kiểu `OutboundMessage[]` như `handleMessage`, KHÔNG tự gửi tin — core không được biết Telegram/Zalo là gì, giữ đúng nguyên tắc đã lập từ Phase 1.
- Trả về cả `customer` (có `platformLinks`) để lớp gọi vào (Sheet menu, Phase 3) biết phải gửi thông báo tới đâu.
- KHÔNG tạo `PaymentRepository` riêng biệt dù `domain.js` đã có typedef `Payment` từ Phase 1 — quyết định kiến trúc cho phase này: `Order.status`/`confirmedAt`/`confirmedBy` là nguồn sự thật duy nhất, tránh 2 nơi lưu trạng thái thanh toán dễ lệch nhau. Giữ `Payment` typedef trong `domain.js` làm tham chiếu cho báo cáo/đối soát tương lai nếu cần, không dùng ở phase này.

### 2. Mở rộng schema Order — theo đúng pattern nâng cấp header đã dùng ở Phase 2

`SheetOrderRepository.gs` cần thêm 2 cột `confirmedAt`, `confirmedBy`. Áp dụng đúng kỹ thuật đã dùng khi thêm `deliveryStatus` vào `ProcessedUpdates` ở Phase 2 (tự bổ sung header cho sheet cũ nếu thiếu cột, không phá dữ liệu hiện có). Cập nhật `fromRow`/`save` tương ứng, giữ tương thích ngược với các dòng cũ chưa có 2 cột này (đọc ra `null`/rỗng thay vì lỗi).

### 3. Giao diện cho nhân viên — custom menu trên Google Sheet, KHÔNG dùng `onEdit` tự động

**Ràng buộc GAS bắt buộc phải biết**: `onEdit` simple trigger bị GAS giới hạn quyền — không được gọi các service cần authorization đầy đủ. Vì luồng này cần gọi vào `orderService.confirmPayment` (có thể kéo theo gửi tin qua `UrlFetchApp` ở bước dispatch), **không được dùng `onEdit` simple trigger để tự động xác nhận khi nhân viên gõ "PAID" vào ô trạng thái** — cách này sẽ silently fail hoặc bị GAS chặn giữa chừng, rất khó debug. Dùng menu tuỳ chỉnh (custom menu) — hàm gắn với menu item được coi là chạy có đủ quyền như người dùng tự bấm chạy, không bị giới hạn.

Vì project là standalone Apps Script (không bound trực tiếp vào Google Sheet, do Phase 2 cần deploy Web App), `onOpen()` **simple trigger sẽ không tự chạy** khi mở Sheet — phải đăng ký 1 **installable trigger** trỏ đích danh vào `SPREADSHEET_ID`:

```js
function registerSheetMenuTrigger() {
  var spreadsheetId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!spreadsheetId) throw new Error('Missing required script property: SPREADSHEET_ID');
  ScriptApp.newTrigger('onOpenBuildMenu').forSpreadsheet(spreadsheetId).onOpen().create();
}

function onOpenBuildMenu() {
  SpreadsheetApp.getUi()
    .createMenu('Zalo Clawbot')
    .addItem('Xác nhận thanh toán đơn đang chọn', 'confirmSelectedOrderPayment')
    .addToUi();
}
```

Gọi `registerSheetMenuTrigger()` 1 lần thủ công từ Apps Script editor (giống cách `registerWebhook()` đã làm ở Phase 2), ghi vào README.

`confirmSelectedOrderPayment()` (hàm xử lý khi nhân viên bấm menu):
1. Đọc dòng đang chọn (`SpreadsheetApp.getActiveSheet().getActiveRange()`) trên sheet `Orders`, lấy `orderId` từ cột tương ứng. Nếu không xác định được (chọn sai sheet, chọn nhiều dòng, chọn dòng trống) → `SpreadsheetApp.getUi().alert(...)` báo lỗi rõ ràng, dừng lại.
2. Hiện hộp thoại xác nhận (`ui.alert(..., ui.ButtonSet.YES_NO)`) hiển thị `orderId` + tổng tiền trước khi thực thi — đây là hành động không thể hoàn tác, không được thực thi ngay không hỏi lại.
3. Lấy `confirmedBy` bằng `Session.getActiveUser().getEmail()` (nếu rỗng do giới hạn quyền, fallback hỏi qua `ui.prompt`).
4. Gọi `orderService.confirmPayment(orderId, confirmedBy)`.
5. Bắt riêng `PaymentAlreadyResolvedError` → hiện `ui.alert('Đơn này đã được xác nhận hoặc không còn chờ thanh toán.')`, không coi là lỗi hệ thống, không ghi vào `ErrorLogs`.
6. Bắt riêng `OrderNotFoundError` và lỗi khác → hiện `ui.alert('Có lỗi xảy ra: ' + message)`, đồng thời ghi vào `ErrorLogs` (dùng lại `SheetErrorLogRepository` đã có).
7. Nếu thành công: dispatch `outboundMessages` tới đúng khách hàng (xem mục 4), rồi `ui.alert('Đã xác nhận và gửi thông báo cho khách.')`.

### 4. Lớp dispatch thông báo — tách riêng để Phase 5 (Zalo) cắm vào không sửa gì ở đây

Tạo `src/adapters/notificationDispatcher.js` (pure, nhận registry) + wiring trong `src/adapters/telegram/...`:

```js
// notificationDispatcher.js — pure, test được bằng Node
function dispatchNotifications(customer, outboundMessages, registry) {
  var results = [];
  (customer.platformLinks || []).forEach(function (link) {
    var entry = registry[link.platform];
    if (!entry) { results.push({ platform: link.platform, skipped: true }); return; }
    outboundMessages.forEach(function (message) {
      entry.client.execute(entry.renderOutboundMessage(message, link.platformUserId));
    });
    results.push({ platform: link.platform, skipped: false });
  });
  return results;
}
```

`registry` là object dạng `{ telegram: { renderOutboundMessage, client }, zalo: { ... } }` — Phase 5 chỉ cần thêm key `zalo`, không đụng file này hay logic Telegram. Wiring cụ thể (`registry` thật) đặt trong 1 file GAS riêng, ví dụ `src/adapters/NotificationRegistry.gs`, để `confirmSelectedOrderPayment()` gọi `dispatchNotifications(customer, result.outboundMessages, buildNotificationRegistry())`.

### 5. Testability

- `orderService.confirmPayment`: unit test kiểu Node giống các test hiện có trong `orderService.test.js` — cover: xác nhận thành công (state chuyển `PAID`, order có `confirmedAt`/`confirmedBy`, trả đúng `outboundMessages`); gọi lần 2 cho cùng order → `PaymentAlreadyResolvedError`, không tạo thay đổi gì thêm; `orderId` không tồn tại → `OrderNotFoundError`; gọi đồng thời 2 lần cho cùng order (dùng kỹ thuật interleave giống test lock ở Phase 1) → chỉ 1 lần thành công.
- `notificationDispatcher.js`: unit test thuần Node với registry giả, cover: khách có 1 platform, khách có platform không có trong registry (phải bỏ qua an toàn, không throw), khách có nhiều `platformLinks` (chuẩn bị sẵn cho tương lai đa kênh dù hiện tại chỉ có Telegram).
- Phần `SpreadsheetApp.getUi()`/`ScriptApp.newTrigger` trong `confirmSelectedOrderPayment()`/`registerSheetMenuTrigger()`: không cần unit test (không mock được có ý nghĩa), nhưng phải tách tối đa logic ra khỏi phần UI — hàm xử lý chính nên nhận `orderId`, `confirmedBy` và trả về 1 object kết quả (`{ ok: true }` / `{ ok: false, reason: 'already_resolved' }` / `{ ok: false, reason: 'not_found' }` / `{ ok: false, reason: 'error', message }`), để phần UI chỉ còn việc hiển thị đúng `alert` tương ứng — tách được phần này ra thì có thể unit test riêng, chỉ phần gọi `ui.alert` thật sự là không test được.

## Acceptance criteria

1. `npm test` và `npm run check:boundaries` pass toàn bộ — `src/core` không có tên nền tảng/`SpreadsheetApp`/`UrlFetchApp`/`LockService` nào mới xuất hiện.
2. Test mới cho `confirmPayment` pass đủ 4 kịch bản ở mục 5.
3. Test mới cho `notificationDispatcher` pass đủ 3 kịch bản ở mục 5.
4. Chạy thử thật: nhân viên bấm menu trên Sheet thật, xác nhận đơn đang `AWAITING_PAYMENT` → khách nhận được tin nhắn Telegram xác nhận thanh toán; bấm lại lần 2 cho cùng đơn → nhận alert "đã xác nhận trước đó", không gửi tin trùng cho khách, không ghi lỗi giả vào `ErrorLogs`.
5. README cập nhật: cách chạy `registerSheetMenuTrigger()` 1 lần, giải thích vì sao không dùng `onEdit`, và ghi rõ quyết định dùng `Order` làm nguồn sự thật thay vì `Payment` repository riêng để Phase 4/5 hiểu lý do khi cần mở rộng.
