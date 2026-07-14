# Prompt cho dev — Fix triệt để 2 lỗi Critical/High phát hiện ở code review Phase 1

Dán nguyên văn cho dev. Đây là fix bắt buộc trước khi Phase 1 được coi là "done" — không phải nice-to-have.

---

## Bối cảnh

Code review Phase 1 (`domain.js`, `stateMachine.js`, `billing.js`, `orderService.js`, `repositoryContracts.js`, `Sheet*Repository.gs`) đã pass 12/12 test và boundary check, nhưng test coverage có khoảng trống che giấu 2 lỗi thật sự. Cả 2 đều đã được tái hiện bằng script chạy thực tế, không phải suy đoán lý thuyết.

## Lỗi 1 (Critical) — State machine chặn thêm món thứ 2 vào giỏ

**Nguyên nhân**: `stateMachine.js` định nghĩa `TRANSITIONS.CART` chỉ có `REVIEW_CART` và `CANCEL`, thiếu `ADD_TO_CART` như một self-loop. Nhưng `orderService.js` (`handleMessage`, nhánh `action === 'add_item'`) luôn bắn event `ADD_TO_CART` bất kể state hiện tại là `BROWSING` (lần đầu) hay `CART` (đã có ít nhất 1 món). Kết quả: gọi `add_item` lần thứ 2 trở đi sẽ throw `Invalid transition: CART --ADD_TO_CART--> ?`, tức là khách không thể đặt quá 1 loại món.

**Fix bắt buộc**:
1. Thêm self-loop vào `TRANSITIONS.CART` trong `stateMachine.js`: `ADD_TO_CART: 'CART'` (giữ nguyên state, chỉ dùng để hợp lệ hóa transition, không đổi state).
2. Cập nhật bảng `valid` transitions tương ứng trong `stateMachine.test.js` để bảo toàn coverage đầy đủ transition mới.
3. Thêm test case mới trong `orderService.test.js`: gọi `add_item` ít nhất 2 lần với 2 sản phẩm khác nhau (`p1`, rồi `p2`), xác nhận cả 2 đều nằm trong `cart` sau khi checkout. Thêm thêm 1 case gọi `add_item` 2 lần với **cùng** `productId` để xác nhận nhánh `existing.quantity += quantity` (đang là dead code do bug này) thực sự chạy đúng và cộng dồn số lượng.
4. Chạy lại toàn bộ suite, đảm bảo không phá vỡ transition table hiện có (đặc biệt test "mọi cặp state/event ngoài bảng phải throw" — vì bảng vừa thêm 1 entry mới nên bộ đôi này cũng phải update theo).

## Lỗi 2 (High) — Lock chỉ bảo vệ từng lệnh ghi Sheet riêng lẻ, không bảo vệ toàn bộ chu trình đọc-sửa-ghi của 1 lượt xử lý tin nhắn

**Nguyên nhân**: `LockService.getScriptLock()` hiện chỉ được gọi bên trong từng hàm ghi của Sheet repository (`save`, `updateStatus`, `set`). Trong `orderService.js`, `loadState()` (đọc) và `persistTransition()` (ghi) là 2 bước tách rời không có gì giữ lock xuyên suốt giữa chúng. Nếu 2 request `handleMessage()` cho **cùng một `customerId`** chạy gần như đồng thời (khách bấm nút xác nhận 2 lần liên tiếp, hoặc Zalo/Telegram gửi lại webhook do ack chậm — cả 2 nền tảng đều retry khi timeout), cả hai đều đọc cùng state `CONFIRMING`, cả hai đều tạo `order` riêng và ghi state riêng — dẫn tới 2 đơn hàng trùng lặp cho 1 lần xác nhận, dù mỗi lệnh ghi Sheet đơn lẻ vẫn "thành công" đúng kỹ thuật. Test hiện có (`sheetRepositoryLock.test.js`) chỉ chứng minh lock chặn được 2 lệnh ghi cho 2 **order khác nhau** — không phải kịch bản đáng lo thực sự.

**Fix bắt buộc**:
1. GAS `LockService` chỉ có global script lock (không lock theo key/customer riêng) — chấp nhận đánh đổi: bọc toàn bộ thân `handleMessage()` (từ lúc đọc state đến lúc ghi xong toàn bộ side-effect) trong 1 `LockService.getScriptLock()` duy nhất, ở tầng gọi vào orchestration. Phải quyết định rõ ràng lock nằm ở đâu và ghi vào README, không được để lửng lơ.
   - Khuyến nghị: inject 1 dependency mới `withLock: function(fn) { ... }` vào `createOrderService`, mock đơn giản trong test (chạy `fn()` trực tiếp không lock), còn bản thật ở Phase 2 sẽ implement bằng `LockService.getScriptLock()`. Cách này giữ core vẫn platform-agnostic (không import `LockService` thẳng vào `orderService.js`) đúng nguyên tắc Phase 1, đồng thời cho phép test giả lập race condition ở tầng core.
2. Chấp nhận việc này serialize toàn bộ traffic của bot (không chỉ theo customer) — với quy mô khách hàng nhỏ lẻ hiện tại là đánh đổi hợp lý, ghi rõ lý do vào README để Phase 4 (hardening) biết đây là điểm cần re-visit nếu traffic tăng.
3. Viết test mới đúng kịch bản: mô phỏng 2 lệnh `handleMessage()` gọi "đồng thời" (interleave) cho **cùng một `customerId`** ở action `confirm_order`, xác nhận: chỉ 1 order được tạo, hoặc lệnh thứ 2 bị từ chối/lock rõ ràng — không được phép tạo ra 2 order trùng lặp trong bất kỳ trường hợp nào.

## Ghi chú thêm (không bắt buộc fix ngay, ghi vào backlog Phase 2)

- `getOrCreateCustomer` có race tương tự nếu 2 tin nhắn đầu tiên của cùng 1 khách mới đến đồng thời (có thể tạo 2 `customerId` trùng lặp cho cùng 1 người) — sẽ tự hết nếu áp dụng đúng fix Lỗi 2 ở scope đủ rộng (bọc quanh toàn bộ `handleMessage`, bao gồm cả đoạn `getOrCreateCustomer`).
- Chưa có idempotency key (`messageId`/`update_id`) để bỏ qua webhook bị gửi lại — cần làm ở Phase 2 khi có adapter thật, không phải việc của Phase 1.

## Acceptance criteria để coi là fix xong

1. `npm test` pass toàn bộ, bao gồm 2 test mới (multi-item cart, concurrent confirm cho cùng customer).
2. `npm run check:boundaries` vẫn pass — core vẫn không được import `LockService`/`SpreadsheetApp`/`UrlFetchApp` trực tiếp, chỉ nhận qua dependency injection.
3. Chạy lại đúng script tái hiện bug đã dùng ở review (gọi `add_item` 2 lần liên tiếp với 2 sản phẩm khác nhau) — phải chạy thành công, không throw.
4. README cập nhật đoạn giải thích vị trí đặt lock và lý do đánh đổi serialize toàn bộ traffic.
