# Prompt cho dev / AI coding agent — Sleepbox Phase 1: Core domain layer (platform-agnostic)

Dán nguyên văn phần dưới đây cho dev hoặc Claude Code khi bắt đầu implement.

---

## Bối cảnh

Đang thêm tính năng đặt phòng sleepbox vào bot đặt món đồ ăn hiện có (Telegram + Zalo, chạy trên
Google Apps Script). Xem `docs/sleepbox-booking-plan.md` để biết toàn bộ bối cảnh/quyết định kiến
trúc đã chốt — đọc file đó trước khi bắt đầu.

Quyết định quan trọng nhất: **booking là một domain riêng, tách khỏi `core/orderService.js`**
(state machine đặt món không mô hình hoá đúng luồng chọn giờ/đêm + chọn phòng). Nhưng vẫn dùng chung
`customerRepository`/`memberRepository` đã có sẵn — 1 khách hàng có 1 hồ sơ tên/SĐT/điểm thành viên
cho cả đặt món lẫn đặt phòng.

**Quan trọng — làm theo đúng lịch sử của chính repo này**: khi FnB bot được xây lần đầu (xem
`phase1-dev-prompt.md` ở root), core layer được viết xong và test đầy đủ TRƯỚC KHI có backend POS
thật — ban đầu dùng Sheet làm datastore, mãi sau này (`docs/bot-order-webhook-integration.md`) mới
thay bằng POS webhook thật. Sleepbox nên đi đúng lộ trình đó: Phase 1-4 dùng Sheet-backed repository
tạm thời để không bị block bởi việc chờ POS expose API sleepbox; Phase 5 mới swap sang POS thật (xem
`sleepbox-phase5-dev-prompt.md`). Nhờ vậy dev có thể bắt đầu ngay, không cần đợi trả lời từ bên POS.

## Yêu cầu bắt buộc

### 1. Domain model (thêm vào `src/core/domain.js` hoặc file mới `src/core/bookingDomain.js`)

```
Room { roomId, name, roomType, pricePerHour, pricePerNight, isAvailable }
Booking {
  bookingId, customerId, memberId,
  roomId, unit: 'hourly' | 'nightly',
  startAt (ISO string),
  durationHours (number, chỉ khi unit === 'hourly'),
  nights (number, chỉ khi unit === 'nightly'),
  status: 'AWAITING_PAYMENT' | 'PAID' | 'CANCELLED' | 'EXPIRED' | 'DONE',
  totalAmount, createdAt, updatedAt
}
```

Đặt tên field nhất quán với `Order`/`OrderItem` đã có (`totalAmount`, `createdAt`, `updatedAt`, status
string y hệt cách `Order.status` đang dùng) để `OperationsNotifier`/`PaymentQrDispatch` sau này dễ
tái dùng logic chung.

### 2. State machine cho booking (`src/core/bookingStateMachine.js`, pure functions, không side-effect)

```
IDLE → SELECTING_UNIT → SELECTING_SLOT → SELECTING_ROOM → CONFIRMING → AWAITING_PAYMENT → PAID → DONE
                                                                                          ↘ CANCELLED
                                                                              ↘ EXPIRED (timeout chưa thanh toán)
```

Viết test cho toàn bộ transition hợp lệ VÀ không hợp lệ, throw lỗi rõ ràng khi sai — đúng convention
đã dùng ở `src/core/stateMachine.js` (đọc file đó làm mẫu, copy style, không copy state list).

### 3. Billing cho booking (`src/core/bookingBilling.js` hoặc thêm hàm vào `billing.js` hiện có)

`calculateBookingBill(room, unit, durationHoursOrNights)` → `{ subtotal, totalAmount }`. Làm tròn
`totalAmount` bằng `Math.round` ngay từ đầu (đã có bài học từ `billing.js`'s Medium #1 fix — xem
`git log` commit "code fix" nếu cần đối chiếu, đừng lặp lại lỗi làm tròn tương tự).

### 4. Repository pattern — Sheet-backed tạm thời

```
RoomRepository { list(), findById(roomId) }
BookingRepository {
  save(booking), findById(bookingId), findByCustomerId(customerId),
  updateStatus(bookingId, status),
  findOverlapping(roomId, startAt, endAt)   -- để check trùng lịch, xem mục 5
}
```

Implement `SheetRoomRepository.gs` + `SheetBookingRepository.gs` theo đúng convention của
`src/repositories/SheetCustomerRepository.gs`/`SheetOrderRepository.gs` (dùng chung
`SheetRepositorySupport.gs`'s `withScriptLock`, cùng cách đọc/ghi header row). Thêm định nghĩa 2
sheet mới (`Rooms`, `Bookings`) vào `src/admin/SystemSetup.gs`'s `SHEETS` list, seed vài phòng mẫu
thủ công qua Apps Script editor để test (không cần UI quản lý phòng ở phase này).

### 5. Availability check (tự tính, không phụ thuộc POS ở phase này)

`findAvailableRooms(rooms, bookings, startAt, endAt)` — pure function: loại các phòng có booking
`status IN (AWAITING_PAYMENT, PAID)` chồng lấn khoảng `[startAt, endAt)`. Viết test riêng cho hàm
này với các case biên (chạm ranh giới, bao trùm, nằm trong). Đây chính là logic sẽ **giữ nguyên**
khi Phase 5 swap sang POS thật, trừ khi POS tự làm availability check phía họ (câu hỏi đã liệt kê
trong `docs/sleepbox-booking-plan.md` — Phase 5 sẽ quyết định lại lúc đó).

### 6. `bookingService.js` orchestration (`src/core/bookingService.js`)

Cùng shape với `orderService.js`: `BookingService.create(dependencies)` trả về
`{ handleMessage(InboundMessage): OutboundMessage[] }`. Dependencies: `bookingRepository`,
`roomRepository`, `customerRepository`, `conversationStateRepository`, `memberRepository` (optional,
giống `orderService.js`), `now`, `createId`, `withLock`.

**Không tự viết lại profile gate (hỏi tên/SĐT)** — dependency injection nhận `customerRepository`
dùng chung với `orderService.js`, khách đã có tên/SĐT rồi thì `bookingService` không hỏi lại. Nếu
khách chưa có (trường hợp vào thẳng `/phong` mà chưa từng `/danhmuc`), tạm thời **chấp nhận bỏ qua
profile gate ở phase này** (ghi rõ trong code TODO) — việc hợp nhất gate dùng chung giữa 2 service sẽ
làm ở Phase 2 khi wire vào `webhook.gs` thật (lúc đó có đủ ngữ cảnh routing để quyết định gọi gate ở
đâu một lần, tránh trùng lặp logic).

## Cấu trúc thư mục

```
/src
  /core
    bookingDomain.js         // hoặc thêm vào domain.js
    bookingStateMachine.js
    bookingBilling.js        // hoặc thêm hàm vào billing.js
    bookingService.js
  /repositories
    SheetRoomRepository.gs
    SheetBookingRepository.gs
  /tests
    bookingStateMachine.test.js
    bookingBilling.test.js
    bookingService.test.js
    sheetRoomRepository.test.js
    sheetBookingRepository.test.js
```

## Deliverable & acceptance criteria

1. `src/core/booking*.js` không reference `Telegram`, `Zalo`, `SpreadsheetApp`, `UrlFetchApp` (chạy
   `npm run check:boundaries` — cần thêm pattern booking files vào `scripts/check-core-boundaries.js`
   nếu script đó hiện chỉ quét `src/core/*.js` theo glob, xác nhận lại glob đã cover file mới).
2. Unit test cho `bookingStateMachine.js`, `bookingBilling.js`, `findAvailableRooms` chạy pass, cover
   cả nhánh hợp lệ và lỗi.
3. `bookingService.handleMessage()` nhận 1 `InboundMessage` giả lập (mock repos, không cần webhook
   thật) và trả đúng `OutboundMessage[]` cho luồng: chọn loại hình (giờ/đêm) → chọn slot → xem phòng
   trống → chọn phòng → xác nhận → nhận trạng thái `AWAITING_PAYMENT`.
4. `SheetBookingRepository`/`SheetRoomRepository` có test riêng (giống
   `src/tests/sheetCustomerRepository.test.js`), dùng mock `SpreadsheetApp`/`LockService`.
5. `npm run check` (test + boundary check) pass toàn bộ, không phá vỡ test hiện có của
   `orderService.js`.

Không cần đụng vào `telegram/webhook.gs`/`zalo/webhook.gs` ở phase này — chỉ cần core + Sheet repo
sẵn sàng để Phase 2 cắm vào.
