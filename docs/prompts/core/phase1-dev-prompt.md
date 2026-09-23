# Prompt cho dev / AI coding agent — Phase 1: Core Domain Layer (platform-agnostic)

Dán nguyên văn phần dưới đây cho dev hoặc Claude Code khi bắt đầu implement.

---

## Bối cảnh

Đang xây bot chat để chốt bill/đặt đơn/gửi QR chuyển khoản/xác nhận thanh toán (thủ công, không auto-reconcile). Bot sẽ chạy trên 2 nền tảng: Telegram (build & test trước, miễn phí) và Zalo OA (production chính, thêm sau). Runtime là Google Apps Script (GAS), datastore ban đầu là Google Sheet.

Đây là Phase 1 trong lộ trình 6 phase — nhiệm vụ duy nhất của phase này là dựng core domain layer **hoàn toàn không phụ thuộc nền tảng chat cụ thể nào**. Phase 2 (Telegram adapter) và Phase 5 (Zalo adapter) sẽ chỉ implement interface do phase này định nghĩa, không được sửa code core. Nếu core layer bị rò rỉ chi tiết của Telegram hoặc Zalo (tên field, format API riêng...) thì coi như phase này thất bại.

## Yêu cầu bắt buộc

### 1. Domain model

Định nghĩa các entity sau (dùng JSDoc hoặc TypeScript-style type comment, GAS chạy JS thuần nên không cần TS thật nhưng phải type-annotate rõ ràng):

- `Customer { customerId, phone, displayName, platformLinks: [{platform, platformUserId}] }` — `customerId` là ID nội bộ, độc lập với `platform`/`platformUserId`, để hợp nhất khách hàng dùng nhiều kênh.
- `Product { productId, name, price, isAvailable }`
- `Order { orderId, customerId, items: [OrderItem], status, totalAmount, createdAt, updatedAt }`
- `OrderItem { productId, name, unitPrice, quantity }`
- `Payment { orderId, qrContent, amount, status, confirmedAt, confirmedBy }`
- `ConversationState { customerId, currentState, contextData, updatedAt }`

### 2. State machine

Implement như một module thuần (pure functions, không side-effect, không gọi GAS service nào):

```
IDLE → BROWSING → CART → CONFIRMING → AWAITING_PAYMENT → PAID → DONE
                                                        ↘ CANCELLED
                                            ↘ EXPIRED (timeout chưa thanh toán)
```

Yêu cầu: mỗi transition là 1 hàm nhận `(currentState, event, contextData) → { nextState, newContextData }`. Phải viết test cho toàn bộ transition hợp lệ VÀ các transition không hợp lệ (ví dụ không thể từ `IDLE` nhảy thẳng vào `AWAITING_PAYMENT`) — hàm phải throw lỗi rõ ràng khi gặp transition sai, không được im lặng bỏ qua.

### 3. Interface message chuẩn hóa (contract giữa core và adapter)

```
InboundMessage {
  platform: 'telegram' | 'zalo',
  platformUserId: string,
  text: string,
  payload: object | null   // dữ liệu structured nếu có (vd bấm nút chọn món)
}

OutboundMessage {
  type: 'text' | 'list' | 'button' | 'image',
  content: object          // shape khác nhau tùy type, core không quan tâm platform sẽ render thế nào
}
```

Core chỉ nhận `InboundMessage` và trả về mảng `OutboundMessage[]`. Core **không được import** bất kỳ thứ gì liên quan Telegram API hay Zalo API.

### 4. Repository pattern cho storage

Định nghĩa interface trừu tượng (ví dụ dùng object literal với các hàm bắt buộc implement):

```
OrderRepository {
  save(order), findById(orderId), findByCustomerId(customerId), updateStatus(orderId, status)
}
CustomerRepository { save(customer), findById(customerId), findByPlatformUserId(platform, platformUserId) }
ConversationStateRepository { get(customerId), set(customerId, state) }
```

Phase 1 chỉ cần implement 1 bản dựa trên Google Sheet (`SheetOrderRepository` v.v.), nhưng toàn bộ phần còn lại của code (business logic) chỉ được gọi qua interface này — không gọi thẳng `SpreadsheetApp` ở bất kỳ đâu ngoài các file `*Repository.gs`.

### 5. Ràng buộc riêng của GAS cần tuân thủ

- Mọi hàm ghi vào Sheet phải bọc trong `LockService.getScriptLock()` để tránh race condition khi 2 request đến cùng lúc.
- Không giả định execution có thể chạy lâu — logic core phải là các bước ngắn, không loop chờ đợi gì cả (không polling trong cùng 1 request).
- Dùng `PropertiesService` cho config (token, API key), không hardcode trong code.

### 6. Testability

Toàn bộ logic tính bill và state machine phải là pure function, viết được unit test chạy ngoài môi trường GAS (Node.js + `clasp`), không phụ thuộc `SpreadsheetApp`/`UrlFetchApp` trực tiếp — các service này chỉ được gọi trong lớp Repository/Adapter, không được gọi trong lớp business logic thuần.

## Cấu trúc thư mục đề xuất

```
/src
  /core
    domain.js          // định nghĩa entity + type annotation
    stateMachine.js     // pure functions transition
    billing.js           // tính tổng bill, áp giảm giá nếu có
    orderService.js      // orchestration: nhận InboundMessage, gọi state machine + repository, trả OutboundMessage[]
  /repositories
    sheetOrderRepository.js
    sheetCustomerRepository.js
    sheetConversationStateRepository.js
  /adapters            // để trống ở Phase 1, Phase 2/5 sẽ điền
  /tests
    stateMachine.test.js
    billing.test.js
```

## Deliverable & acceptance criteria

1. Toàn bộ file trong `/core` không có bất kỳ reference nào tới `Telegram`, `Zalo`, `SpreadsheetApp`, `UrlFetchApp`.
2. Unit test cho `stateMachine.js` và `billing.js` chạy pass, cover cả nhánh hợp lệ và nhánh lỗi.
3. `orderService.js` có thể nhận 1 `InboundMessage` giả lập (mock, không cần adapter thật) và trả về đúng `OutboundMessage[]` mong đợi cho ít nhất các luồng: xem catalog, thêm món vào giỏ, xác nhận đơn, nhận QR thanh toán, huỷ đơn.
4. Chạy thử 2 request ghi đơn đồng thời (giả lập song song) để xác nhận `LockService` chặn được race condition.
5. README ngắn giải thích cách Phase 2 (Telegram adapter) sẽ cắm vào core layer này — chỉ cần implement 1 file adapter gọi `orderService.handleMessage(inboundMessage)`.

Không cần implement Telegram/Zalo adapter thật trong phase này — chỉ cần core sẵn sàng để cắm adapter vào ngay lập tức ở Phase 2.
