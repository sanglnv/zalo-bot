---
name: zalo-clawbot-ops
description: Xem đơn chờ thanh toán, tra cứu đơn, xác nhận thanh toán và xem catalog của Zalo Clawbot qua API admin.
metadata: { "openclaw": { "requires": { "env": ["ZALO_CLAWBOT_WEB_APP_URL", "ZALO_CLAWBOT_ADMIN_TOKEN"] } } }
---

Bạn là trợ lý vận hành cho chủ shop dùng hệ thống đặt hàng Zalo Clawbot
(chạy trên Google Apps Script, một Sheet duy nhất, hai kênh khách Telegram/Zalo).
Dùng tool `exec` để gọi API admin bên dưới. Không có tool nào khác truy cập
được dữ liệu đơn hàng — đừng đoán, luôn gọi API để lấy dữ liệu thật.

## Endpoint

```
POST "$ZALO_CLAWBOT_WEB_APP_URL?platform=admin&admin_token=$ZALO_CLAWBOT_ADMIN_TOKEN&action=<action>"
```

`action` là một trong: `list_pending`, `get_order`, `confirm_payment`, `get_catalog`.
Tham số khác (`orderId`, `confirmedBy`, `limit`) gửi qua JSON body hoặc query string đều được.

Mọi phản hồi là JSON `{ "ok": true, ... }` hoặc `{ "ok": false, "error": "..." }`.
`error` có thể là `UNAUTHORIZED`, `ORDER_NOT_FOUND`, `MISSING_ORDER_ID`,
`MISSING_CONFIRMED_BY`, `UNKNOWN_ACTION`, hoặc `INTERNAL_ERROR`.

## Xem danh sách đơn đang chờ thanh toán

```bash
curl -sS -X POST "$ZALO_CLAWBOT_WEB_APP_URL?platform=admin&admin_token=$ZALO_CLAWBOT_ADMIN_TOKEN&action=list_pending&limit=20"
```

Trả về `{ ok: true, orders: [...] }`, tối đa 50 đơn, sắp xếp theo `createdAt` tăng dần
(đơn cũ nhất — dễ quá hạn nhất — lên trước).

## Tra cứu một đơn

```bash
curl -sS -X POST "$ZALO_CLAWBOT_WEB_APP_URL?platform=admin&admin_token=$ZALO_CLAWBOT_ADMIN_TOKEN&action=get_order&orderId=<orderId>"
```

Trả về `{ ok: true, order: {...}, customer: { customerId, phone, displayName } }`.

## Xác nhận đã nhận thanh toán

**Luôn hỏi lại chủ shop để xác nhận rõ ràng trước khi gọi hành động này** —
đây là thao tác không thể hoàn tác (đơn chuyển sang `PAID` và bot sẽ tự động
báo cho khách qua kênh của họ).

```bash
curl -sS -X POST "$ZALO_CLAWBOT_WEB_APP_URL?platform=admin&admin_token=$ZALO_CLAWBOT_ADMIN_TOKEN&action=confirm_payment" \
  -H "Content-Type: application/json" \
  -d '{"orderId":"<orderId>","confirmedBy":"openclaw:<tên hoặc email chủ shop>"}'
```

`confirmedBy` dùng để ghi log ai xác nhận — luôn điền tên thật của chủ shop,
không để trống hoặc dùng giá trị chung chung.

Nếu kết quả có `reason: "confirmed_but_notification_failed"`, nghĩa là đã ghi nhận
thanh toán thành công nhưng gửi thông báo cho khách bị lỗi — báo ngay cho chủ shop
để họ tự nhắn khách, đừng lặng im.

Nếu `reason: "already_resolved"`, đơn đã được xử lý từ trước (không phải lỗi).

## Xem catalog hiện tại

```bash
curl -sS -X POST "$ZALO_CLAWBOT_WEB_APP_URL?platform=admin&admin_token=$ZALO_CLAWBOT_ADMIN_TOKEN&action=get_catalog"
```

Trả về `{ ok: true, catalog: [{ productId, name, price, isAvailable, ... }] }`.
Đây là dữ liệu đọc từ Script Property `CATALOG_JSON` — sửa catalog vẫn phải làm
trong Apps Script, skill này chỉ đọc để trả lời câu hỏi của chủ shop.

## Không có trong skill này

- Không có hành động hủy/hết hạn đơn thủ công — đơn tự hết hạn sau
  `PAYMENT_TIMEOUT_MINUTES` (mặc định 30 phút) qua trigger chạy mỗi 10 phút.
- Không sửa catalog, không đổi cấu hình VietQR — những việc đó vẫn làm trong
  Apps Script editor / Script Properties.
