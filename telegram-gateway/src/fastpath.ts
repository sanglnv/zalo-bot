import { DurableObject } from "cloudflare:workers";
// These modules are deliberately shared with GAS so the fast path cannot drift
// from the existing business state machine and Telegram adapter contract.
import OrderService from "../../src/core/orderService.js";
import TelegramInboundMapper from "../../src/adapters/telegram/mapInboundMessage.js";
import TelegramOutboundRenderer from "../../src/adapters/telegram/renderOutboundMessage.js";
import type { TelegramUpdate } from "./index";

export interface FastPathConfig {
  bankId: string;
  accountNo: string;
  accountName: string;
  template: string;
  transferPrefix: string;
}

export interface TelegramCommand {
  method: string;
  params: Record<string, unknown>;
}

interface Product {
  productId: string;
  name: string;
  price: number;
  isAvailable: boolean;
  categoryId: string;
  categoryName: string;
}

interface AdminDraft {
  step: string;
  data: JsonRecord;
}

interface InboundMessage extends JsonRecord {
  platform: string;
  platformUserId: string;
  text: string;
  payload: JsonRecord | null;
}

export interface FastPathResult {
  updateId: number;
  duplicate: boolean;
  ignored: boolean;
  commands: TelegramCommand[];
  domainDurationMs: number;
  snapshot: FastPathSnapshot | null;
}

export interface FastPathSnapshot {
  updateId: number;
  customer: JsonRecord;
  conversationState: JsonRecord;
  orders: JsonRecord[];
  capturedAt: string;
}

export interface PaymentResolution {
  outcome: "resolved" | "already_resolved" | "not_found";
  orderId: string;
  status: string | null;
  outboxId: string | null;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonRecord | JsonValue[];
export type JsonRecord = { [key: string]: JsonValue };

function parseRecord(value: string): JsonRecord {
  return JSON.parse(value) as JsonRecord;
}

function paymentQr(config: FastPathConfig, order: JsonRecord): string {
  const content = config.transferPrefix + String(order.orderId);
  return "https://img.vietqr.io/image/" +
    encodeURIComponent(config.bankId) + "-" +
    encodeURIComponent(config.accountNo) + "-" +
    encodeURIComponent(config.template) +
    ".png?amount=" + encodeURIComponent(String(order.totalAmount)) +
    "&addInfo=" + encodeURIComponent(content) +
    "&accountName=" + encodeURIComponent(config.accountName);
}

function requireFastPathConfig(config: FastPathConfig): void {
  const required: Array<keyof FastPathConfig> = [
    "bankId", "accountNo", "accountName"
  ];
  for (const key of required) {
    if (typeof config[key] !== "string" || config[key].trim() === "") {
      throw new Error(`Fast path configuration is missing ${key}`);
    }
  }
}

function vietnamBusinessDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}

export function telegramChatId(update: TelegramUpdate): string | null {
  const message = update.message as { chat?: { id?: string | number } } | undefined;
  const callback = update.callback_query as {
    message?: { chat?: { id?: string | number } };
  } | undefined;
  const value = message?.chat?.id ?? callback?.message?.chat?.id;
  return value == null ? null : String(value);
}

export class TelegramSession extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS customers (
        customer_id TEXT PRIMARY KEY,
        platform_user_id TEXT UNIQUE NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_states (
        customer_id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orders (
        order_id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS orders_customer_created
        ON orders(customer_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS processed_updates (
        update_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL,
        commands_json TEXT NOT NULL,
        ignored INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS notification_outbox (
        outbox_id TEXT PRIMARY KEY,
        commands_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_drafts (
        chat_id TEXT PRIMARY KEY,
        step TEXT NOT NULL,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  async process(
    update: TelegramUpdate,
    config: FastPathConfig,
    isAdmin = false
  ): Promise<FastPathResult> {
    requireFastPathConfig(config);
    const updateId = String(update.update_id);
    const startedAt = Date.now();
    const existing = this.ctx.storage.sql.exec<{
      commands_json: string;
      ignored: number;
    }>(
      "SELECT commands_json, ignored FROM processed_updates WHERE update_id = ?",
      updateId
    ).toArray()[0];
    if (existing) {
      return {
        updateId: update.update_id,
        duplicate: true,
        ignored: existing.ignored === 1,
        commands: JSON.parse(existing.commands_json) as TelegramCommand[],
        domainDurationMs: Date.now() - startedAt,
        snapshot: this.snapshot(update.update_id)
      };
    }

    const inbound = TelegramInboundMapper.mapInboundMessage(update) as InboundMessage | null;
    const chatId = telegramChatId(update);
    if (inbound && chatId && isAdmin) {
      const adminCommands = await this.handleAdmin(inbound, chatId);
      if (adminCommands) {
        this.storeProcessed(updateId, adminCommands, false);
        return {
          updateId: update.update_id,
          duplicate: false,
          ignored: false,
          commands: adminCommands,
          domainDurationMs: Date.now() - startedAt,
          snapshot: null
        };
      }
    }

    const businessDate = vietnamBusinessDate();
    const catalogResult = await this.env.CATALOG_DB.prepare(
      `SELECT p.product_id AS productId, p.name, p.price,
              p.is_available AS isAvailable, p.category_id AS categoryId,
              c.name AS categoryName
       FROM products p
       JOIN categories c ON c.category_id = p.category_id
       LEFT JOIN daily_inventory i
         ON i.product_id = p.product_id AND i.business_date = ?
       WHERE p.is_available = 1 AND c.active = 1
         AND (i.product_id IS NULL OR (i.active = 1 AND i.remaining_quantity > 0))
       ORDER BY c.sort_order, p.sort_order, p.product_id`
    ).bind(businessDate).all<{
      productId: string; name: string; price: number; isAvailable: number;
      categoryId: string; categoryName: string;
    }>();
    const catalog: Product[] = catalogResult.results.map((product) => ({
      ...product,
      isAvailable: product.isAvailable === 1
    }));
    let reservationId: string | null = null;
    if (inbound?.payload?.action === "confirm_order") {
      const cart = this.currentCart(inbound.platformUserId);
      if (cart.length > 0) {
        reservationId = `telegram:${inbound.platformUserId}:${updateId}`;
        try {
          await this.reserveInventory(reservationId, businessDate, cart);
        } catch (error) {
          const message = error instanceof Error && error.message.includes("OUT_OF_STOCK")
            ? "Một món trong giỏ vừa hết hàng. Vui lòng mở lại giỏ và chọn món khác."
            : "Không thể giữ tồn kho lúc này. Vui lòng thử lại.";
          const commands = [{
            method: "sendMessage",
            params: { chat_id: inbound.platformUserId, text: message }
          }];
          this.storeProcessed(updateId, commands, false);
          return {
            updateId: update.update_id, duplicate: false, ignored: false, commands,
            domainDurationMs: Date.now() - startedAt, snapshot: this.snapshot(update.update_id)
          };
        }
      }
    }

    let result: FastPathResult;
    try {
      result = this.ctx.storage.transactionSync(() => {
      if (!inbound) {
        this.storeProcessed(updateId, [], true);
        return {
          updateId: update.update_id,
          duplicate: false,
          ignored: true,
          commands: [],
          domainDurationMs: Date.now() - startedAt,
          snapshot: null
        };
      }

      const repositories = this.repositories();
      const service = (OrderService as any).create({
        ...repositories,
        getCatalog: () => catalog,
        createQrContent: (order: JsonRecord) => paymentQr(config, order),
        createId: () => crypto.randomUUID().replace(/-/g, "").slice(0, 20),
        now: () => new Date(),
        withLock: <T>(operation: () => T) => operation()
      });

      let commands: TelegramCommand[];
      try {
        const outbound = service.handleMessage(inbound) as Array<{
          type: string;
          content: JsonRecord;
        }>;
        commands = outbound.map((message) =>
          TelegramOutboundRenderer.renderOutboundMessage(
            message,
            inbound.platformUserId
          ) as TelegramCommand
        );
      } catch (error) {
        const userError = error as { customerMessage?: unknown };
        if (typeof userError.customerMessage !== "string") throw error;
        commands = [{
          method: "sendMessage",
          params: { chat_id: inbound.platformUserId, text: userError.customerMessage }
        }];
      }

      this.storeProcessed(updateId, commands, false);
      return {
        updateId: update.update_id,
        duplicate: false,
        ignored: false,
        commands,
        domainDurationMs: Date.now() - startedAt,
        snapshot: this.snapshot(update.update_id)
      };
      });
    } catch (error) {
      if (reservationId) await this.releaseReservation(reservationId);
      throw error;
    }
    const awaiting = result.snapshot?.orders.find((order) => order.status === "AWAITING_PAYMENT");
    if (reservationId) {
      if (awaiting) await this.commitReservation(reservationId, String(awaiting.orderId));
      else await this.releaseReservation(reservationId);
    }
    for (const order of result.snapshot?.orders ?? []) {
      if (order.status === "CANCELLED" || order.status === "EXPIRED") {
        await this.releaseOrderInventory(String(order.orderId));
      }
    }
    if (awaiting) {
      const timeout = Number(this.env.PAYMENT_TIMEOUT_MINUTES || "30");
      const createdAt = new Date(String(awaiting.createdAt)).getTime();
      if (Number.isFinite(timeout) && timeout > 0 && Number.isFinite(createdAt)) {
        await this.ctx.storage.setAlarm(createdAt + timeout * 60_000);
      }
    }
    return result;
  }

  async confirmPayment(orderId: string, confirmedBy: string): Promise<PaymentResolution> {
    return this.resolvePayment(orderId, "confirm", confirmedBy);
  }

  async expirePayment(orderId: string): Promise<PaymentResolution> {
    return this.resolvePayment(orderId, "expire", "system:durable-object-alarm");
  }

  async flushOutbox(outboxId: string): Promise<void> {
    const row = this.ctx.storage.sql.exec<{
      commands_json: string;
      snapshot_json: string;
      delivered: number;
    }>(
      "SELECT commands_json, snapshot_json, delivered FROM notification_outbox WHERE outbox_id = ?",
      outboxId
    ).toArray()[0];
    if (!row || row.delivered === 1) return;
    const snapshot = JSON.parse(row.snapshot_json) as FastPathSnapshot;
    await this.env.FAST_PATH_SYNC.send({ kind: "fast_path_sync", ...snapshot });
    const commands = JSON.parse(row.commands_json) as TelegramCommand[];
    for (const command of commands) {
      const response = await fetch(
        `https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/${command.method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(command.params),
          signal: AbortSignal.timeout(5_000)
        }
      );
      if (!response.ok) throw new Error(`Telegram ${command.method} returned HTTP ${response.status}`);
    }
    this.ctx.storage.sql.exec(
      "UPDATE notification_outbox SET delivered = 1 WHERE outbox_id = ?", outboxId
    );
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    const pendingOutbox = this.ctx.storage.sql.exec<{ outbox_id: string }>(
      "SELECT outbox_id FROM notification_outbox WHERE delivered = 0 ORDER BY created_at LIMIT 1"
    ).toArray()[0];
    if (pendingOutbox) {
      await this.flushOutbox(pendingOutbox.outbox_id);
      return;
    }
    const awaiting = this.ctx.storage.sql.exec<{ record_json: string }>(
      "SELECT record_json FROM orders ORDER BY created_at DESC"
    ).toArray().map((row) => parseRecord(row.record_json))
      .find((order) => order.status === "AWAITING_PAYMENT");
    if (!awaiting) return;
    const timeout = Number(this.env.PAYMENT_TIMEOUT_MINUTES || "30");
    const dueAt = new Date(String(awaiting.createdAt)).getTime() + timeout * 60_000;
    if (dueAt > Date.now()) {
      await this.ctx.storage.setAlarm(dueAt);
      return;
    }
    const resolution = await this.expirePayment(String(awaiting.orderId));
    if (resolution.outboxId) await this.flushOutbox(resolution.outboxId);
  }

  private async resolvePayment(
    orderId: string,
    action: "confirm" | "expire",
    actor: string
  ): Promise<PaymentResolution> {
    const result = this.ctx.storage.transactionSync(() => {
      const repositories = this.repositories();
      const existing = (repositories.orderRepository as {
        findById(id: string): JsonRecord | null;
      }).findById(orderId);
      if (!existing) return {
        outcome: "not_found" as const, orderId, status: null, outboxId: null
      };
      if (existing.status !== "AWAITING_PAYMENT") return {
        outcome: "already_resolved" as const,
        orderId,
        status: String(existing.status),
        outboxId: null
      };
      const service = (OrderService as any).create({
        ...repositories,
        getCatalog: () => [],
        createQrContent: () => "",
        createId: () => crypto.randomUUID(),
        now: () => new Date(),
        withLock: <T>(operation: () => T) => operation()
      });
      const domainResult = action === "confirm"
        ? service.confirmPayment(orderId, actor)
        : service.expireOrder(orderId);
      const customer = domainResult.customer as JsonRecord;
      const chatId = String((customer.platformLinks as JsonRecord[])
        .find((link) => link.platform === "telegram")?.platformUserId || "");
      const commands = (domainResult.outboundMessages as Array<{
        type: string; content: JsonRecord;
      }>).map((message) => TelegramOutboundRenderer.renderOutboundMessage(message, chatId));
      const snapshot = this.snapshot(Number(Date.now()));
      if (!snapshot) throw new Error("Payment resolution snapshot is unavailable");
      const outboxId = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        `INSERT INTO notification_outbox(outbox_id, commands_json, snapshot_json, delivered, created_at)
         VALUES (?, ?, ?, 0, ?)`,
        outboxId,
        JSON.stringify(commands),
        JSON.stringify(snapshot),
        new Date().toISOString()
      );
      return {
        outcome: "resolved" as const,
        orderId,
        status: action === "confirm" ? "PAID" : "EXPIRED",
        outboxId
      };
    });
    if (action === "expire" && result.outcome === "resolved") {
      await this.releaseOrderInventory(orderId);
    }
    if (result.outcome === "resolved") await this.ctx.storage.setAlarm(Date.now() + 1_000);
    return result;
  }

  private currentCart(platformUserId: string): JsonRecord[] {
    const customer = this.ctx.storage.sql.exec<{ customer_id: string }>(
      "SELECT customer_id FROM customers WHERE platform_user_id = ?", platformUserId
    ).toArray()[0];
    if (!customer) return [];
    const state = this.ctx.storage.sql.exec<{ record_json: string }>(
      "SELECT record_json FROM conversation_states WHERE customer_id = ?", customer.customer_id
    ).toArray()[0];
    if (!state) return [];
    const record = parseRecord(state.record_json);
    const context = record.contextData as JsonRecord | undefined;
    return Array.isArray(context?.cart) ? context.cart as JsonRecord[] : [];
  }

  private async reserveInventory(
    reservationId: string,
    businessDate: string,
    cart: JsonRecord[]
  ): Promise<void> {
    const exists = await this.env.CATALOG_DB.prepare(
      "SELECT 1 FROM inventory_reservations WHERE reservation_id = ? LIMIT 1"
    ).bind(reservationId).first();
    if (exists) return;
    const now = new Date().toISOString();
    const statements = cart.flatMap((item) => {
      const productId = String(item.productId);
      const quantity = Number(item.quantity);
      return [
        this.env.CATALOG_DB.prepare(
          `INSERT INTO inventory_reservations(
             reservation_id, product_id, business_date, quantity, status, created_at, updated_at
           )
           SELECT ?, ?, ?, ?, 'RESERVED', ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM daily_inventory WHERE product_id = ? AND business_date = ?
           ) OR EXISTS (
             SELECT 1 FROM daily_inventory
             WHERE product_id = ? AND business_date = ? AND active = 1
               AND remaining_quantity >= ?
           )`
        ).bind(
          reservationId, productId, businessDate, quantity, now, now,
          productId, businessDate, productId, businessDate, quantity
        ),
        this.env.CATALOG_DB.prepare(
          `UPDATE daily_inventory
           SET remaining_quantity = remaining_quantity - ?, updated_at = ?
           WHERE product_id = ? AND business_date = ?
             AND EXISTS (
               SELECT 1 FROM inventory_reservations
               WHERE reservation_id = ? AND product_id = ? AND status = 'RESERVED'
             )`
        ).bind(quantity, now, productId, businessDate, reservationId, productId)
      ];
    });
    const results = await this.env.CATALOG_DB.batch(statements);
    const failed = cart.some((_, index) => results[index * 2].meta.changes !== 1);
    if (failed) {
      await this.releaseReservation(reservationId);
      throw new Error("OUT_OF_STOCK");
    }
  }

  private async commitReservation(reservationId: string, orderId: string): Promise<void> {
    await this.env.CATALOG_DB.prepare(
      `UPDATE inventory_reservations
       SET status = 'COMMITTED', order_id = ?, updated_at = ?
       WHERE reservation_id = ? AND status = 'RESERVED'`
    ).bind(orderId, new Date().toISOString(), reservationId).run();
  }

  private async releaseReservation(reservationId: string): Promise<void> {
    await this.releaseInventory(
      "reservation_id = ?", [reservationId]
    );
  }

  private async releaseOrderInventory(orderId: string): Promise<void> {
    await this.releaseInventory("order_id = ?", [orderId]);
  }

  private async releaseInventory(where: string, bindings: string[]): Promise<void> {
    const now = new Date().toISOString();
    const released = await this.env.CATALOG_DB.prepare(
      `UPDATE inventory_reservations SET status = 'RELEASED', updated_at = ?
       WHERE ${where} AND status != 'RELEASED'
       RETURNING product_id AS productId, business_date AS businessDate, quantity`
    ).bind(now, ...bindings).all<{
      productId: string; businessDate: string; quantity: number;
    }>();
    if (!released.results.length) return;
    await this.env.CATALOG_DB.batch(released.results.map((row) =>
      this.env.CATALOG_DB.prepare(
        `UPDATE daily_inventory
         SET remaining_quantity = remaining_quantity + ?, updated_at = ?
         WHERE product_id = ? AND business_date = ?`
      ).bind(row.quantity, now, row.productId, row.businessDate)
    ));
  }

  private adminDraft(chatId: string): AdminDraft | null {
    const row = this.ctx.storage.sql.exec<{ step: string; data_json: string }>(
      "SELECT step, data_json FROM admin_drafts WHERE chat_id = ?", chatId
    ).toArray()[0];
    return row ? { step: row.step, data: parseRecord(row.data_json) } : null;
  }

  private saveAdminDraft(chatId: string, step: string, data: JsonRecord): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO admin_drafts(chat_id, step, data_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET step = excluded.step,
         data_json = excluded.data_json, updated_at = excluded.updated_at`,
      chatId, step, JSON.stringify(data), new Date().toISOString()
    );
  }

  private clearAdminDraft(chatId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM admin_drafts WHERE chat_id = ?", chatId);
  }

  private adminMessage(chatId: string, text: string): TelegramCommand[] {
    return [{ method: "sendMessage", params: { chat_id: chatId, text } }];
  }

  private async handleAdmin(
    inbound: InboundMessage,
    chatId: string
  ): Promise<TelegramCommand[] | null> {
    const text = inbound.text.trim();
    const command = text.toLowerCase().split(/\s+/)[0].split("@")[0];
    const action = typeof inbound.payload?.action === "string" ? inbound.payload.action : "";
    const draft = this.adminDraft(chatId);

    if (command === "/huyadmin") {
      this.clearAdminDraft(chatId);
      return this.adminMessage(chatId, "Đã hủy thao tác quản trị.");
    }
    if (command === "/admin" || action === "admin_menu") {
      this.clearAdminDraft(chatId);
      return [{
        method: "sendMessage",
        params: {
          chat_id: chatId,
          text: "Quản lý menu hôm nay:",
          reply_markup: { inline_keyboard: [
            [{ text: "➕ Thêm món", callback_data: "admin_add" }],
            [{ text: "📦 Xem tồn", callback_data: "admin_inventory" }],
            [{ text: "⏸ Bật / tắt món", callback_data: "admin_toggle" }]
          ] }
        }
      }];
    }
    if (command === "/themon" || action === "admin_add") {
      this.saveAdminDraft(chatId, "ADD_NAME", {});
      return this.adminMessage(chatId, "Nhập tên món mới. Gõ /huyadmin để hủy.");
    }
    if (action === "admin_inventory") {
      return this.adminMessage(chatId, "Dùng /kho CAT_ID để xem tồn theo danh mục, hoặc /ton PRODUCT_ID SỐ_LƯỢNG để đặt tồn hôm nay.");
    }
    if (action === "admin_toggle") {
      return this.adminMessage(chatId, "Dùng /tat PRODUCT_ID để ngừng bán hoặc /bat PRODUCT_ID để mở bán lại.");
    }
    if (command === "/ton") {
      const parts = text.split(/\s+/);
      const quantity = Number(parts[2]);
      if (!parts[1] || !Number.isInteger(quantity) || quantity < 0) {
        return this.adminMessage(chatId, "Cú pháp: /ton PRODUCT_ID SỐ_LƯỢNG");
      }
      const result = await this.setDailyStock(parts[1], quantity);
      return this.adminMessage(chatId, result);
    }
    if (command === "/tat" || command === "/bat") {
      const productId = text.split(/\s+/)[1];
      if (!productId) return this.adminMessage(chatId, `Cú pháp: ${command} PRODUCT_ID`);
      const active = command === "/bat" ? 1 : 0;
      const result = await this.env.CATALOG_DB.prepare(
        "UPDATE products SET is_available = ?, updated_at = ? WHERE product_id = ?"
      ).bind(active, new Date().toISOString(), productId).run();
      return this.adminMessage(
        chatId,
        result.meta.changes ? `${productId}: ${active ? "đang bán" : "đã inactive"}.` : "Không tìm thấy món."
      );
    }
    if (command === "/kho") {
      const categoryId = text.split(/\s+/)[1] || null;
      const rows = await this.env.CATALOG_DB.prepare(
        `SELECT p.product_id AS productId, p.name, p.is_available AS isAvailable,
                i.remaining_quantity AS remainingQuantity
         FROM products p
         LEFT JOIN daily_inventory i ON i.product_id = p.product_id AND i.business_date = ?
         WHERE (? IS NULL OR p.category_id = ?)
         ORDER BY p.sort_order, p.product_id LIMIT 80`
      ).bind(vietnamBusinessDate(), categoryId, categoryId).all<{
        productId: string; name: string; isAvailable: number; remainingQuantity: number | null;
      }>();
      const lines = rows.results.map((row) =>
        `${row.isAvailable ? "✅" : "⏸"} ${row.productId} · ${row.name} · ${row.remainingQuantity == null ? "chưa đặt tồn" : `còn ${row.remainingQuantity}`}`
      );
      return this.adminMessage(chatId, lines.length ? lines.join("\n").slice(0, 4000) : "Không có món phù hợp.");
    }

    if (draft?.step === "ADD_NAME" && text) {
      this.saveAdminDraft(chatId, "ADD_PRICE", { name: text });
      return this.adminMessage(chatId, "Nhập giá bán, chỉ nhập số. Ví dụ: 25000");
    }
    if (draft?.step === "ADD_PRICE") {
      const price = Number(text.replace(/[^0-9]/g, ""));
      if (!Number.isInteger(price) || price <= 0) return this.adminMessage(chatId, "Giá không hợp lệ. Ví dụ: 25000");
      const categories = await this.env.CATALOG_DB.prepare(
        "SELECT category_id AS categoryId, name FROM categories WHERE active = 1 ORDER BY sort_order"
      ).all<{ categoryId: string; name: string }>();
      this.saveAdminDraft(chatId, "ADD_CATEGORY", { ...draft.data, price });
      return [{
        method: "sendMessage",
        params: {
          chat_id: chatId,
          text: "Chọn danh mục:",
          reply_markup: { inline_keyboard: categories.results.map((category) => [{
            text: category.name,
            callback_data: TelegramInboundMapper.encodeCallbackData({
              action: "admin_category", categoryId: category.categoryId
            })
          }]) }
        }
      }];
    }
    if (draft?.step === "ADD_CATEGORY" && action === "admin_category") {
      this.saveAdminDraft(chatId, "ADD_STOCK", {
        ...draft.data,
        categoryId: String(inbound.payload?.categoryId || "CAT_OTHER")
      });
      return this.adminMessage(chatId, "Nhập số lượng bán hôm nay. Có thể nhập 0.");
    }
    if (draft?.step === "ADD_STOCK") {
      const quantity = Number(text);
      if (!Number.isInteger(quantity) || quantity < 0) return this.adminMessage(chatId, "Số lượng phải là số nguyên từ 0 trở lên.");
      const productId = `P${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
      const category = await this.env.CATALOG_DB.prepare(
        "SELECT name FROM categories WHERE category_id = ? AND active = 1"
      ).bind(String(draft.data.categoryId)).first<{ name: string }>();
      if (!category) return this.adminMessage(chatId, "Danh mục không còn hoạt động. Hãy /huyadmin và thử lại.");
      const now = new Date().toISOString();
      await this.env.CATALOG_DB.prepare(
        `INSERT INTO products(
           product_id, name, price, is_available, sort_order, updated_at, category_id, category_name
         ) VALUES (?, ?, ?, 1, 9999, ?, ?, ?)`
      ).bind(productId, String(draft.data.name), Number(draft.data.price), now, String(draft.data.categoryId), category.name).run();
      await this.setDailyStock(productId, quantity);
      this.clearAdminDraft(chatId);
      return this.adminMessage(chatId, `Đã thêm ${draft.data.name}\nID: ${productId}\nTồn hôm nay: ${quantity}`);
    }
    return null;
  }

  private async setDailyStock(productId: string, quantity: number): Promise<string> {
    const product = await this.env.CATALOG_DB.prepare(
      "SELECT name FROM products WHERE product_id = ?"
    ).bind(productId).first<{ name: string }>();
    if (!product) return "Không tìm thấy món.";
    const now = new Date().toISOString();
    await this.env.CATALOG_DB.prepare(
      `INSERT INTO daily_inventory(
         product_id, business_date, initial_quantity, remaining_quantity, active, updated_at
       ) VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(product_id, business_date) DO UPDATE SET
         initial_quantity = excluded.initial_quantity,
         remaining_quantity = excluded.remaining_quantity,
         active = 1,
         updated_at = excluded.updated_at`
    ).bind(productId, vietnamBusinessDate(), quantity, quantity, now).run();
    return `${product.name}: tồn hôm nay = ${quantity}.`;
  }

  private snapshot(updateId: number): FastPathSnapshot | null {
    const customer = this.ctx.storage.sql.exec<{ record_json: string }>(
      "SELECT record_json FROM customers LIMIT 1"
    ).toArray()[0];
    if (!customer) return null;
    const customerRecord = parseRecord(customer.record_json);
    const customerId = String(customerRecord.customerId);
    const state = this.ctx.storage.sql.exec<{ record_json: string }>(
      "SELECT record_json FROM conversation_states WHERE customer_id = ?", customerId
    ).toArray()[0];
    if (!state) return null;
    const orders = this.ctx.storage.sql.exec<{ record_json: string }>(
      "SELECT record_json FROM orders WHERE customer_id = ? ORDER BY created_at ASC", customerId
    ).toArray().map((row) => parseRecord(row.record_json));
    return {
      updateId,
      customer: customerRecord,
      conversationState: parseRecord(state.record_json),
      orders,
      capturedAt: new Date().toISOString()
    };
  }

  private storeProcessed(updateId: string, commands: TelegramCommand[], ignored: boolean): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO processed_updates(update_id, processed_at, commands_json, ignored)
       VALUES (?, ?, ?, ?)`,
      updateId,
      new Date().toISOString(),
      JSON.stringify(commands),
      ignored ? 1 : 0
    );
  }

  private repositories(): Record<string, unknown> {
    const sql = this.ctx.storage.sql;
    const customerRepository = {
      save(customer: JsonRecord) {
        sql.exec(
          `INSERT INTO customers(customer_id, platform_user_id, record_json)
           VALUES (?, ?, ?)
           ON CONFLICT(customer_id) DO UPDATE SET
             platform_user_id = excluded.platform_user_id,
             record_json = excluded.record_json`,
          customer.customerId,
          (customer.platformLinks as JsonRecord[])[0].platformUserId,
          JSON.stringify(customer)
        );
        return customer;
      },
      findById(customerId: string) {
        const row = sql.exec<{ record_json: string }>(
          "SELECT record_json FROM customers WHERE customer_id = ?", customerId
        ).toArray()[0];
        return row ? parseRecord(row.record_json) : null;
      },
      findByPlatformUserId(_platform: string, platformUserId: string) {
        const row = sql.exec<{ record_json: string }>(
          "SELECT record_json FROM customers WHERE platform_user_id = ?", platformUserId
        ).toArray()[0];
        return row ? parseRecord(row.record_json) : null;
      }
    };
    const conversationStateRepository = {
      get(customerId: string) {
        const row = sql.exec<{ record_json: string }>(
          "SELECT record_json FROM conversation_states WHERE customer_id = ?", customerId
        ).toArray()[0];
        return row ? parseRecord(row.record_json) : null;
      },
      set(customerId: string, state: JsonRecord) {
        sql.exec(
          `INSERT INTO conversation_states(customer_id, record_json) VALUES (?, ?)
           ON CONFLICT(customer_id) DO UPDATE SET record_json = excluded.record_json`,
          customerId,
          JSON.stringify(state)
        );
        return state;
      }
    };
    const orderRepository = {
      save(order: JsonRecord) {
        sql.exec(
          `INSERT INTO orders(order_id, customer_id, created_at, record_json)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(order_id) DO UPDATE SET record_json = excluded.record_json`,
          order.orderId,
          order.customerId,
          order.createdAt,
          JSON.stringify(order)
        );
        return order;
      },
      findById(orderId: string) {
        const row = sql.exec<{ record_json: string }>(
          "SELECT record_json FROM orders WHERE order_id = ?", orderId
        ).toArray()[0];
        return row ? parseRecord(row.record_json) : null;
      },
      findByCustomerId(customerId: string) {
        return sql.exec<{ record_json: string }>(
          "SELECT record_json FROM orders WHERE customer_id = ? ORDER BY created_at ASC",
          customerId
        ).toArray().map((row) => parseRecord(row.record_json));
      },
      updateStatus(orderId: string, status: string) {
        const order = orderRepository.findById(orderId) as JsonRecord | null;
        if (!order) throw new Error(`Order not found: ${orderId}`);
        order.status = status;
        order.updatedAt = new Date().toISOString();
        return orderRepository.save(order);
      }
    };
    return { orderRepository, customerRepository, conversationStateRepository };
  }
}
