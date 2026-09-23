# Prompt cho dev — Fix triệt để lỗi review Phase 2 (Telegram adapter)

Dán nguyên văn cho dev. Đây là fix bắt buộc trước khi Phase 2 được coi là "done".

---

## Bối cảnh

Code review Phase 2 (`mapInboundMessage.js`, `renderOutboundMessage.js`, `TelegramClient.gs`, `TelegramRuntime.gs`, `webhook.gs`) đã pass 31/31 test và boundary check. Phần mapping/rendering/repository làm đúng. Nhưng có 1 lỗi High đã được tái hiện bằng script chạy thực tế (không phải suy đoán), liên quan trực tiếp đến việc khách hàng có thể bị "bỏ rơi" giữa chừng khi xác nhận đơn/thanh toán — nghiêm trọng vì đây là bot xử lý tiền.

## Lỗi (High) — Đánh dấu "đã xử lý" và ghi nghiệp vụ commit trước khi biết tin nhắn có gửi được cho khách hay không

**Nguyên nhân**: Trong `webhook.gs`, hàm `doPost`, toàn bộ trình tự sau đều nằm **bên trong** `dependencies.withLock(...)` và commit xong trước khi hàm lock trả về:
1. `processedUpdateRepository.markProcessed(updateId, ...)` — đánh dấu update này đã xử lý.
2. `orderService.handleMessage(inbound)` — đây là nơi tạo `order` thật và ghi vào Sheet (ví dụ khi action là `confirm_order`).

Sau khi `withLock` trả về, code mới **ở ngoài** lock chạy `transaction.commands.forEach(command => client.execute(command))` để thực sự gửi tin nhắn (bao gồm QR thanh toán) cho khách qua Telegram Bot API.

Vấn đề: nếu bước gửi tin (`client.execute`) thất bại (Telegram tạm thời lỗi, mất mạng, rate limit...), đơn hàng **đã được lưu thật** và `update_id` **đã được đánh dấu processed** từ trước đó rồi. Khách hàng không nhận được bất kỳ tin nhắn nào (không thấy "Order confirmed", không thấy QR để chuyển khoản), nhưng đơn hàng với nghĩa vụ thanh toán đã tồn tại trong hệ thống. Vì webhook luôn trả `200 OK` cho Telegram (kể cả khi lỗi), Telegram sẽ không tự gửi lại update. Nếu khách bấm "Xác nhận" lại lần nữa (tưởng lần trước chưa thành công), state đã chuyển `AWAITING_PAYMENT` nên lần bấm sau sẽ throw lỗi transition — lỗi này chỉ được ghi vào `ErrorLogs` sheet nội bộ, khách vẫn chỉ thấy im lặng, không có cách tự phục hồi.

Đã tái hiện bằng script: ép `UrlFetchApp.fetch` trả lỗi 500 khi xử lý `confirm_order` — kết quả `orderSaved: true`, `update_id` đã mark processed, nhưng 0 tin nhắn đến tay khách, và mọi lần bấm lại sau đó đều thất bại âm thầm.

**Fix bắt buộc**:

1. **Tách rõ 2 khái niệm** trong thiết kế: "đã nhận update" (chặn xử lý trùng — giữ nguyên, đánh dấu sớm là đúng) và "đã xử lý xong nghiệp vụ + đã gửi tin thành công cho khách" (hiện chưa được theo dõi riêng). Thêm 1 cột trạng thái vào `ProcessedUpdates` (ví dụ `deliveryStatus`: `pending` / `delivered` / `failed`), cập nhật trạng thái này sau khi `client.execute` chạy xong (thành công hay thất bại), để có dữ liệu biết chính xác update nào bị "treo" giữa chừng.

2. **Khi `client.execute` thất bại cho bất kỳ command nào**, bắt buộc phải cố gắng gửi 1 tin nhắn fallback đơn giản cho khách trước khi bỏ cuộc — ví dụ: `sendMessage` với nội dung dạng "Đã có lỗi khi xử lý yêu cầu, vui lòng thử lại hoặc liên hệ [số điện thoại/nhân viên]". Việc gửi fallback này phải nằm trong 1 khối try/catch riêng, không phụ thuộc vào các command đã thất bại trước đó, và không được throw ra ngoài làm hỏng luồng trả response cho Telegram.

3. **Với action `confirm_order` cụ thể**: vì đây là hành động tạo nghĩa vụ tài chính, cân nhắc thêm bước: nếu `client.execute` cho command `sendPhoto` (QR) thất bại, phải có cách để nhân viên tự thủ công gửi lại QR cho khách mà không cần khách phải thao tác lại từ đầu (không được bắt khách bấm "Xác nhận" lại vì state đã đổi, event `CONFIRM_ORDER` không lặp lại được). Đề xuất đơn giản: log đủ thông tin (`orderId`, `chatId`, QR URL) vào `ErrorLogs` để nhân viên xử lý thủ công, HOẶC thêm 1 hàm vận hành (`resendPaymentQr(orderId)`) mà nhân viên có thể gọi tay từ Apps Script editor để gửi lại QR cho đúng `chatId` đã lưu trong `Customer`/`Order`. Chọn phương án nào tuỳ độ ưu tiên, nhưng phải chọn 1 trong 2, không được để nguyên hiện trạng "chỉ ghi log, không ai làm gì được".

4. **Viết test mới đúng kịch bản đã tái hiện**: mô phỏng `client.execute` (hoặc `UrlFetchApp.fetch`) thất bại ngay sau khi `confirm_order` đã lưu order thành công — xác nhận: (a) tin nhắn fallback báo lỗi được gửi cho khách (hoặc cơ chế phục hồi khác được kích hoạt tuỳ phương án chọn ở bước 3), (b) `ErrorLogs` ghi nhận đủ thông tin để truy vết, (c) không có cách nào để lần bấm/gửi tiếp theo của khách âm thầm thất bại mà không có phản hồi nào.

## Ghi chú thêm (không bắt buộc, nhưng nên làm cùng đợt vì liên quan)

- `answerCallback` hiện được gọi kể cả khi update là duplicate — vô hại, không cần sửa trừ khi tiện tay dọn cùng lúc.
- Khi sửa xong, review lại toàn bộ các action khác (`catalog`, `add_item`, `checkout`, `cancel`) xem có action nào khác cũng tạo side-effect quan trọng (đổi state, ghi order) mà nếu gửi tin thất bại thì khách cũng bị "mất dấu" tương tự `confirm_order` không — nếu có, áp dụng cùng cơ chế fallback.

## Acceptance criteria để coi là fix xong

1. `npm test` pass toàn bộ, bao gồm test mới mô phỏng gửi tin thất bại sau khi order đã lưu.
2. `npm run check:boundaries` vẫn pass — không đổi gì trong `src/core`.
3. Chạy lại đúng kịch bản tái hiện ở review (ép `UrlFetchApp.fetch` trả 500 khi xử lý `confirm_order`): phải thấy rõ có tín hiệu cho khách (tin nhắn fallback) hoặc cơ chế phục hồi vận hành được kích hoạt — không còn tình trạng "im lặng hoàn toàn, chỉ ghi log nội bộ".
4. README cập nhật mục giải thích cơ chế xử lý khi gửi tin thất bại sau khi nghiệp vụ đã commit, để Phase 5 (Zalo adapter) áp dụng đúng pattern tương tự.
