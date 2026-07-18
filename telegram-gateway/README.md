# Telegram gateway

Cloudflare Worker này là ingress production bắt buộc giữa Telegram và Google Apps Script:

`Telegram → authenticated Worker → durable Queue → authenticated GAS web app`

Worker kiểm tra `X-Telegram-Bot-Api-Secret-Token`, dừng callback spinner ở edge, ghi update vào Queue trước khi trả `200`, rồi consumer chuyển tiếp tới GAS. Delivery lỗi được retry với backoff và cuối cùng đi vào DLQ. Cron mỗi 5 phút ghi structured error log nếu DLQ có backlog, gọi Telegram `getWebhookInfo`, tự sửa URL drift bằng `setWebhook` mà không xoá pending updates, và probe token Worker→GAS.

Phase 2 có fast path dùng SQLite Durable Object theo từng Telegram chat để xử lý nghiệp vụ và gửi phản hồi ngay tại Worker. Khi `FAST_PATH_ENABLED=true`, tính năng áp dụng cho mọi chat; đặt lại thành `false` để chuyển toàn bộ lưu lượng về Queue → GAS. Xem [runbook Phase 2](../docs/telegram-fast-path-phase2.md).

Phase 3 lưu catalog lớn trong D1 và đẩy snapshot fast path qua Queue để GAS upsert về Sheets mà không chặn phản hồi khách hàng. Xem [runbook Phase 3](../docs/telegram-fast-path-phase3.md).

Phase 4 chuyển xác nhận thanh toán và hết hạn đơn fast path vào đúng Durable Object theo chat. Domain transaction ghi đồng thời snapshot outbox, inventory effect và notification outbox; alarm retry từng side effect cho tới khi hoàn tất. Xem [runbook Phase 4](../docs/telegram-fast-path-phase4.md).

## Local verification

```sh
npm ci
npm run check
```

`npm run check` chạy test Worker runtime, TypeScript, kiểm tra generated bindings và deploy dry-run. Sau khi sửa `wrangler.jsonc`, chạy `npm run cf-typegen` và commit `worker-configuration.d.ts`.

## First deployment

Tạo queue một lần:

```sh
npx wrangler queues create zalo-clawbot-telegram
npx wrangler queues create zalo-clawbot-telegram-dlq
```

Thiết lập chín secret qua prompt tương tác; không đặt giá trị secret trong source hoặc command history:

```sh
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put GAS_WEB_APP_URL
npx wrangler secret put GAS_GATEWAY_TOKEN
npx wrangler secret put TELEGRAM_OPERATIONS_CHAT_ID
npx wrangler secret put TELEGRAM_ADMIN_USER_IDS
npx wrangler secret put VIETQR_BANK_ID
npx wrangler secret put VIETQR_ACCOUNT_NO
npx wrangler secret put VIETQR_ACCOUNT_NAME
```

- `GAS_WEB_APP_URL`: Apps Script production `/exec` URL.
- `TELEGRAM_WEBHOOK_SECRET`: chuỗi ngẫu nhiên 1–256 ký tự chỉ gồm `A-Z`, `a-z`, `0-9`, `_`, `-`; dùng cùng giá trị cho Script Property tương ứng.
- `GAS_GATEWAY_TOKEN`: secret ngẫu nhiên khác, dùng cùng giá trị cho Script Property tương ứng.
- `TELEGRAM_BOT_TOKEN`: token BotFather.
- `TELEGRAM_OPERATIONS_CHAT_ID`: chat nhân viên nhận cảnh báo DLQ và tóm tắt đơn mới từ cả normal path lẫn fast path. Thêm bot vào chat trước khi deploy.
- `TELEGRAM_ADMIN_USER_IDS`: danh sách Telegram **user ID** được phép dùng lệnh quản trị, phân cách bằng dấu phẩy. Lệnh chỉ chạy trong private chat; không dùng group/chat ID cho allowlist này.
- `VIETQR_BANK_ID`, `VIETQR_ACCOUNT_NO`, `VIETQR_ACCOUNT_NAME`: bắt buộc cho fast path — `requireFastPathConfig` trong `fastpath.ts` kiểm tra cả ba cho **mọi** update (không chỉ đơn hàng cần QR), thiếu một trong ba sẽ làm toàn bộ fast path lỗi 503 im lặng với khách. `VIETQR_TEMPLATE`/`VIETQR_TRANSFER_PREFIX` là optional (mặc định `compact2`/`DH`), có thể set bằng `wrangler secret put` nếu cần khác mặc định.

### Lệnh quản trị catalog

Các lệnh chỉ chạy trong private chat của user có ID nằm trong `TELEGRAM_ADMIN_USER_IDS`:

- `/kho` hoặc `/kho CAT_ID`: xem `PRODUCT_ID`, trạng thái bán và tồn hôm nay.
- `/tat PRODUCT_ID` / `/bat PRODUCT_ID`: tắt hoặc mở bán món.
- `/ton PRODUCT_ID SỐ_LƯỢNG`: đặt tồn của ngày hiện tại.
- `/themon`: thêm món theo luồng tên → giá → danh mục → tồn.
- `/suamon PRODUCT_ID`: sửa tên → giá của món hiện có; gửi `-` ở một bước để giữ nguyên giá trị hiện tại.
- `/thanhtoan`: khách dùng trong chat riêng để nhận QR của đơn đang chờ; admin dùng trong group vận hành bằng cách reply thông báo `ĐƠN MỚI`. Admin cũng có thể dùng dạng đầy đủ `/thanhtoan CHAT_ID ORDER_ID`.
- `/quanly`: mở bảng quản trị menu.
- `/huyquanly`: hủy luồng thêm/sửa đang dở.

Flow vận hành đơn Telegram fast path: khách xác nhận → bot giữ tồn và báo group chuẩn bị món → admin reply thông báo đơn bằng `/thanhtoan` → bot gửi QR cho đúng chat khách → nhân viên xác nhận tiền theo quy trình thanh toán hiện có. Lệnh trong group chỉ được chấp nhận khi group trùng `TELEGRAM_OPERATIONS_CHAT_ID` và người gửi nằm trong `TELEGRAM_ADMIN_USER_IDS`.

Lệnh khách hàng: `/batdau`, `/danhmuc`, `/giohang`, `/dathang`, `/xemdon`, `/huydon`, `/trogiup`, `/thanhtoan`. `/start` và các lệnh tiếng Anh cũ được giữ làm alias tương thích, nhưng không còn hiển thị trong hướng dẫn chính.

Khi khách gửi `/batdau` (hoặc alias hệ thống `/start`), Worker chỉ gửi **một** message ảnh `public/welcome-order-flow.png` từ static assets. Caption chào mừng, ba thao tác **Xem danh mục**, **Trạng thái đơn**, **Trợ giúp**, và nút URL **Hướng dẫn dành cho khách hàng** nằm chung dưới ảnh; không gửi thêm message chữ riêng. Trang hướng dẫn public được phục vụ từ `public/huong-dan-khach-hang.html` trên cùng domain Worker, không yêu cầu đăng nhập ChatGPT.

Deploy và lưu URL `workers.dev` được Wrangler trả về:

```sh
npm run check
npm run deploy
```

Đặt URL đó vào GAS Script Property `TELEGRAM_WEBHOOK_URL`, update Apps Script web-app deployment, rồi chạy `registerWebhook(false)` trong Apps Script editor. Không dùng `true` trong rollout thường vì nó xoá pending updates.

## Production verification

1. Chạy GAS `healthCheck()` và xác nhận `telegramWebhook.status === "ok"`, `url === expectedUrl`, `pendingUpdates === 0`, không có lỗi webhook mới.
2. Gửi `/batdau`, `/danhmuc`, thêm sản phẩm và bấm callback trên Telegram. Callback phải hết spinner ngay; bot phải trả lời đúng một lần.
3. Trong Cloudflare Workers Logs, xác nhận `telegram_webhook_healthy`, `gas_gateway_healthy`, rồi xác nhận `telegram_update_queued` và `telegram_update_forwarded` có cùng `updateId` khi test chat.
4. Theo dõi `telegram_dlq_not_empty`; staff chat cũng nhận cảnh báo chủ động. Nếu xuất hiện, tra `updateId` trong logs và xử lý nguyên nhân GAS trước khi replay thủ công; không tạo consumer tự xoá DLQ.
5. Khi fast path được bật, xác nhận snapshot v2 tăng `revision` theo từng customer và mọi `inventory_effects`, `queue_outbox`, `notification_outbox` đều được drain; theo dõi log và dùng `FAST_PATH_ENABLED=false` để rollback toàn bộ nếu cần.

Probe không cần secret:

```sh
curl -i https://YOUR_WORKER.workers.dev
```

Kết quả mong đợi là `405 Method Not Allowed`. POST không có hoặc sai Telegram secret phải trả `401`.

## Operations

```sh
npx wrangler deployments list
npx wrangler secret list
npx wrangler queues list
npx wrangler tail
```

Workers observability lưu invocation logs, structured application logs và traces 5%. `PUBLIC_WEBHOOK_URL` trong `wrangler.jsonc` là URL public không nhạy cảm dùng để đối chiếu `getWebhookInfo`. DLQ không có consumer chủ động để giữ message cho điều tra; cron đọc realtime metrics, ghi log và gửi cảnh báo Telegram.

### DLQ recovery runbook

Cloudflare giữ message trong DLQ không có consumer trong 4 ngày. Khi nhận cảnh báo:

1. Xác định và sửa nguyên nhân trước, đặc biệt là `GATEWAY_AUTH_FAILED`, GAS timeout hoặc deployment URL sai.
2. Dùng Cloudflare dashboard để xem từng message và `update_id`; đối chiếu với `ProcessedUpdates` trong Sheets.
3. Chỉ replay message chưa có record hoặc đang `pending`/`failed`. Idempotency ở GAS sẽ bỏ qua update đã xử lý.
4. Gửi lại vào queue chính theo thứ tự tăng dần của `update_id`, mỗi lần một message; xác nhận log `telegram_update_forwarded` trước message tiếp theo.
5. Không gắn consumer tự động vào DLQ: replay khi nguyên nhân chưa được sửa sẽ làm mất cửa sổ điều tra và tạo vòng lặp lỗi.

## Capacity guardrail

GAS dùng một script-wide lock để giữ mutation trên Sheets atomic giữa Telegram, Zalo, staff confirmation và expiry. Worker vì thế cố ý đặt `max_concurrency: 1`. Runtime ghi structured warning `script_lock_contention` khi chờ lock từ 1 giây trở lên.

Lập kế hoạch chuyển Orders, Customers và ConversationStates sang datastore có transaction/keyed concurrency khi p95 `doPost` vượt 5 giây, xuất hiện lock wait từ 1 giây trong giờ bình thường, hoặc queue age tăng liên tục. Không tăng `max_concurrency` trước migration vì chỉ chuyển backlog từ Queue sang GAS lock contention.
