# Prompt cho dev / AI coding agent — Phase 5: Zalo OA adapter

Dán nguyên văn cho dev. Phase 1-4 đã done, đã qua nhiều vòng review. **Không sửa bất kỳ file nào trong `src/core/`.** Toàn bộ contract (`InboundMessage`, `OutboundMessage`, `handleMessage`, `confirmPayment`, `expireOrder`, `withLock`) đã cố định — Phase 5 chỉ là thêm 1 adapter mới, đúng tinh thần đã thiết kế từ Phase 1.

## Bối cảnh — khung đã có sẵn, chỉ cần điền đúng chỗ

`notificationDispatcher.js`/`NotificationRegistry.gs` đã được thiết kế từ Phase 3 chính xác để thêm 1 kênh mới mà không đụng code Telegram. Việc của Phase 5 là viết adapter Zalo theo đúng khuôn Telegram (`mapInboundMessage`, `renderOutboundMessage`, `Client.gs`, `webhook.gs`, idempotency, tách lỗi "thất bại thật" khỏi "thành công nhưng gửi thông báo thất bại") — **áp dụng lại nguyên vẹn các pattern đã được review/fix qua 4 phase**, không phát minh lại hoặc bỏ sót bất kỳ pattern nào trong số đó. Điểm khác Telegram nằm ở đặc thù riêng của Zalo OA API, liệt kê dưới đây.

## Yêu cầu bắt buộc

### 1. Trước khi code — tra cứu tài liệu Zalo hiện tại, không dùng số liệu cũ

Zalo OA API (xác thực OAuth, cơ chế ký webhook, giới hạn payload nút bấm, cấu trúc ZBS Template Message) đã và có thể tiếp tục thay đổi. Trước khi implement, dev phải tra cứu tài liệu chính thức mới nhất tại `developers.zalo.me` cho: (a) thuật toán xác thực chữ ký webhook (`mac`/`signature` — trường nào được ký, thuật toán HMAC nào, dùng secret nào), (b) endpoint và tham số OAuth refresh token hiện hành, (c) giới hạn ký tự/byte của `payload` trong list/button template. Không giả định các giá trị này giống Telegram hoặc giống hiểu biết cũ — xác nhận lại tại thời điểm code.

### 2. Xác thực chữ ký webhook — bắt buộc, Telegram không cần nhưng Zalo có

Khác với Telegram (không ký payload theo mặc định), Zalo OA ký mỗi request webhook. `webhook.gs` của Zalo phải xác minh chữ ký trước khi xử lý bất kỳ gì — nếu chữ ký sai, từ chối ngay (log vào `ErrorLogs` với `stage: 'signature_verification'`, trả về response hợp lệ nhưng không xử lý nghiệp vụ). Đây là bước bảo mật bắt buộc, không được bỏ qua dù chỉ để chạy thử nhanh.

### 3. OAuth access_token/refresh_token — rủi ro vận hành lớn nhất của Zalo so với Telegram

Telegram dùng 1 bot token tĩnh, không hết hạn. Zalo dùng access_token ngắn hạn + refresh_token — refresh_token **bị xoay vòng mỗi lần dùng** (dùng xong là mất hiệu lực, phải lưu lại token mới ngay). Yêu cầu bắt buộc:
- Lưu `access_token`, `refresh_token`, thời điểm hết hạn vào `PropertiesService` (không lưu vào Sheet — đây là secret).
- Viết `ZaloTokenManager.gs`: hàm `getValidAccessToken()` tự kiểm tra hết hạn, tự gọi refresh khi cần, và **ghi đè `refresh_token` mới ngay lập tức** sau mỗi lần refresh — nếu ghi đè thất bại hoặc bị gọi refresh 2 lần chồng nhau, bot sẽ mất quyền truy cập vĩnh viễn cho tới khi cấp lại token thủ công.
- Bọc toàn bộ thao tác đọc-kiểm tra-refresh-ghi token trong `SheetRepositorySupport.withScriptLock` (dùng chung lock toàn cục đã có) để tránh 2 execution GAS cùng lúc phát hiện token hết hạn và cùng gọi refresh — dẫn đến refresh_token bị xoay vòng 2 lần, 1 bên chắc chắn hỏng.
- Viết test giả lập: 2 lần gọi `getValidAccessToken()` liên tiếp khi token đã hết hạn — xác nhận chỉ 1 lần refresh thật sự được gọi, lần thứ 2 dùng lại token mới vừa lưu.
- Thêm 1 script/hàm cấp token lần đầu (`bootstrapZaloTokens(accessToken, refreshToken)`) để nhập token khởi tạo thủ công từ OAuth flow ban đầu (không tự động hoá được bước xin quyền lần đầu vì cần đăng nhập OA qua trình duyệt).

### 4. Mapping Inbound

Map field Zalo webhook (`event_name`, `sender.id`, `message.text`, `message.msg_id`, hoặc field nút bấm tương ứng nếu Zalo gửi dạng khác `callback_query`) sang đúng `InboundMessage { platform: 'zalo', platformUserId, text, payload }`. Nếu Zalo không có khái niệm nút bấm postback giống Telegram (`callback_query`), và list/button template của Zalo submit lại dưới dạng tin nhắn text thường hoặc 1 event khác — xác nhận đúng theo tài liệu (mục 1) và thiết kế mapping tương ứng, không giả định giống Telegram.

### 5. Rendering Outbound — map cả 4 loại `OutboundMessage` sang đúng cấu trúc Zalo Send API

`text` → tin nhắn văn bản thường qua Send API (`https://openapi.zalo.me/v3.0/oa/message/cs` hoặc endpoint hiện hành theo tài liệu). `list` (catalog) → Zalo list template. `button` (xác nhận/huỷ) → Zalo button template — payload nút bấm dùng encode compact tương tự Telegram nhưng **tự xác nhận giới hạn byte của Zalo** (mục 1), không copy nguyên số 64 byte của Telegram nếu không đúng. `image` (QR) → gửi ảnh qua Send API (Zalo có hỗ trợ gửi ảnh theo URL trực tiếp tương tự Telegram `sendPhoto`; xác nhận field chính xác theo tài liệu).

### 6. ZBS Template Message cho thông báo ngoài khung 48 giờ — bắt buộc cho `confirmPayment`/`expireOrder`

Đây là khác biệt quan trọng nhất so với Telegram. Zalo OA chỉ cho gửi tin nhắn tự do (Send API thường) trong vòng 48 giờ kể từ tin nhắn cuối của khách. `confirmPayment` (nhân viên bấm menu) và `expireOrder` (chạy theo lịch) **không xuất phát từ tin nhắn của khách** — nếu khách không nhắn gì trong 48h trước đó, gửi qua Send API thường sẽ thất bại. Do đó:
- Registry Zalo cho 2 loại thông báo này phải dùng **ZBS Template Message** (template đã được duyệt trước qua Zalo Business Solutions), không phải Send API thường.
- Cần đăng ký trước ít nhất 1 template "Xác nhận thanh toán" và 1 template "Đơn hàng hết hạn" qua Zalo Business Solutions dashboard (việc này làm thủ công ngoài code, ghi rõ vào README như một bước chuẩn bị bắt buộc trước khi Phase 5 chạy thật — tương tự việc mua gói Tăng trưởng đã ghi từ đầu dự án).
- Vì tin nhắn phản hồi trực tiếp trong luồng chat (`catalog`, `add_item`, `checkout`, `confirm_order`, `cancel` qua `handleMessage`) luôn xảy ra trong vòng 48h (khách vừa nhắn xong), các action này vẫn dùng Send API thường bình thường — không cần ZBS Template Message.
- `NotificationRegistry.gs` cho Zalo cần phân biệt 2 client (Send API thường cho phản hồi tức thời trong `webhook.gs`, và ZBS Template client cho `dispatchNotifications` dùng bởi `confirmPayment`/`expireOrder`) — ghi rõ trong code tại sao lại có 2 client khác nhau cho cùng 1 platform, tránh dev sau này nhầm lẫn dùng nhầm client.

### 7. Idempotency, deliveryStatus, tách lỗi — tái sử dụng nguyên mẫu Telegram, không viết lại từ đầu

Dùng lại đúng kiến trúc: `SheetProcessedUpdateRepository` (thêm cột phân biệt platform nếu dùng chung 1 sheet, hoặc tạo sheet riêng `ZaloProcessedUpdates` — chọn 1 trong 2 và ghi lý do vào README), đánh dấu theo `msg_id` của Zalo tương tự `update_id`. Áp dụng đúng pattern tách "đã nhận"/"đã xử lý xong"/"đã gửi thành công" đã fix ở Phase 2, và pattern tách "nghiệp vụ thành công nhưng thông báo thất bại" đã fix ở Phase 3 — 2 pattern này áp dụng cho MỌI adapter mới từ giờ trở đi, không phải việc cần "phát hiện lại" mỗi phase.

### 8. Testability

Theo đúng khuôn Phase 2: tách `mapInboundMessage.js`/`renderOutboundMessage.js` (pure, test Node thuần) khỏi `ZaloClient.gs`/`ZbsTemplateClient.gs`/`webhook.gs` (GAS glue, test theo kỹ thuật mock `UrlFetchApp`/`PropertiesService`/`LockService` đã dùng xuyên suốt dự án). Test riêng cho `ZaloTokenManager` (refresh đúng lúc, không refresh trùng, ghi đè refresh_token mới). Test riêng cho việc chọn đúng client (Send API thường vs ZBS Template) tuỳ ngữ cảnh gọi.

## Acceptance criteria

1. `npm test` và `npm run check:boundaries` pass toàn bộ — không file nào trong `src/core` bị đổi, không platform name lạ lọt vào core.
2. Test xác thực chữ ký webhook: chữ ký đúng được xử lý, chữ ký sai bị từ chối và log riêng, không có ngoại lệ nào lọt ra ngoài khiến webhook trả lỗi cho Zalo.
3. Test `ZaloTokenManager`: refresh đúng lúc hết hạn, không refresh trùng khi gọi đồng thời, ghi đè `refresh_token` mới thành công.
4. Test end-to-end catalog → thêm món → checkout → confirm → nhận đúng lệnh gửi ảnh QR qua Send API thường (trong 48h).
5. Test `confirmPayment`/`expireOrder` dispatch qua Zalo dùng đúng ZBS Template Message, không dùng nhầm Send API thường.
6. Deploy thật, đăng ký webhook Zalo, nhắn tin thật kiểm tra toàn bộ luồng — bao gồm thử để quá 48h rồi để nhân viên xác nhận thanh toán, xác nhận khách vẫn nhận được thông báo qua ZBS Template Message.
7. README cập nhật: bước chuẩn bị thủ công (mua gói Tăng trưởng — đã có từ đầu dự án, đăng ký OA xác thực, đăng ký template ZBS), Script Properties cần thiết, và giải thích rõ khi nào dùng Send API thường vs ZBS Template Message.
