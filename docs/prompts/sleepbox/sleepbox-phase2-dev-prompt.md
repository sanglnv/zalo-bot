# Prompt cho dev / AI coding agent — Sleepbox Phase 2: Wire vào Telegram webhook

Dán nguyên văn cho dev khi bắt đầu implement. Sleepbox Phase 1 (`bookingService.js` + Sheet-backed
repos) đã done và qua review — không sửa file trong `src/core/booking*.js` ở phase này trừ khi thật
sự cần (nếu cần, dừng lại báo cáo trước).

## Bối cảnh

Khác với Phase 2 gốc của FnB (`phase2-dev-prompt.md`) — lúc đó phải xây `TelegramClient.gs`,
`mapInboundMessage.js`, `renderOutboundMessage.js`, idempotency (`SheetProcessedUpdateRepository`)
từ đầu. Lần này **toàn bộ hạ tầng Telegram đã có sẵn và đang chạy production** cho FnB
(`src/adapters/telegram/webhook.gs`, `TelegramInboundMapper`, `TelegramOutboundRenderer`,
`SheetProcessedUpdateRepository`). Nhiệm vụ Phase 2 của Sleepbox chỉ là **wire thêm** một service
thứ hai vào đúng hạ tầng đó, không xây lại.

Đọc `createDefaultTelegramWebhook()` trong `src/adapters/telegram/webhook.gs` trước khi bắt đầu —
đây là nơi `orderService` được tạo và inject vào `TelegramWebhook.create(...)`.

## Yêu cầu bắt buộc

### 1. Router giữa `orderService` và `bookingService`

`webhook.gs`'s `doPost` hiện gọi thẳng `dependencies.orderService.handleMessage(inbound)`. Cần đổi
thành gọi qua 1 router quyết định service nào xử lý message này, dựa trên:

- Action mới `/phong` (map trong `actionOf`-style dictionary, xem cách `orderService.js`'s
  `vietnameseCommands` đang làm) → luôn định tuyến sang `bookingService`, bất kể trạng thái hiện tại.
- Nếu `conversationState.contextData.activeFlow === 'booking'` (đã set từ trước, đang mid-flow) →
  định tuyến sang `bookingService` cho MỌI message tiếp theo, kể cả message không phải `/phong`
  (giống cách `profileStep` đang chặn message khác trong `orderService.js`).
- Ngược lại (mặc định, hoặc `activeFlow === 'order'`) → giữ nguyên định tuyến sang `orderService`
  như hiện tại.

`activeFlow` đọc/ghi qua `conversationStateRepository` dùng chung (đã quyết định ở Phase 1 — xem
`docs/sleepbox-booking-plan.md`, mục "Phương án A"). `bookingService.js` chịu trách nhiệm set
`activeFlow = 'booking'` khi bắt đầu, và set lại `null` khi booking flow kết thúc (xác nhận xong hoặc
huỷ) — `webhook.gs` chỉ ĐỌC field này để định tuyến, không tự ý set.

Implement router này ở đâu: 1 hàm nhỏ trong `webhook.gs` (hoặc file mới
`src/adapters/telegram/routeToService.js` nếu muốn tách ra test riêng, khuyến khích tách vì dễ unit
test hơn) — input: `conversationStateRepository`, `inbound message`, output: chọn `orderService` hay
`bookingService`.

### 2. Xung đột: khách đang có 1 flow dở dang, gõ lệnh của flow kia

- Đang đặt món dở (`activeFlow` ngầm định là order khi có `pendingOrder`/`currentState !== IDLE`) mà
  gõ `/phong` → **không tự động chuyển**, trả lời nhắc: "Bạn đang đặt món dở, gõ /huydon để huỷ hoặc
  hoàn tất đơn trước khi đặt phòng." (tái dùng đúng tinh thần `pendingOrderResponse()` đã có).
- Đang đặt phòng dở (`activeFlow === 'booking'`) mà gõ lệnh đặt món (`/danhmuc`...) → tương tự, nhắc
  hoàn tất/huỷ booking trước.
- Quyết định chính xác text/logic này thuộc về `bookingService.js`/`orderService.js` (core, platform
  neutral) chứ không phải `webhook.gs` — router ở `webhook.gs` chỉ định tuyến đúng service, phần
  service tự trả lời nhắc nhở là logic nghiệp vụ, phải có test ở core layer (bổ sung test vào
  `bookingService.test.js` nếu Phase 1 chưa cover đủ case này).

### 3. Callback data cho booking flow

Theo đúng giới hạn 64 byte của Telegram `callback_data` đã áp dụng cho FnB (xem
`phase2-dev-prompt.md`, mục 2) — dùng format compact tương tự, ví dụ:
`select_unit:hourly`, `select_room:<roomId>`, `confirm_booking`, `cancel_booking`. Thêm case decode
tương ứng vào `TelegramInboundMapper`/`mapInboundMessage.js` hiện có (mở rộng, không viết file mới
trùng lặp).

### 4. `createDefaultTelegramWebhook()` — thêm `bookingService`

```js
var bookingService = BookingService.create({
  bookingRepository: SheetBookingRepository(),
  roomRepository: SheetRoomRepository(),
  customerRepository: SheetCustomerRepository(),      // dùng chung với orderService
  conversationStateRepository: SheetConversationStateRepository(), // dùng chung
  memberRepository: MemberRepository(),                // dùng chung
  createId: TelegramRuntime.createId,
  now: function () { return new Date(); },
  withLock: SheetRepositorySupport.withScriptLock
});
```

Rồi truyền cả `orderService` lẫn `bookingService` vào `TelegramWebhook.create({...})`, đổi
`dependencies.orderService.handleMessage(inbound)` trong `doPost` thành gọi qua router ở mục 1.

**Lưu ý**: đây chính xác là lỗi đã gặp và fix ở phần member/loyalty — `memberRepository` phải được
truyền thật vào constructor, không chỉ khai báo trong test. Kiểm tra kỹ trước khi coi phase này done.

### 5. Ops notification cho booking mới xác nhận

`doPost` hiện có block gọi `OperationsNotifier.notifyStaffOfNewOrder(...)` khi
`transaction.confirmedOrderSummary` tồn tại. Cần tương tự cho booking: `bookingService.handleMessage`
trả về outbound text có field `bookingId`/`amount`/... (giống cách `confirm_order` đã làm ở
`orderService.js`), `webhook.gs` extract ra thành `confirmedBookingSummary` (hàm riêng, song song với
`confirmedOrderSummary`), rồi gọi hàm mới `OperationsNotifier.notifyStaffOfNewBooking(...)` — **viết
ở Phase 3** (đã có phase riêng cho phần thanh toán/ops-notify để tách nhỏ PR), Phase 2 chỉ cần đảm
bảo `bookingId`/thông tin cần thiết đã có mặt trong outbound message, chưa cần gọi Notifier thật.

## Deliverable & acceptance criteria

1. `npm run check` pass toàn bộ, không phá vỡ test hiện có của `orderService`/`telegram/webhook`.
2. Test mới cho router (mục 1): xác nhận `/phong` → `bookingService`, message thường khi
   `activeFlow==='booking'` → `bookingService`, mặc định → `orderService`.
3. Test xung đột (mục 2): đang có `pendingOrder` mà gõ `/phong` → nhận đúng câu nhắc, không chuyển
   flow; đang `activeFlow==='booking'` mà gõ `/danhmuc` → tương tự.
4. Test end-to-end giả lập (mock repos, không cần Telegram thật): `/phong` → chọn giờ/đêm → chọn slot
   → chọn phòng → xác nhận → nhận đúng trạng thái `AWAITING_PAYMENT`, `activeFlow` reset về `null`
   sau khi xác nhận xong.
5. Deploy thử + test tay thật trên Telegram (dùng tài khoản **không** nằm trong
   `TELEGRAM_ADMIN_USER_IDS`, tránh vướng Fast Path — xem
   `docs/bot-order-webhook-integration.md`'s "Testing note") trước khi coi phase này done.
