# Prompt cho dev — Fix Fast Path payment coupling + Thêm thông báo nhóm khi khách xác nhận đơn

## Bối cảnh

Review gần nhất phát hiện: `FastPathPaymentClient.resolve()` được gọi vô điều kiện cho **mọi** đơn Telegram (cả khách thường lẫn khách Fast Path) từ `PaymentConfirmation.gs` và `paymentExpiry.js`. Hàm này hiện ném exception khi Cloudflare Worker lỗi/không phản hồi, và cả hai call site đang hiểu nhầm "lỗi hạ tầng" thành cùng loại với "đơn này không phải Fast Path". Hậu quả: một Worker vốn chỉ phục vụ nhóm khách thử nghiệm nhỏ (`FAST_PATH_CHAT_IDS`) lại trở thành single point of failure cho việc xác nhận/hết hạn thanh toán của **toàn bộ** khách Telegram.

Thêm vào đó, chủ shop muốn: ngay khi khách bấm "Xác nhận" đơn hàng (chuyển sang `AWAITING_PAYMENT`, tức là **trước khi** thanh toán được xác nhận), nhân viên phải nhận được thông báo trong nhóm để chuẩn bị món — không phải đợi đến lúc nhân viên bấm xác nhận đã chuyển khoản mới biết có đơn.

Đây là 4 việc cần làm, độc lập nhau nhưng nên làm chung 1 lượt vì đụng cùng nhóm file.

## Việc 1 — `src/adapters/telegram/FastPathPaymentClient.gs`: không ném exception, phân loại rõ outcome

`resolve()` hiện ném lỗi khi thiếu config, lỗi mạng, HTTP != 200, hoặc JSON không hợp lệ. Đổi toàn bộ các nhánh đó thành trả về `{ handled: false, outcome: 'infra_error', message: <mô tả> }` thay vì `throw`. Giữ nguyên hành vi trả `{ handled: false, outcome: 'not_found' }` khi không tìm thấy order hoặc khách không có platformLink Telegram — đây vẫn là tín hiệu hợp lệ để fallback về luồng thường. Khi Worker trả HTTP 200 với body hợp lệ, trả nguyên `body` như hiện tại (không đổi).

Bọc `UrlFetchApp.fetch` trong try/catch riêng cho lỗi mạng. Không được để bất kỳ nhánh nào trong hàm này ném exception ra ngoài nữa — mọi lỗi phải thành `{ handled: false, outcome: 'infra_error', message }`.

## Việc 2 — `src/admin/PaymentConfirmation.gs`: xử lý `infra_error` bằng thông báo tiếng Việt

Trong `processOrderPayment()`, thêm nhánh: nếu `fastPath.outcome === 'infra_error'`, trả `{ ok: false, reason: 'fast_path_gateway_unavailable', message: fastPath.message }` ngay, **không** rơi xuống `PaymentConfirmationHandler` (vì ta chưa biết chắc đơn này có phải Fast Path hay không, và gọi lại luồng thường trong khi Worker đang lỗi có thể che mất một đơn Fast Path thật đang chờ xử lý ở phía Worker).

Trong `confirmSelectedOrderPaymentWithoutMetrics()`, thêm nhánh hiển thị cho `reason === 'fast_path_gateway_unavailable'`:

```js
} else if (result.reason === 'fast_path_gateway_unavailable') {
  ui.alert(
    'Không kết nối được hệ thống Fast Path lúc này. Vui lòng thử lại sau ít phút, ' +
    'hoặc báo kỹ thuật nếu lặp lại nhiều lần.'
  );
}
```

Log lỗi này vào `ErrorLogs` với `stage: 'fast_path_gateway'` trước khi trả về, giống cách các nhánh lỗi khác trong file đã làm.

## Việc 3 — `src/admin/paymentExpiry.js`: `infra_error` phải fallback về luồng expire thường, không được bỏ qua đơn

Hiện tại `scan()` bọc `dependencies.resolveFastPath(order)` trong try/catch và **luôn return** khi có lỗi (đánh `summary.failed += 1`, bỏ qua đơn hoàn toàn — kể cả đơn đó chưa từng là Fast Path). Sửa lại: chỉ `return` sớm khi `fastPath.handled === true` (tức Worker đã xử lý xong, dù resolved hay already_resolved). Khi `fastPath.outcome === 'infra_error'`, **không return** — để code rơi tiếp xuống nhánh `expireOrder(order.orderId)` bình thường ngay bên dưới, y như trước khi có Fast Path. Đồng thời log 1 dòng cảnh báo riêng (`stage: 'fast_path_probe_failed'`) để biết Worker đang có vấn đề, nhưng không được làm gián đoạn việc hết hạn đơn thật.

Vì `resolve()` không còn `throw` (sau Việc 1), bỏ luôn try/catch bọc `dependencies.resolveFastPath` trong `paymentExpiry.js` — chỉ cần kiểm tra field `outcome`/`handled` trên object trả về.

## Việc 4 — Thông báo nhóm ngay khi khách xác nhận đơn (trước khi thanh toán)

Phạm vi: áp dụng cho **luồng Telegram thường** (`src/adapters/telegram/webhook.gs`), vì Fast Path (`telegram-gateway/src/index.ts`, hàm `handleFastPath`) đã có cơ chế này rồi (gửi `operations_order` message khi `inboundAction === 'confirm_order'`) — không cần sửa Fast Path.

### Script Property mới

Thêm `TELEGRAM_OPERATIONS_CHAT_ID` (optional) vào danh sách property của GAS — **không bắt buộc**, để không phá healthCheck/setupProject hiện tại. Nếu thiếu, tính năng này tự tắt (không thông báo gì), log 1 dòng warn (không phải error) mỗi lần bỏ qua, không ảnh hưởng luồng khách hàng.

### Vị trí kích hoạt

Trong `TelegramWebhook.doPost`, sau khi `transaction` (khối `withLock`) hoàn tất, hiện đã có `answerCallback` xác định `inbound.payload.action`. Cần nhận diện đúng thời điểm đơn vừa được tạo — dùng chính điều kiện này: `inbound.payload && inbound.payload.action === 'confirm_order'` VÀ `!transaction.duplicate` VÀ `transaction.recovery && transaction.recovery.orderId` tồn tại (nghĩa là outbound có message `payment_qr`, tức đơn đã thật sự chuyển sang `AWAITING_PAYMENT`, không phải rơi vào nhánh lỗi/pending order cũ).

Không dùng lại `action !== 'confirm_order'` để suy luận qua path khác — phải check đúng field này để không bắn nhầm thông báo khi khách chỉ xem lại trạng thái (`action === 'status'` cũng trả về `payment_qr`, nhưng khi đó `action` không phải `'confirm_order'`).

### Lấy dữ liệu để soạn tin nhắn

Không cần thêm dependency mới hay đụng vào `src/core/`. Trong khối `withLock`, biến `outbound` (kết quả thô của `orderService.handleMessage(inbound)`, trước khi render) đã chứa message dạng:

```js
{ type: 'text', content: { text: '...', orderId: '...', amount: 123456 } }
```

Tìm phần tử này (`message.type === 'text' && message.content && message.content.orderId != null`) tương tự cách `recoveryFrom` đã tìm message `payment_qr` — lấy `orderId` và `amount` từ đó, đưa vào object trả về của `withLock` (thêm field mới, ví dụ `confirmedOrderSummary`) để dùng ở tầng ngoài sau khi transaction đã commit.

### Gửi thông báo

Sau khi transaction hoàn tất và (độc lập với việc gửi tin cho khách có thành công hay không — thông báo nhóm không phụ thuộc vào delivery status phía khách), gọi:

```js
if (!transaction.duplicate && transaction.confirmedOrderSummary) {
  notifyOperationsGroup(transaction.confirmedOrderSummary, chatId);
}
```

`notifyOperationsGroup` là hàm mới, best-effort, không được làm hỏng response `200 OK`:

```js
function notifyOperationsGroup(summary, customerChatId) {
  var opsChatId = PropertiesService.getScriptProperties().getProperty('TELEGRAM_OPERATIONS_CHAT_ID');
  if (!opsChatId) return;
  try {
    dependencies.client.execute({
      method: 'sendMessage',
      params: {
        chat_id: opsChatId,
        text: '🔔 ĐƠN MỚI #' + summary.orderId + '\n' +
          'Khách Telegram: ' + customerChatId + '\n' +
          'Tổng: ' + summary.amount.toLocaleString('vi-VN') + ' đ\n' +
          'Trạng thái: Chờ thanh toán\n' +
          'Xem chi tiết trong Sheet Orders.'
      }
    });
  } catch (error) {
    logError(error, { stage: 'operations_notify', orderId: summary.orderId });
  }
}
```

Đặt hàm này bên trong closure `create()` của `TelegramWebhook` (cạnh `handleProcessingFailure`, `logError`...) để dùng chung `dependencies.client` và `logError` sẵn có. Lỗi gửi thông báo nhóm không được:
- Làm thay đổi `deliveryStatus` của update (đây là kênh phụ, tách biệt hoàn toàn với việc gửi tin cho khách).
- Kích hoạt fallback message gửi cho khách.
- Làm webhook trả về khác `200 OK`.

### Idempotency

Vì đặt sau khối `withLock` và có check `!transaction.duplicate`, một `update_id` bị Telegram gửi lại (do timeout/retry) sẽ không bắn thông báo nhóm lần 2 — logic dedupe hiện có (`processedUpdateRepository.has/markProcessed`) đã đủ, không cần cơ chế idempotency riêng cho thông báo này.

## Việc không cần làm (out of scope, đừng động vào)

- Không sửa `telegram-gateway/src/index.ts` hay `fastpath.ts` — Fast Path đã tự có cơ chế thông báo nhóm riêng qua `operations_order` queue message.
- Không sửa Zalo adapter — nếu chủ shop muốn tính năng này cho Zalo, sẽ làm ở 1 prompt riêng sau.
- Không đổi cấu trúc `Orders` sheet hay `OrderService` core.

## Test cần bổ sung

Trong `src/tests/telegram/webhook.test.js` (hoặc file tương ứng), thêm:

1. `confirm_order` thành công (không duplicate) → `client.execute` được gọi thêm 1 lần với `chat_id === TELEGRAM_OPERATIONS_CHAT_ID` và text chứa đúng `orderId`/số tiền, **ngoài** các lệnh gửi khách hàng bình thường.
2. Duplicate `update_id` cho cùng 1 `confirm_order` → không gọi thêm lần thông báo nhóm nào (so đếm số lần gọi `client.execute` với `chat_id === opsChatId`).
3. `action === 'status'` (khách chỉ xem lại đơn đang chờ) → **không** bắn thông báo nhóm dù outbound cũng có `payment_qr`.
4. Thiếu `TELEGRAM_OPERATIONS_CHAT_ID` → không throw, không gọi thêm request nào, webhook vẫn trả `200 OK` bình thường.
5. `client.execute` cho thông báo nhóm ném lỗi → không ảnh hưởng response cho khách, lỗi được log với `stage: 'operations_notify'`.

Cho `FastPathPaymentClient`/`PaymentConfirmation`/`paymentExpiry`, thêm test:

6. `resolve()` trả `infra_error` khi thiếu `TELEGRAM_WEBHOOK_URL`/`GAS_GATEWAY_TOKEN`, khi `UrlFetchApp.fetch` ném lỗi, khi HTTP status != 200, và khi JSON không parse được — không có test nào được phép mong đợi `resolve()` throw nữa.
7. `processOrderPayment()` với `infra_error` → trả `{ ok: false, reason: 'fast_path_gateway_unavailable' }`, không gọi `PaymentConfirmationHandler`.
8. `paymentExpiry.scan()`: khi `resolveFastPath` trả `infra_error` cho 1 đơn, đơn đó vẫn được xử lý tiếp bằng `orderService.expireOrder` bình thường (không bị đếm vào `summary.failed` do fast path, không bị bỏ qua).

Chạy `npm run check` (test + boundary check) trước khi báo hoàn thành. Không được để boundary check phát hiện tên nền tảng hay `UrlFetchApp` lọt vào `src/core/`.
