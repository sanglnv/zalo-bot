# Tích hợp OpenClaw làm trợ lý vận hành

> Nếu bạn cũng cài agent FAQ khách hàng (`docs/openclaw-customer-faq.md`),
> dùng cấu hình 2-agent tách biệt ở `docs/openclaw-multi-agent-config.md`
> thay vì cài đơn giản 1 agent như mục 2 bên dưới — lý do an toàn thông tin
> giải thích trong file đó.

Mục tiêu: chủ shop nhắn OpenClaw (chạy trên máy riêng, qua Telegram/WhatsApp
cá nhân của chủ shop) để hỏi "còn đơn nào chờ thanh toán", "đơn X tình trạng
gì", "xác nhận đơn X đã thanh toán" — tách biệt hoàn toàn với luồng khách hàng
hiện tại (Telegram/Zalo adapter không đổi gì).

OpenClaw (<https://openclaw.ai>, docs tại <https://docs.openclaw.ai>) là một
gateway AI agent tự host, chạy trên máy/server riêng, không phải thư viện
nhúng vào code GAS. Tích hợp ở đây là: GAS mở một API admin nhỏ, OpenClaw gọi
API đó qua một **skill** (`SKILL.md`) dùng tool `exec` sẵn có của nó.

## 1. Phía GAS — bật API admin

Thêm Script Property mới (Apps Script → Project Settings → Script Properties):

| Property | Giá trị |
| --- | --- |
| `ADMIN_API_TOKEN` | Chuỗi ngẫu nhiên, dài, riêng biệt — **không dùng lại** `GAS_GATEWAY_TOKEN` hay bất kỳ secret nào khác. Token này không giới hạn theo scope Telegram/Zalo, chỉ nên đưa cho chính chủ shop. |

Sau khi thêm, `clasp push` code mới (đã có sẵn trong repo: `src/admin/AdminApi.gs`,
route `platform=admin` trong `src/adapters/webhookRouter.gs`) rồi tạo lại
deployment Web app nếu cần (deployment cũ vẫn dùng được nếu bạn "Manage
deployments → Edit → New version" thay vì tạo deployment mới).

Không cần đổi `TELEGRAM_WEBHOOK_URL`/`ZALO_*` — route admin độc lập, không đi
qua Cloudflare Worker.

Kiểm tra nhanh bằng `curl` (thay `<WEB_APP_URL>` và `<ADMIN_API_TOKEN>`):

```sh
curl -sS -X POST "<WEB_APP_URL>?platform=admin&admin_token=<ADMIN_API_TOKEN>&action=list_pending"
```

Kỳ vọng `{"ok":true,"orders":[...]}` (mảng rỗng nếu chưa có đơn nào chờ).

**Gotcha đã gặp thực tế:** `clasp push` chỉ cập nhật code trong project, **không**
tự cập nhật deployment Web app đang chạy — URL `/exec` vẫn phục vụ đúng
version đã pin lúc deploy. Sau mỗi lần `clasp push` có đổi code liên quan tới
route `platform=admin` (hoặc bất kỳ route nào), phải vào **Deploy → Manage
deployments → Edit (bút chì) → Version: New version → Deploy** thì URL mới
chạy code mới. Thiếu bước này, `curl` vẫn trả về `OK` (fallback mặc định của
`webhookRouter.gs`) như thể route chưa tồn tại, dễ nhầm là code sai.

Một gotcha khác khi test bằng `curl`: GAS Web app luôn trả `302 Moved
Temporarily` trỏ sang `script.googleusercontent.com` — đây là hành vi bình
thường (hàm đã chạy xong, redirect chỉ để lấy nội dung output), **phải thêm
cờ `-L`** vào `curl` để follow redirect, nếu không sẽ chỉ thấy trang HTML
"Moved Temporarily" thay vì JSON thật.

## 2. Phía OpenClaw — cài skill

1. Cài OpenClaw trên máy bạn (xem [Get started](https://docs.openclaw.ai/start/getting-started)) nếu chưa có:

   ```sh
   npm install -g openclaw@latest
   openclaw onboard --install-daemon
   ```

2. Copy thư mục skill từ repo này vào workspace OpenClaw:

   ```sh
   mkdir -p ~/.openclaw/workspace/skills/zalo-clawbot-ops
   cp docs/openclaw-skill/SKILL.md ~/.openclaw/workspace/skills/zalo-clawbot-ops/SKILL.md
   ```

3. Đặt 2 biến môi trường mà skill cần (`requires.env` trong frontmatter) ở nơi
   tiến trình Gateway của OpenClaw chạy — ví dụ trong shell profile trước khi
   `openclaw gateway restart`, hoặc trong service env nếu chạy như daemon:

   ```sh
   export ZALO_CLAWBOT_WEB_APP_URL="<WEB_APP_URL>"
   export ZALO_CLAWBOT_ADMIN_TOKEN="<ADMIN_API_TOKEN>"
   ```

   Không commit 2 giá trị này vào bất kỳ đâu trong repo Zalo Clawbot hay repo
   OpenClaw.

4. Nạp lại skill và bắt đầu phiên mới để agent thấy skill:

   ```sh
   openclaw skills list        # xác nhận zalo-clawbot-ops xuất hiện
   openclaw gateway restart
   ```

## 3. Thử

Nhắn qua kênh chat cá nhân đã kết nối OpenClaw (Telegram là nhanh nhất để thử):

- "còn đơn nào chờ thanh toán không" → agent gọi `list_pending`
- "đơn <orderId> tình trạng gì" → agent gọi `get_order`
- "xác nhận đơn <orderId> đã thanh toán" → agent hỏi lại xác nhận rồi gọi
  `confirm_payment` — kiểm tra Sheet `Orders` chuyển `PAID` và khách nhận được
  thông báo qua kênh của họ.

Chi tiết từng action, tham số, và cách xử lý lỗi/response nằm trong
`docs/openclaw-skill/SKILL.md`.

## `get_catalog` đọc từ đâu (đã sửa sau một lần phát hiện lệch dữ liệu)

Ban đầu `get_catalog` chỉ đọc Script Property `CATALOG_JSON` — hoá ra đây là
bản dữ liệu **transitional**, không phải nguồn thật khi Telegram fast path
đang bật (`FAST_PATH_ENABLED=true`, xem `docs/telegram-fast-path-phase3.md`):
nguồn thật là D1 (`zalo-clawbot-catalog`) mà Cloudflare Worker đọc trực tiếp.

Đã sửa: `adminGetCatalog()` (`src/admin/AdminApi.gs`) giờ gọi
`POST <TELEGRAM_WEBHOOK_URL>/internal/catalog` (endpoint mới trong
`telegram-gateway/src/index.ts`, xác thực bằng header `X-GAS-Gateway-Token` +
`GAS_GATEWAY_TOKEN` — tái dùng đúng secret đã có, không cần secret mới) để đọc
D1 trực tiếp. Chỉ khi Worker không phản hồi được mới rơi về `CATALOG_JSON` như
cũ. Response luôn có field `source` (`"d1_fast_path"` hoặc
`"catalog_json_fallback"`) để phân biệt.

## Giới hạn phạm vi (cố tình)

- Không có action hủy/hết hạn đơn thủ công — vẫn để trigger tự động
  (`scanAndExpireStalePayments`, mỗi 10 phút) xử lý như hiện tại.
- Không sửa catalog hay cấu hình VietQR qua skill này — vẫn làm trực tiếp
  trong D1 / lệnh admin Telegram `/kho` hiện có.
- `ADMIN_API_TOKEN` là một secret phẳng (so sánh timing-safe, không phải
  OAuth) — phù hợp quy mô 1 chủ shop dùng riêng. Nếu sau này cần nhiều nhân
  viên với quyền khác nhau, cân nhắc thay bằng token theo từng người + ghi
  log chi tiết hơn thay vì mở rộng thêm scope trên token dùng chung.
