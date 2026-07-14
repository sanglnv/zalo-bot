# Telegram gateway

Cloudflare Worker này là ingress production bắt buộc giữa Telegram và Google Apps Script:

`Telegram → authenticated Worker → durable Queue → authenticated GAS web app`

Worker kiểm tra `X-Telegram-Bot-Api-Secret-Token`, dừng callback spinner ở edge, ghi update vào Queue trước khi trả `200`, rồi consumer chuyển tiếp tới GAS. Delivery lỗi được retry với backoff và cuối cùng đi vào DLQ. Cron mỗi 5 phút ghi structured error log nếu DLQ có backlog, gọi Telegram `getWebhookInfo`, tự sửa URL drift bằng `setWebhook` mà không xoá pending updates, và probe token Worker→GAS.

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

Thiết lập bốn secret qua prompt tương tác; không đặt giá trị secret trong source hoặc command history:

```sh
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put GAS_WEB_APP_URL
npx wrangler secret put GAS_GATEWAY_TOKEN
```

- `GAS_WEB_APP_URL`: Apps Script production `/exec` URL.
- `TELEGRAM_WEBHOOK_SECRET`: chuỗi ngẫu nhiên 1–256 ký tự chỉ gồm `A-Z`, `a-z`, `0-9`, `_`, `-`; dùng cùng giá trị cho Script Property tương ứng.
- `GAS_GATEWAY_TOKEN`: secret ngẫu nhiên khác, dùng cùng giá trị cho Script Property tương ứng.
- `TELEGRAM_BOT_TOKEN`: token BotFather.

Deploy và lưu URL `workers.dev` được Wrangler trả về:

```sh
npm run check
npm run deploy
```

Đặt URL đó vào GAS Script Property `TELEGRAM_WEBHOOK_URL`, update Apps Script web-app deployment, rồi chạy `registerWebhook(false)` trong Apps Script editor. Không dùng `true` trong rollout thường vì nó xoá pending updates.

## Production verification

1. Chạy GAS `healthCheck()` và xác nhận `telegramWebhook.status === "ok"`, `url === expectedUrl`, `pendingUpdates === 0`, không có lỗi webhook mới.
2. Gửi `/start`, `catalog`, thêm sản phẩm và bấm callback trên Telegram. Callback phải hết spinner ngay; bot phải trả lời đúng một lần.
3. Trong Cloudflare Workers Logs, xác nhận `telegram_webhook_healthy`, `gas_gateway_healthy`, rồi xác nhận `telegram_update_queued` và `telegram_update_forwarded` có cùng `updateId` khi test chat.
4. Theo dõi `telegram_dlq_not_empty`. Nếu xuất hiện, tra `updateId` trong logs và xử lý nguyên nhân GAS trước khi replay thủ công; không tạo consumer tự xoá DLQ.

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

Workers observability lưu invocation logs, structured application logs và traces 5%. `PUBLIC_WEBHOOK_URL` trong `wrangler.jsonc` là URL public không nhạy cảm dùng để đối chiếu `getWebhookInfo`. DLQ không có consumer chủ động để giữ message cho điều tra; cron chỉ đọc realtime metrics và cảnh báo backlog.
