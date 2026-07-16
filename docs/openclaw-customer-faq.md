# OpenClaw — trợ lý FAQ cho khách (SÚN KA)

> Dùng cấu hình 2-agent tách biệt ở `docs/openclaw-multi-agent-config.md` để
> cài — file đó đã bao gồm agent này (`faq`) với tool bị tước gần hết và bắt
> buộc sandbox, đúng khuyến nghị an toàn cho agent nhận tin từ khách lạ. Phần
> dưới đây mô tả nội dung skill và cách test, không phải bước cài đặt chính.

Mục tiêu: một bot riêng trả lời câu hỏi khách (giờ mở cửa, khu vực giao hàng,
thanh toán...) rồi dẫn khách sang bot đặt hàng thật (`@SUNKACAFEBOT`) để chốt
đơn. Bot FAQ này **không** đụng vào `OrderService`, không gọi API admin, không
thấy dữ liệu đơn hàng nào — chỉ trả lời theo nội dung tĩnh trong `SKILL.md`.

## Vì sao cần một bot Telegram khác, không dùng lại `@SUNKACAFEBOT`

`@SUNKACAFEBOT` đã có webhook đăng ký về Cloudflare Worker → GAS (xem
`telegram-gateway/`). Một bot token chỉ nhận webhook về một nơi — không thể
vừa trỏ về GAS vừa để OpenClaw đọc cùng lúc. Muốn khách chat với "trợ lý FAQ",
cần:

1. Tạo bot Telegram **mới** qua BotFather (ví dụ `@sunkacafe_hoidap_bot`), hoặc
2. Dùng kênh khác OpenClaw hỗ trợ (WhatsApp, Zalo cá nhân...) miễn không phải
   chính số/token đang chạy hệ thống đặt hàng.

Trong tin nhắn chào của bot FAQ, luôn có link `t.me/SUNKACAFEBOT` để khách qua
đặt hàng thật — hai bot phối hợp, không thay thế nhau.

## Cài đặt

1. Nếu máy đã cài OpenClaw cho skill vận hành (`zalo-clawbot-ops`) thì dùng
   chung Gateway, chỉ thêm skill mới; nếu chưa, cài theo
   `docs/openclaw-admin-integration.md` mục 2 bước 1.

2. Copy skill FAQ vào workspace:

   ```sh
   mkdir -p ~/.openclaw/workspace/skills/sunka-cafe-faq
   cp docs/openclaw-skill/sunka-cafe-faq/SKILL.md \
     ~/.openclaw/workspace/skills/sunka-cafe-faq/SKILL.md
   ```

   Không cần biến môi trường nào — skill này chỉ là nội dung tĩnh, không gọi
   API nào cả.

3. Kết nối bot Telegram FAQ mới vào OpenClaw (xem
   [Channels → Telegram](https://docs.openclaw.ai/channels/telegram) để lấy
   token từ BotFather và khai báo trong `openclaw.json`).

4. Nạp lại skill và khởi động lại Gateway:

   ```sh
   openclaw skills list        # xác nhận sunka-cafe-faq xuất hiện
   openclaw gateway restart
   ```

## Thử

Nhắn cho bot FAQ mới:

- "quán mở cửa mấy giờ" → trả lời "từ 8:00 sáng"
- "giao hàng khu vực nào, có tính phí không" → "Phường Tân Sơn Nhất, miễn phí"
- "thanh toán sao" → "tiền mặt hoặc chuyển khoản/VietQR"
- "cho tôi đặt 2 ly bạc xỉu" → phải trả lời ngắn gọn rồi gửi link
  `https://t.me/SUNKACAFEBOT`, **không** tự nhận đơn

Nếu bot FAQ tự ý cố "đặt giúp" hoặc bịa giờ đóng cửa/khuyến mãi không có trong
`SKILL.md`, sửa lại phần "Việc bạn KHÔNG làm" cho rõ hơn — đây là lỗi cấu hình
skill, không phải giới hạn của kiến trúc.

## Cập nhật thông tin sau này

Sửa trực tiếp `docs/openclaw-skill/sunka-cafe-faq/SKILL.md` (giờ mở cửa, khu
vực, phí ship, hình thức thanh toán...) rồi copy đè lại file trong
`~/.openclaw/workspace/skills/sunka-cafe-faq/SKILL.md` và
`openclaw gateway restart`. Không có phần nào trong luồng này đọc từ Sheet
hay Script Properties của Zalo Clawbot — đổi thông tin quán không cần đụng gì
tới GAS.
