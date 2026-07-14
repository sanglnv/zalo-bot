# Zalo Clawbot — Kế hoạch xây dựng theo phase

Mục tiêu: build bot đặt hàng/chốt bill/gửi QR/xác nhận CK, chạy song song Telegram (dev/test) và Zalo OA (production chính), kiến trúc tách lớp để không phải viết lại core khi mở rộng nền tảng.

## Phase 0 — Chuẩn bị & thủ tục (chạy song song với Phase 1-2, không block dev)

- Đăng ký Telegram bot qua @BotFather — lấy token, miễn phí, xong trong vài phút.
- Bắt đầu ngay thủ tục Zalo OA: tạo OA, nộp hồ sơ xác thực doanh nghiệp (giấy phép kinh doanh). Thời gian duyệt thường vài ngày–vài tuần nên phải khởi động sớm, không đợi Telegram xong mới làm.
- Chưa cần mua gói Tăng trưởng ngay — chỉ mua khi chuẩn bị sang Phase 5 (tránh trả phí trong lúc chưa dùng API).
- Chọn nhà cung cấp sinh QR: VietQR.io (miễn phí, cần tài khoản ngân hàng hỗ trợ VietQR) hoặc API riêng của ngân hàng đang dùng. Xác nhận trước định dạng nội dung chuyển khoản sẽ dùng để nhét mã đơn hàng.
- Chọn datastore ban đầu: Google Sheet (đủ cho MVP, chi phí 0). Ghi rõ ranh giới khi nào chuyển sang Supabase (ví dụ: khi số đơn/ngày vượt ngưỡng gây race condition/chậm do Sheet).
- Setup GAS project bằng `clasp` để có version control (git) thay vì sửa trực tiếp trên editor online — bắt buộc nếu muốn làm "bài bản".

## Phase 1 — Kiến trúc nền (core domain, platform-agnostic)

Đây là phase quan trọng nhất để tránh đập đi làm lại — toàn bộ logic nghiệp vụ không được biết gì về Telegram hay Zalo.

- Domain model: `Customer`, `Product`, `Order`, `OrderItem`, `Payment`, `ConversationState`.
- State machine hội thoại: `IDLE → BROWSING → CART → CONFIRMING → AWAITING_PAYMENT → PAID → DONE` (+ `CANCELLED`, `EXPIRED`). Lưu state theo key định danh khách hàng nội bộ (không phải `chat_id`/`user_id` của từng nền tảng — xem điểm định danh bên dưới).
- Interface message chuẩn hóa dùng chung cho mọi nền tảng:
  - `InboundMessage { platform, platformUserId, text, payload }`
  - `OutboundMessage { type: 'text' | 'list' | 'button' | 'image', content }`
- Repository pattern cho storage: mọi chỗ khác trong code gọi `OrderRepository.save()`, `OrderRepository.findById()`... không gọi thẳng `SpreadsheetApp`. Nhờ vậy đổi sang Supabase sau này chỉ sửa 1 file repository, không đụng logic nghiệp vụ.
- Định danh khách hàng độc lập nền tảng: tạo `customer_id` nội bộ (map theo số điện thoại nếu có), để sau này khách dùng cả Zalo lẫn Telegram vẫn hợp nhất được lịch sử đơn hàng.

## Phase 2 — Build & test trên Telegram

- Telegram adapter: webhook receiver (`doPost`), wrapper gọi Telegram Send API (`sendMessage`, `sendPhoto`, inline keyboard).
- Implement hiển thị catalog (inline keyboard), thêm/bớt giỏ hàng, tính tổng bill.
- Tách logic tính bill/chuyển state ra thành hàm thuần (pure function, không phụ thuộc GAS service) để có thể unit test độc lập — chạy test bằng Node/clasp run trước khi deploy.
- Test nội bộ với vài đơn giả lập đủ các nhánh: thêm/xóa món, huỷ giữa chừng, đặt trùng lúc (2 request cùng lúc) để kiểm tra race condition.

## Phase 3 — Tích hợp thanh toán (VietQR + xác nhận thủ công)

- Module sinh QR: gọi VietQR API với số tiền + nội dung CK chứa mã đơn hàng (bắt buộc để đối soát được).
- Gửi ảnh QR qua Telegram (`sendPhoto`).
- Vì không làm auto-reconcile: xây một dashboard tối giản (Sheet có nút hoặc Web App nhỏ) để nhân viên bấm "Đã nhận tiền" cho từng đơn — bot tự động gửi tin xác nhận lại khách khi trạng thái đổi.
- Module này thiết kế xong ở Telegram thì dùng nguyên vẹn cho Zalo — không phụ thuộc nền tảng chat.

## Phase 4 — Hardening (bắt buộc trước khi mở rộng nền tảng, không được bỏ qua)

- Áp `LockService` mọi chỗ đọc/ghi đơn hàng, tồn kho, giỏ hàng để tránh 2 request cùng lúc ghi đè nhau.
- Tự động huỷ/nhắc đơn nếu quá X phút không thanh toán (time-driven trigger).
- Logging lỗi vào sheet riêng, có thể dò lại khi khách báo lỗi.
- Đo thử tải: số UrlFetch calls/ngày, thời gian execution mỗi request — so với quota GAS để biết ngưỡng cần chuyển sang kiến trúc khác (Supabase, hoặc thêm queue).
- Checklist rà lại toàn bộ nhánh state machine, đảm bảo không có state nào "kẹt" không thoát ra được.

## Phase 5 — Zalo adapter (bắt đầu code khi hồ sơ Phase 0 đã duyệt xong)

- Lúc này mới mua gói Tăng trưởng Zalo OA (Phase 0 đã nộp hồ sơ từ đầu nên thời điểm này thường đã được duyệt).
- Viết Zalo adapter cùng interface `InboundMessage`/`OutboundMessage` như Telegram — nếu Phase 1 làm đúng, phần này chỉ là map lại UI component (list template/button template của Zalo) và gọi Send API riêng của Zalo.
- Đăng ký & chờ duyệt template tin nhắn nếu dùng ZBS Template Message cho xác nhận đơn/thanh toán (cần thời gian duyệt, làm sớm).
- Chạy song song 2 kênh, so sánh hành vi để đảm bảo tính nhất quán trải nghiệm.

## Phase 6 — Go-live & vận hành

- Soft launch với nhóm nhỏ khách thật trên cả 2 kênh trước khi mở rộng toàn bộ.
- Theo dõi log lỗi, thời gian phản hồi, tỷ lệ đơn bị kẹt state.
- Dashboard vận hành cho nhân viên: danh sách đơn chờ xác nhận CK, đơn đang xử lý.
- Sau một chu kỳ ổn định, đánh giá lại ngưỡng chuyển từ Sheet sang Supabase dựa trên số liệu thực tế đo được ở Phase 4/6.

## Nguyên tắc xuyên suốt để không phải đập đi làm lại

- Core logic không bao giờ import trực tiếp API của Telegram/Zalo — chỉ giao tiếp qua interface chuẩn hóa ở Phase 1.
- Mọi thao tác storage đi qua Repository, không gọi thẳng SpreadsheetApp/Supabase client rải rác trong code.
- Thủ tục pháp lý/xác thực Zalo OA luôn chạy song song với dev, không tuần tự — đây là phase dài nhất về thời gian chờ nhưng ít công sức, phí phạm nếu để nó chặn tiến độ.
