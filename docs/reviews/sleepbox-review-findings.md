# Review: Sleepbox Phase 1–6 (as implemented, uncommitted)

Review dựa trên code thật trong working tree (`git diff`/file mới), không chỉ dựa vào báo cáo của
dev. `npm run check` hiện tại: **224/224 tests pass**, boundary check sạch — nhưng có 1 bug
**CRITICAL** không bị test bắt được (giải thích bên dưới) và 1 bug **HIGH** cũng vậy. Cả hai đều
thuộc loại "test pass nhưng production wiring sai" — cùng loại lỗi đã gặp với `memberRepository`
trước đây trong session này.

## 🔴 CRITICAL — Telegram bot sẽ chết hoàn toàn nếu deploy nguyên trạng

**File**: `src/adapters/telegram/webhook.gs`, `createDefaultTelegramWebhook()`.

Khi refactor để tách `customerRepository`/`conversationStateRepository`/`memberRepository` dùng
chung giữa `orderService` và `bookingService` (Phase 2), dòng `createQrContent:
TelegramRuntime.createPaymentQrUrl` đã bị **xoá mất** khỏi `OrderService.create({...})` cho
`orderService` (vẫn còn `createId`, nhưng thiếu hẳn `createQrContent`). `bookingService` bên cạnh có
`createQrContent` đầy đủ — chỉ `orderService` bị sót.

`OrderService.create()` (`src/core/orderService.js:91`) coi `createQrContent` là dependency **bắt
buộc**, throw `TypeError` ngay tại thời điểm khởi tạo nếu thiếu. Đã verify trực tiếp bằng cách gọi
thật `createDefaultTelegramWebhook()` (mock đủ GAS globals):

```
CONFIRMED CRASH: TypeError: createQrContent must be a function
```

`createDefaultTelegramWebhook()` được gọi lazy trong `doTelegramPostWithoutMetrics` — nghĩa là **mọi
request webhook Telegram đầu tiên** sẽ throw ngay khi khởi tạo, bị outer catch bắt lại
(`stage: 'webhook_initialization'`), log vào `ErrorLogs`, và trả về `"OK"` (text thuần) **cho
Telegram**, không phải gửi tin nhắn nào cho khách. Vì `telegramWebhookInstance` construct thất bại,
không có `client`/`chat_id` nào để gửi fallback message — khách sẽ **không nhận được bất kỳ phản hồi
nào** (không phải "Đã có lỗi..." fallback thông thường — mà là im lặng hoàn toàn). Cả đặt món (FnB)
lẫn đặt phòng đều bị ảnh hưởng như nhau vì cùng 1 hàm khởi tạo.

**Vì sao 224/224 test không bắt được**: không có test nào gọi `createDefaultTelegramWebhook()` thật —
`telegram/webhook.test.js` tự dựng `OrderService.create({...})` với fixture riêng (có
`createQrContent` đầy đủ trong mock), nên bug này hoàn toàn nằm ngoài vùng phủ của test suite. Đây
đúng là lớp lỗi đã note trong `sleepbox-phase6-dev-prompt.md` mục 5 ("test pass không đồng nghĩa
production đúng") — tiếc là chính sleepbox lại mắc lại đúng lỗi đó.

**Fix bắt buộc trước khi push bất cứ thứ gì**: thêm lại `createQrContent:
TelegramRuntime.createPaymentQrUrl` vào `orderService`'s `OrderService.create({...})` trong
`createDefaultTelegramWebhook()`. Sau khi fix, nên thêm 1 test gọi thẳng
`createDefaultTelegramWebhook()`/`createDefaultZaloWebhook()` (mock GAS globals tối thiểu) chỉ để xác
nhận nó **construct được không throw** — đây là loại "smoke test" đã thiếu cho cả 2 file webhook từ
trước tới giờ, không riêng gì sleepbox.

## 🟠 HIGH — Đặt phòng ngay sau khi vừa hoàn tất 1 đơn đồ ăn (`PAID`) sẽ crash

**File**: `src/core/bookingService.js`, `loadState()`.

`bookingService`/`orderService` dùng **chung 1 dòng** `ConversationState` theo `customerId`
(quyết định kiến trúc đã chốt — Phương án A). Vấn đề: cả 2 state machine đều dùng chung tên state
`IDLE`/`PAID`/`DONE`/`CANCELLED`/`EXPIRED` (trùng literal string). `bookingService.loadState()` kiểm
tra `Object.prototype.hasOwnProperty.call(sm.States, state.currentState)` để quyết định "state hiện
tại có phải state hợp lệ của booking không" — nhưng vì `'PAID'` (và `DONE`/`CANCELLED`/`EXPIRED`/
`IDLE`) là tên chung, `hasOwnProperty` trả `true` ngay cả khi state đó thực ra là do `orderService`
để lại sau khi 1 đơn đồ ăn được thanh toán xong. `bookingService` hiểu nhầm đây là state `PAID` của
chính nó, và `contextData` đi kèm (cart/orderId/bill của đơn ăn) bị coi là context của booking.

Verify trực tiếp:

```js
// state để lại từ orderService sau khi 1 đơn PAID xong
state = { currentState: 'PAID', contextData: { orderId: 'HD1', activeFlow: 'order' }, ... };
service.handleMessage({ text: '/phong', ... });
// → THREW: Invalid booking transition: PAID --START_NEW_BOOKING--> ?
```

Lý do: `BookingStateMachine`'s `PAID` chỉ cho phép event `COMPLETE` (`PAID → DONE`), không cho phép
`START_NEW_BOOKING` như `OrderStateMachine`'s `PAID` cho phép (`PAID → BROWSING`). Guard chặn xung
đột (`terminalOrderStates`) đã đúng khi *cho phép* bắt đầu booking lúc order đã `PAID`/`DONE`/
`CANCELLED`/`EXPIRED` (đúng ý đồ thiết kế) — nhưng bug nằm ở bước SAU đó, khi `loadState()` đọc nhầm
state cũ thay vì coi đây là 1 phiên booking hoàn toàn mới (`IDLE`).

**Không có test nào cover case này** — `bookingService.test.js`'s test xung đột duy nhất dùng
`currentState: 'CART'` (không terminal, đúng là bị chặn) và test happy-path dùng `state = null`
(khách hoàn toàn mới). Trường hợp "khách cũ, đơn ăn gần nhất đã `PAID`, giờ gõ `/phong`" — kịch bản
rất phổ biến trong thực tế — chưa từng được test.

**Fix đề xuất**: `loadState()` không nên chỉ check tên state trùng khớp — nên check thêm
`state.contextData.activeFlow === 'booking'` trước khi coi state hiện có là state hợp lệ của booking;
nếu `activeFlow !== 'booking'` (kể cả khi tên state trùng ngẫu nhiên), luôn coi là khách mới đối với
domain booking (`IDLE`, `contextData: {}`). Cách này nhất quán với cách `orderService.js`'s
`profileGateResponse` đã dùng field phụ (`profileStep`) thay vì suy diễn từ tên state dùng chung.

## Phase 1 — Core domain layer

Domain model, state machine (exhaustive transition-matrix test — tốt hơn cả FnB gốc), billing
(`Math.round` ngay từ đầu, đúng yêu cầu), `findAvailableRooms` (test đủ case biên: chạm ranh giới,
containment, status không chặn) đều đạt yêu cầu prompt. Sheet repos (`SheetRoomRepository`,
`SheetBookingRepository`) đúng convention, `SystemSetup.gs` đã thêm 2 sheet mới đúng vị trí.
`repositoryContracts.js` đã thêm `room`/`booking` contract.

Vấn đề duy nhất: bug HIGH ở trên (`loadState()`), nằm ở đúng file `bookingService.js` được giao cho
phase này.

**Đánh giá: Đạt phần lớn, có 1 bug HIGH cần fix trước khi merge.**

## Phase 2 — Wire Telegram

Router (`src/adapters/routeToService.js`) viết tách riêng, platform-neutral (đúng khuyến nghị "tách
ra ngay nếu chưa tách" — thực ra dev tách đúng từ đầu, không cần đợi Phase 4 mới tách). Test router
(`telegram/routeToService.test.js`) cover đủ 3 case chính (luôn về booking khi `/phong`, giữ booking
khi đang active, mặc định về order). Callback data mở rộng đúng namespace có sẵn, đúng giới hạn 64
byte.

Vấn đề: bug CRITICAL ở trên nằm chính xác trong phần việc của phase này
(`createDefaultTelegramWebhook()`).

**Đánh giá: Router/test tốt, nhưng bug CRITICAL trong wiring khiến phase này KHÔNG thể coi là "hoàn
tất" cho tới khi fix.**

## Phase 3 — Thanh toán

`OperationsNotifier.operationsBookingText`/`notifyStaffOfNewBooking` mirror đúng pattern order, có
test riêng. `BookingQrDispatch.gs` mirror đúng `PaymentQrDispatch.gs` (4 case: success/not_found/
already_resolved/delivery_failed, đủ test). `/thanhtoan` dùng chiến lược fallback thử order trước rồi
booking — đúng cách đã đề xuất khi chưa có tiền tố id phân biệt, có ghi chú rõ trong code lý do và
điều kiện Phase 5 cần xem lại. `isAuthorizedOpsAdmin` check chạy trước, dùng chung cho cả 2 loại —
đúng yêu cầu bảo mật.

**Đánh giá: Đạt yêu cầu, không phát hiện vấn đề.**

## Phase 4 — Wire Zalo

`createDefaultZaloWebhook()` giữ nguyên `createQrContent: ZaloRuntime.createPaymentQrUrl` cho
`orderService` (KHÔNG mắc lỗi giống Telegram) — đã verify bằng diff, Zalo an toàn. Router dùng lại
đúng `routeToService.js` chung, không copy-paste riêng. Callback payload Zalo (`zc:select_unit`,
`zc:select_room`) mở rộng đúng namespace `zc:` có sẵn. Test `zalo/webhook.test.js` cover luồng booking
end-to-end với router thật (không mock router).

**Đánh giá: Đạt yêu cầu, không phát hiện vấn đề. Đây là phần làm tốt nhất trong 4 phase đã code.**

## Phase 5 — Swap sang POS thật

Đúng như báo cáo: **chưa triển khai**, không có file `SleepboxWebhookClient.gs`/tương đương nào được
tạo (verify bằng glob, không match). Không có dấu hiệu đoán field name POS. Đúng tinh thần "dừng lại,
không code khi chưa có contract" đã yêu cầu trong prompt.

**Đánh giá: Đúng trạng thái blocked, không có gì để review thêm cho tới khi có POS contract.**

## Phase 6 — Hardening

Claim "xoá router Telegram trùng lặp, giữ 1 router chung tại `routeToService.js`" — verify đúng
(`grep activeFlow` trong `src/adapters/` chỉ match đúng 1 file). Claim `/thanhtoan` booking dùng chung
`isAuthorizedOpsAdmin`, fail-closed — verify đúng. Claim billing làm tròn ngay — verify đúng (đã kiểm
ở Phase 1).

Vấn đề: review Phase 6 **không phát hiện ra 2 bug CRITICAL/HIGH ở trên** — cả hai đều thuộc loại lỗi
"chỉ lộ ra khi construct/gọi thật với dữ liệu thật", không lộ ra khi chỉ đọc code tĩnh hoặc chạy
`npm run check` (vì test hiện có đều mock ở tầng cao hơn chỗ bug xảy ra). Đây chính là giới hạn của
việc chỉ "review + `npm run check` pass" mà chưa test tay/smoke-test việc khởi tạo thật — đúng điều
mục 5 của `sleepbox-phase6-dev-prompt.md` đã cảnh báo trước, nhưng chưa được thực hiện.

**Đánh giá: Review tĩnh tốt, nhưng KHÔNG đủ để coi là "production-ready" — cần bổ sung smoke test
gọi `createDefaultTelegramWebhook()`/`createDefaultZaloWebhook()` thật trước khi go-live.**

---

## Tổng kết

| Phase | Trạng thái | Ghi chú |
|---|---|---|
| 1 — Core domain | Đạt phần lớn | 1 bug HIGH (`loadState()` đọc nhầm state PAID/DONE/... của order) |
| 2 — Wire Telegram | **Chưa đạt** | 1 bug CRITICAL (thiếu `createQrContent`, sập cả bot Telegram) |
| 3 — Thanh toán | Đạt | Không phát hiện vấn đề |
| 4 — Wire Zalo | Đạt | Làm tốt nhất, Zalo không dính lỗi của Telegram |
| 5 — POS thật | Đúng trạng thái blocked | Chưa code, đúng như báo cáo |
| 6 — Hardening | Review tĩnh đạt, nhưng bỏ sót 2 bug trên | Cần smoke test thật |

**Việc cần làm ngay trước khi push/deploy bất cứ thứ gì** (thứ tự ưu tiên):

1. Thêm lại `createQrContent: TelegramRuntime.createPaymentQrUrl` vào `orderService` trong
   `createDefaultTelegramWebhook()` (`src/adapters/telegram/webhook.gs`). **Không deploy khi chưa
   fix — sẽ sập toàn bộ Telegram bot, kể cả FnB đang chạy production.**
2. Fix `bookingService.js`'s `loadState()` để phân biệt state của booking với state trùng tên để lại
   từ order (dùng `contextData.activeFlow` làm tín hiệu, không chỉ tên state).
3. Thêm smoke test cho cả `createDefaultTelegramWebhook()` và `createDefaultZaloWebhook()` (construct
   thật, mock tối thiểu GAS globals) — để lớp lỗi này không tái diễn ở tính năng tiếp theo.
4. Thêm test cho case "khách cũ, order gần nhất `PAID`/`DONE`/`CANCELLED`/`EXPIRED`, gõ `/phong`" vào
   `bookingService.test.js`.
5. Sau khi fix 1-2 và có test 3-4 pass, chạy lại `npm run check`, rồi mới tiếp tục checklist go-live ở
   `sleepbox-phase6-dev-prompt.md`.

Không có vấn đề nào ở Phase 3/4/5 cần sửa — có thể merge cùng đợt với fix của Phase 1/2.
