# OpenClaw — cấu hình 2 agent tách biệt (ops vs FAQ khách)

Đây là cấu hình thật cho `~/.openclaw/openclaw.json`, thay cho cách cài "chung
1 agent" ở hai doc trước (`docs/openclaw-admin-integration.md`,
`docs/openclaw-customer-faq.md`). Lý do cần tách, xem lại phần trả lời rủi ro
an toàn thông tin: agent FAQ nhận tin từ người lạ (khách), agent ops có quyền
`exec` + token thanh toán — hai thứ đó không nên chia sẻ context hay quyền.

## Nguyên tắc thiết kế

- **2 agent riêng** (`ops`, `faq`), mỗi agent chỉ thấy đúng 1 skill của mình
  (`agents.list[].skills` **thay thế** danh sách mặc định, không cộng dồn —
  agent `faq` không bao giờ load được skill `zalo-clawbot-ops` dù file nằm
  chung 1 thư mục).
- **2 bot Telegram riêng**: `owner` (bot cá nhân bạn dùng để chat với agent
  ops) và `faq` (bot mới cho khách — không phải `@SUNKACAFEBOT`, bot đó vẫn
  thuộc về hệ thống đặt hàng GAS).
- Agent `ops`: DM allowlist chỉ Telegram user ID của bạn — không ai khác nhắn
  được.
- Agent `faq`: bắt buộc mở cho khách lạ (`dmPolicy: "open"`), nên bị tước gần
  hết quyền tool + bắt buộc sandbox toàn phần, đúng khuyến nghị của OpenClaw
  cho agent public-facing.
- `tools.elevated.enabled: false` toàn cục — không agent nào có "vé thoát"
  khỏi sandbox.

## `~/.openclaw/openclaw.json`

```json5
{
  agents: {
    defaults: {
      workspace: "~/.openclaw/workspace",
    },
    list: [
      {
        id: "ops",
        name: "Sun Ka Ops",
        workspace: "~/.openclaw/workspace-ops",
        // Chỉ skill vận hành — không thấy skill FAQ dù cùng thư mục gốc skills/
        skills: ["zalo-clawbot-ops"],
        tools: {
          profile: "coding",
          // exec cần thiết để curl vào Admin API; browser/canvas/nodes không
          // cần cho tác vụ này nên chặn luôn, giảm bề mặt tấn công.
          deny: ["browser", "canvas", "nodes"],
        },
      },
      {
        id: "faq",
        name: "Sun Ka FAQ",
        workspace: "~/.openclaw/workspace-faq",
        // Chỉ skill FAQ tĩnh — không có gì để agent này "lỡ" gọi nhầm
        skills: ["sunka-cafe-faq"],
        // Sandbox toàn phần vì đây là agent nhận tin từ người lạ (khách).
        sandbox: { mode: "all", scope: "agent" },
        tools: {
          profile: "minimal",
          deny: [
            "group:runtime", // exec, process, code_execution
            "group:fs",      // read, write, edit, apply_patch
            "browser", "canvas", "nodes", "cron"
          ],
        },
      },
    ],
  },

  bindings: [
    { agentId: "ops", match: { channel: "telegram", accountId: "owner" } },
    { agentId: "faq", match: { channel: "telegram", accountId: "faq" } },
  ],

  channels: {
    telegram: {
      accounts: {
        owner: {
          // Bot Telegram CÁ NHÂN của bạn để chat với agent ops — không phải
          // @SUNKACAFEBOT. Lấy token từ BotFather khi tạo bot này.
          botToken: "<TOKEN_BOT_CA_NHAN_CUA_BAN>",
          dmPolicy: "allowlist",
          allowFrom: ["tg:<TELEGRAM_USER_ID_CUA_BAN>"],
        },
        faq: {
          // Bot Telegram MỚI dành cho khách hỏi FAQ — cũng không phải
          // @SUNKACAFEBOT (bot đó đã có webhook riêng về GAS, xem
          // docs/openclaw-customer-faq.md).
          botToken: "<TOKEN_BOT_FAQ_MOI>",
          dmPolicy: "open",
        },
      },
    },
  },

  tools: {
    elevated: { enabled: false },
  },
}
```

## Cách lấy `TELEGRAM_USER_ID_CUA_BAN`

Nhắn `/start` cho bot Telegram [@userinfobot](https://t.me/userinfobot) — nó
trả về ID số của tài khoản Telegram bạn, dùng đúng định dạng `tg:<id>` trong
`allowFrom`.

## Thư mục skill dùng chung

Đặt cả 2 `SKILL.md` vào một root skill dùng chung (không cần tách theo
workspace vì `agents.list[].skills` đã lọc theo tên):

```sh
mkdir -p ~/.openclaw/skills/zalo-clawbot-ops ~/.openclaw/skills/sunka-cafe-faq
cp docs/openclaw-skill/SKILL.md ~/.openclaw/skills/zalo-clawbot-ops/SKILL.md
cp docs/openclaw-skill/sunka-cafe-faq/SKILL.md ~/.openclaw/skills/sunka-cafe-faq/SKILL.md
```

## Biến môi trường (chỉ agent `ops` cần)

Export ở nơi tiến trình Gateway chạy (shell profile hoặc service env),
**tuyệt đối không đặt trong `openclaw.json`** vì file đó không phải chỗ lưu
secret:

```sh
export ZALO_CLAWBOT_WEB_APP_URL="<WEB_APP_URL>"
export ZALO_CLAWBOT_ADMIN_TOKEN="<ADMIN_API_TOKEN>"
```

Agent `faq` không cần biến môi trường nào — skill của nó không gọi API nào.

## Áp dụng

```sh
openclaw skills list          # xác nhận cả 2 skill xuất hiện
openclaw gateway restart
openclaw security audit       # kiểm tra lại: inbound access, tool blast radius, network exposure
```

## Việc vẫn phải tự làm, mình không tự động hoá được

- Tạo 2 bot Telegram mới qua BotFather (bot `owner` và bot `faq`), lấy token.
- Lấy Telegram user ID của bạn qua `@userinfobot`.
- Set `ADMIN_API_TOKEN` trên Script Properties (đã hướng dẫn ở
  `docs/openclaw-admin-integration.md`) và export 2 env var ở trên.
- Chạy `openclaw security audit` sau khi cấu hình xong và đọc kết quả — đây
  là bước tự kiểm tra cuối, không nên bỏ qua trước khi cho khách thật dùng bot
  `faq`.

## Nếu sau này nghi ngờ bị xâm nhập

Dừng Gateway ngay, sau đó rotate theo thứ tự: `ADMIN_API_TOKEN` (Script
Property GAS) → token 2 bot Telegram (BotFather → `/revoke`) → mọi API key
khác agent `ops` từng dùng. Xem thêm phần "Incident response" trong
[Gateway security](https://docs.openclaw.ai/gateway/security) của OpenClaw.
