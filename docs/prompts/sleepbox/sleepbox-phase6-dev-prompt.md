# Prompt cho dev / AI coding agent — Sleepbox Phase 6: Hardening & go-live checklist

Dán nguyên văn cho dev. Sleepbox Phase 1-5 đã done — booking chạy trên cả Telegram + Zalo, dùng POS
thật, thanh toán qua `/thanhtoan`. Phase này là bước dọn dẹp cuối trước khi coi tính năng "production
ready", theo đúng tinh thần code review đã áp dụng cho FnB (`codebase-review-fix-prompt.md`).

## Yêu cầu bắt buộc

### 1. Tự chạy 1 vòng review giống `gas-code-review` skill

Trước khi merge PR cuối cùng, chạy lại đúng 4 hạng mục đã dùng cho FnB review gốc: Security &
Authorization, GAS Platform Constraints, Architecture & Testability, Data Integrity — áp riêng cho
toàn bộ file `*booking*`/`*Booking*`/`*Sleepbox*` mới thêm. Đối chiếu các lỗi đã tìm thấy ở FnB (xem
`codebase-review-fix-prompt.md`) xem sleepbox có mắc lại lỗi tương tự không, đặc biệt:

- **Global script lock**: `SleepboxWebhookClient`/`BookingRepository`'s network call có đang nằm
  trong `withScriptLock` không cần thiết không (High #1 của FnB review)? Nếu booking flow và order
  flow dùng chung 1 script lock (đúng thiết kế hiện tại của GAS), xác nhận không có network call nào
  của booking bị giữ lock lâu hơn cần thiết.
- **Quét tuyến tính không index** (High #2): nếu Phase 5 chưa xoá hẳn `SheetRoomRepository`/
  `SheetBookingRepository`, các hàm `findByCustomerId`/tương đương có bị quét toàn sheet mỗi tin nhắn
  không — áp dụng cùng cơ chế cache (`CacheService`) nếu cần.
- **Coupling ẩn giữa text và logic chọn template** (High #3): nếu Zalo booking cũng cần push qua ZBS
  template trong tương lai (hiện tại Phase 3/4 dùng interactive Send API bình thường, không qua ZBS),
  đảm bảo không lặp lại lỗi suy luận loại thông báo từ nội dung text tiếng Việt.
- **Fail-open vs fail-closed cho quyền hạn**: `isAuthorizedOpsAdmin` dùng chung giữa order và booking
  — xác nhận `/thanhtoan <bookingId>` cũng bị chặn đúng khi `TELEGRAM_ADMIN_USER_IDS` rỗng (đã fix
  fail-closed cho order, booking dùng chung hàm này nên phải tự động đúng — viết test xác nhận, đừng
  giả định).

### 2. Làm tròn tiền tệ

Xác nhận `bookingBilling.js`'s `totalAmount` đã `Math.round` ngay từ Phase 1 (đã yêu cầu trong
`sleepbox-phase1-dev-prompt.md` mục 3) — nếu vì lý do gì đó bị bỏ sót, fix ngay ở đây, viết test case
số tiền không chia hết (giống Medium #1 của FnB review).

### 3. Cảnh báo vận hành

Xác nhận `scanAndExpireStaleBookings` (nếu có, Phase 5 mục 4) đã gửi cảnh báo ops chat khi scan lỗi
toàn bộ — không chỉ log im lặng vào `ErrorLogs`.

### 4. Docs

- `docs/sleepbox-booking-integration.md` (viết ở Phase 5) đầy đủ: cấu hình cần thiết, luồng hội
  thoại, known assumptions, giới hạn đã biết (double-booking race nếu có, availability tính tay nếu
  POS không tự làm, id-disambiguation giữa order/booking).
- `README.md`: thêm bảng biến môi trường mới (`SLEEPBOX_WEBHOOK_URL`/`_SECRET` hoặc ghi rõ dùng
  chung `BOT_ORDER_WEBHOOK_*`) theo đúng format bảng hiện có.
- Đánh dấu `docs/sleepbox-booking-plan.md` (file gốc) là **đã triển khai xong**, ghi ngày hoàn thành
  và link tới `docs/sleepbox-booking-integration.md`, tương tự cách các quyết định kiến trúc cũ được
  đối chiếu lại sau khi implement xong (xem cách `project_pos_member_loyalty_blocked` memory được cập
  nhật khi member/loyalty hoàn thành, nếu dev có quyền truy cập memory — nếu không thì chỉ cần cập
  nhật file doc là đủ).

### 5. `npm run check` toàn bộ + deploy checklist

- `npm run check` (test + `check:boundaries`) pass 100%, không skip test nào.
- `clasp push` lên GAS, deploy lại Web App version mới.
- Xác nhận `SystemSetup.validateConfiguration()`/health check (dạng JSON đã thấy dùng để debug
  `TELEGRAM_ADMIN_USER_IDS`/`menuSource` trước đây) báo `ok` cho toàn bộ property mới liên quan
  sleepbox.
- Test tay đầy đủ vòng đời 1 booking thật trên CẢ Telegram lẫn Zalo: đặt phòng theo giờ, đặt phòng
  theo đêm, huỷ, thanh toán, (nếu có) hết hạn tự động — không chỉ test 1 nhánh happy path.
- Xác nhận đặt món (FnB) vẫn hoạt động bình thường sau khi thêm router — chạy lại toàn bộ luồng FnB
  cũ 1 lượt tay thật, không chỉ tin vào test tự động (bài học từ chính session review trước: test
  pass không đồng nghĩa production đúng, ví dụ lỗi `memberRepository` chưa wire vào production dù
  test đã pass — đọc `docs/bot-order-webhook-integration.md`'s ghi chú ngày 2026-07-19 để hiểu rõ
  loại lỗi này có thể xảy ra ở đâu).

## Acceptance criteria — go-live

1. `npm run check` pass 100%.
2. Review 4 hạng mục ở mục 1 hoàn tất, không còn issue High nào chưa xử lý (Medium/Low có thể gộp PR
   riêng, theo đúng convention `codebase-review-fix-prompt.md` đã dùng).
3. Test tay đầy đủ (mục 5) trên cả 2 platform, cả 2 loại đơn vị (giờ/đêm), pass không lỗi.
4. Docs đầy đủ, `SystemSetup` health check báo `ok` toàn bộ.
5. Deploy thật, theo dõi `ErrorLogs`/ops chat trong ít nhất 24h đầu sau go-live trước khi coi là ổn
   định (đặc biệt chú ý lỗi dạng "invalid JSON (HTTP xxx)" từ `SleepboxWebhookClient` — đã có tiền lệ
   với FnB do URL POS bị đổi sau khi POS dev tạo deployment mới thay vì update deployment cũ).
