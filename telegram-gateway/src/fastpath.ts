import { DurableObject } from "cloudflare:workers";
// These modules are deliberately shared with GAS so the fast path cannot drift
// from the existing business state machine and Telegram adapter contract.
import OrderService from "../../src/core/orderService.js";
import Domain from "../../src/core/domain.js";
import StateMachine from "../../src/core/stateMachine.js";
import Billing from "../../src/core/billing.js";
import Repositories from "../../src/core/repositoryContracts.js";
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
  schemaVersion: 2;
  snapshotId: string;
  customerId: string;
  revision: number;
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
  deliveryStatus: "delivered" | "pending" | null;
}

export interface PaymentQrRequest {
  outcome: "ready" | "already_resolved" | "not_found";
  orderId: string;
  status: string | null;
  qrUrl: string | null;
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

export function vietnamBusinessDate(now = new Date()): string {
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
  private processingTail: Promise<void> = Promise.resolve();

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
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notification_progress (
        outbox_id TEXT PRIMARY KEY,
        next_command_index INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sync_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO sync_metadata(singleton, revision) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS queue_outbox (
        message_id TEXT PRIMARY KEY,
        body_json TEXT NOT NULL,
        published INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER,
        last_error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inventory_effects (
        effect_id TEXT PRIMARY KEY,
        effect_type TEXT NOT NULL,
        reservation_id TEXT,
        order_id TEXT,
        status TEXT NOT NULL DEFAULT 'PENDING',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER,
        last_error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS order_inventory_links (
        order_id TEXT PRIMARY KEY,
        reservation_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS order_outboxes (
        order_id TEXT PRIMARY KEY,
        outbox_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_drafts (
        chat_id TEXT PRIMARY KEY,
        step TEXT NOT NULL,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.migrateLegacySchema();
  }

  // Durable Objects created before notification_outbox gained retry/backoff
  // columns (attempts, next_attempt_at, last_error) still have the older
  // table shape: `CREATE TABLE IF NOT EXISTS` never alters an existing table,
  // so those instances are stuck on the old schema forever unless patched here.
  private migrateLegacySchema(): void {
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(notification_outbox)")
      .toArray()
      .map((row) => row.name);
    if (!columns.includes("attempts")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE notification_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0"
      );
    }
    if (!columns.includes("next_attempt_at")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE notification_outbox ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0"
      );
    }
    if (!columns.includes("last_error")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE notification_outbox ADD COLUMN last_error TEXT"
      );
    }
  }

  async process(
    update: TelegramUpdate,
    config: FastPathConfig,
    isAdmin = false
  ): Promise<FastPathResult> {
    const previous = this.processingTail;
    let release!: () => void;
    this.processingTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.processUnlocked(update, config, isAdmin);
    } finally {
      release();
    }
  }

  private async processUnlocked(
    update: TelegramUpdate,
    config: FastPathConfig,
    isAdmin: boolean
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
      await this.drainDurableEffectsBestEffort();
      return {
        updateId: update.update_id,
        duplicate: true,
        ignored: existing.ignored === 1,
        commands: JSON.parse(existing.commands_json) as TelegramCommand[],
        domainDurationMs: Date.now() - startedAt,
        snapshot: null
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
          this.enqueueInventoryEffect(
            `release-reservation:${reservationId}`,
            "RELEASE_RESERVATION",
            reservationId,
            null
          );
          await this.drainDurableEffectsBestEffort();
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
            domainDurationMs: Date.now() - startedAt, snapshot: null
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
        coreDependencies: { Domain, StateMachine, Billing, Repositories },
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
            inbound.platformUserId,
            TelegramInboundMapper
          ) as TelegramCommand
        );
        if (inbound.payload?.action === "confirm_order") {
          commands = commands.filter((command) => command.method !== "sendPhoto");
          commands.push({
            method: "sendMessage",
            params: {
              chat_id: inbound.platformUserId,
              text: "Đơn đã được xác nhận. Nhân viên đang chuẩn bị món. Bạn có thể gửi /thanhtoan để nhận QR, hoặc chờ nhân viên gửi khi đơn sẵn sàng."
            }
          });
        }
      } catch (error) {
        const userError = error as { customerMessage?: unknown };
        if (typeof userError.customerMessage !== "string") throw error;
        commands = [{
          method: "sendMessage",
          params: { chat_id: inbound.platformUserId, text: userError.customerMessage }
        }];
      }

      const snapshot = this.createSnapshot(update.update_id);
      if (snapshot) {
        this.enqueueQueueMessage(
          `snapshot:${snapshot.snapshotId}`,
          { kind: "fast_path_sync", ...snapshot }
        );
      }
      const awaiting = snapshot?.orders.find((order) => order.status === "AWAITING_PAYMENT");
      if (reservationId) {
        if (awaiting) {
          const orderId = String(awaiting.orderId);
          this.ctx.storage.sql.exec(
            `INSERT INTO order_inventory_links(order_id, reservation_id) VALUES (?, ?)
             ON CONFLICT(order_id) DO UPDATE SET reservation_id = excluded.reservation_id`,
            orderId,
            reservationId
          );
          this.enqueueInventoryEffect(
            `commit-reservation:${reservationId}`,
            "COMMIT_RESERVATION",
            reservationId,
            orderId
          );
        } else {
          this.enqueueInventoryEffect(
            `release-reservation:${reservationId}`,
            "RELEASE_RESERVATION",
            reservationId,
            null
          );
        }
      }
      for (const order of snapshot?.orders ?? []) {
        if (order.status === "CANCELLED" || order.status === "EXPIRED") {
          this.enqueueInventoryEffect(
            `release-order:${String(order.orderId)}`,
            "RELEASE_ORDER",
            null,
            String(order.orderId)
          );
        }
      }
      if (inbound.payload?.action === "confirm_order" && reservationId && awaiting) {
        this.enqueueOperationsOrder(update.update_id, inbound.platformUserId, awaiting);
      }
      this.storeProcessed(updateId, commands, false);
      return {
        updateId: update.update_id,
        duplicate: false,
        ignored: false,
        commands,
        domainDurationMs: Date.now() - startedAt,
        snapshot
      };
      });
    } catch (error) {
      if (reservationId) {
        this.enqueueInventoryEffect(
          `release-reservation:${reservationId}`,
          "RELEASE_RESERVATION",
          reservationId,
          null
        );
        await this.drainDurableEffectsBestEffort();
      }
      throw error;
    }
    await this.drainDurableEffectsBestEffort();
    return result;
  }

  async confirmPayment(orderId: string, confirmedBy: string): Promise<PaymentResolution> {
    return this.resolvePayment(orderId, "confirm", confirmedBy);
  }

  async requestPaymentQr(
    orderId: string | null,
    config: FastPathConfig
  ): Promise<PaymentQrRequest> {
    requireFastPathConfig(config);
    const row = orderId
      ? this.ctx.storage.sql.exec<{ record_json: string }>(
          "SELECT record_json FROM orders WHERE order_id = ?",
          orderId
        ).toArray()[0]
      : this.ctx.storage.sql.exec<{ record_json: string }>(
          "SELECT record_json FROM orders ORDER BY created_at DESC LIMIT 1"
        ).toArray()[0];
    if (!row) {
      return { outcome: "not_found", orderId: orderId ?? "", status: null, qrUrl: null };
    }
    const order = parseRecord(row.record_json);
    const resolvedOrderId = String(order.orderId);
    const status = String(order.status);
    if (status !== "AWAITING_PAYMENT") {
      return { outcome: "already_resolved", orderId: resolvedOrderId, status, qrUrl: null };
    }
    return {
      outcome: "ready",
      orderId: resolvedOrderId,
      status,
      qrUrl: paymentQr(config, order)
    };
  }

  async expirePayment(orderId: string): Promise<PaymentResolution> {
    return this.resolvePayment(orderId, "expire", "system:durable-object-alarm");
  }

  async flushOutbox(outboxId: string): Promise<{
    delivered: boolean; error: string | null;
  }> {
    const row = this.ctx.storage.sql.exec<{
      commands_json: string;
      snapshot_json: string;
      delivered: number;
      attempts: number;
    }>(
      `SELECT commands_json, snapshot_json, delivered, attempts
       FROM notification_outbox WHERE outbox_id = ?`,
      outboxId
    ).toArray()[0];
    if (!row || row.delivered === 1) {
      await this.scheduleNextAlarm();
      return { delivered: true, error: null };
    }
    const commands = JSON.parse(row.commands_json) as TelegramCommand[];
    const progress = this.ctx.storage.sql.exec<{ next_command_index: number }>(
      "SELECT next_command_index FROM notification_progress WHERE outbox_id = ?",
      outboxId
    ).toArray()[0];
    const startIndex = progress?.next_command_index ?? 0;
    try {
      await this.drainQueueOutbox();
      for (let index = startIndex; index < commands.length; index += 1) {
        const command = commands[index];
        const response = await fetch(
          `https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/${command.method}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(command.params),
            signal: AbortSignal.timeout(5_000)
          }
        );
        const payload = await response.json<Record<string, unknown>>().catch(() => null);
        if (!response.ok || !payload || payload.ok !== true) {
          const description = payload && typeof payload.description === "string"
            ? payload.description
            : `HTTP ${response.status}`;
          throw new Error(`Telegram ${command.method} failed: ${description}`);
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO notification_progress(outbox_id, next_command_index) VALUES (?, ?)
           ON CONFLICT(outbox_id) DO UPDATE SET next_command_index = excluded.next_command_index`,
          outboxId,
          index + 1
        );
      }
    } catch (error) {
      const attempts = row.attempts + 1;
      const delayMs = Math.min(60_000, Math.pow(2, attempts) * 1_000);
      const message = error instanceof Error ? error.message : String(error);
      this.ctx.storage.sql.exec(
        `UPDATE notification_outbox
         SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE outbox_id = ?`,
        attempts,
        Date.now() + delayMs,
        message,
        outboxId
      );
      await this.scheduleNextAlarm();
      return {
        delivered: false,
        error: message
      };
    }
    this.ctx.storage.sql.exec(
      `UPDATE notification_outbox
       SET delivered = 1, next_attempt_at = 0, last_error = NULL WHERE outbox_id = ?`,
      outboxId
    );
    await this.scheduleNextAlarm();
    return { delivered: true, error: null };
  }

  async alarm(): Promise<void> {
    await this.drainDurableEffectsBestEffort();
    const pendingOutbox = this.ctx.storage.sql.exec<{ outbox_id: string }>(
      `SELECT outbox_id FROM notification_outbox
       WHERE delivered = 0 AND next_attempt_at <= ? ORDER BY created_at LIMIT 1`,
      Date.now()
    ).toArray()[0];
    if (pendingOutbox) {
      const delivery = await this.flushOutbox(pendingOutbox.outbox_id);
      if (!delivery.delivered) {
        console.error(JSON.stringify({
          event: "telegram_notification_outbox_pending",
          outboxId: pendingOutbox.outbox_id,
          error: delivery.error
        }));
      }
    }
    const awaiting = this.ctx.storage.sql.exec<{ record_json: string }>(
      "SELECT record_json FROM orders ORDER BY created_at DESC"
    ).toArray().map((row) => parseRecord(row.record_json))
      .find((order) => order.status === "AWAITING_PAYMENT");
    if (awaiting) {
      const timeout = Number(this.env.PAYMENT_TIMEOUT_MINUTES || "30");
      const dueAt = new Date(String(awaiting.createdAt)).getTime() + timeout * 60_000;
      if (dueAt <= Date.now()) {
        const resolution = await this.expirePayment(String(awaiting.orderId));
        if (resolution.outboxId) {
          const delivery = await this.flushOutbox(resolution.outboxId);
          if (!delivery.delivered) {
            console.error(JSON.stringify({
              event: "telegram_expiry_notification_pending",
              orderId: String(awaiting.orderId),
              error: delivery.error
            }));
          }
        }
      }
    }
    await this.scheduleNextAlarm();
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
        outcome: "not_found" as const, orderId, status: null, outboxId: null,
        deliveryStatus: null
      };
      if (existing.status !== "AWAITING_PAYMENT") {
        const linkedOutbox = this.ctx.storage.sql.exec<{
          outbox_id: string; delivered: number;
        }>(
          `SELECT links.outbox_id, outbox.delivered
           FROM order_outboxes links
           JOIN notification_outbox outbox ON outbox.outbox_id = links.outbox_id
           WHERE links.order_id = ?`,
          orderId
        ).toArray()[0];
        return {
          outcome: "already_resolved" as const,
          orderId,
          status: String(existing.status),
          outboxId: linkedOutbox?.delivered === 0 ? linkedOutbox.outbox_id : null,
          deliveryStatus: linkedOutbox
            ? linkedOutbox.delivered === 1 ? "delivered" as const : "pending" as const
            : null
        };
      }
      const service = (OrderService as any).create({
        coreDependencies: { Domain, StateMachine, Billing, Repositories },
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
      }>).map((message) => TelegramOutboundRenderer.renderOutboundMessage(
        message,
        chatId,
        TelegramInboundMapper
      ));
      const snapshot = this.createSnapshot(0);
      if (!snapshot) throw new Error("Payment resolution snapshot is unavailable");
      const outboxId = crypto.randomUUID();
      this.enqueueQueueMessage(
        `snapshot:${snapshot.snapshotId}`,
        { kind: "fast_path_sync", ...snapshot }
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO notification_outbox(outbox_id, commands_json, snapshot_json, delivered, created_at)
         VALUES (?, ?, ?, 0, ?)`,
        outboxId,
        JSON.stringify(commands),
        JSON.stringify(snapshot),
        new Date().toISOString()
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO order_outboxes(order_id, outbox_id) VALUES (?, ?)
         ON CONFLICT(order_id) DO UPDATE SET outbox_id = excluded.outbox_id`,
        orderId,
        outboxId
      );
      if (action === "expire") {
        this.enqueueInventoryEffect(
          `release-order:${orderId}`,
          "RELEASE_ORDER",
          null,
          orderId
        );
      }
      return {
        outcome: "resolved" as const,
        orderId,
        status: action === "confirm" ? "PAID" : "EXPIRED",
        outboxId,
        deliveryStatus: "pending" as const
      };
    });
    await this.drainDurableEffectsBestEffort();
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
    if (record.currentState !== "CONFIRMING") return [];
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
    const rows = await this.env.CATALOG_DB.prepare(
      "SELECT status, order_id AS orderId FROM inventory_reservations WHERE reservation_id = ?"
    ).bind(reservationId).all<{ status: string; orderId: string | null }>();
    if (!rows.results.length || rows.results.some((row) =>
      row.status !== "COMMITTED" || row.orderId !== orderId
    )) {
      throw new Error(`Inventory reservation ${reservationId} could not be committed`);
    }
  }

  private async releaseReservation(reservationId: string): Promise<void> {
    await this.releaseInventory("reservation", reservationId);
  }

  private async releaseOrderInventory(orderId: string): Promise<void> {
    const link = this.ctx.storage.sql.exec<{ reservation_id: string }>(
      "SELECT reservation_id FROM order_inventory_links WHERE order_id = ?",
      orderId
    ).toArray()[0];
    if (link) await this.releaseInventory("reservation", link.reservation_id);
    else await this.releaseInventory("order", orderId);
  }

  private async releaseInventory(scope: "reservation" | "order", value: string): Promise<void> {
    const now = new Date().toISOString();
    const column = scope === "reservation" ? "reservation_id" : "order_id";
    await this.env.CATALOG_DB.batch([
      this.env.CATALOG_DB.prepare(
        `UPDATE daily_inventory
         SET remaining_quantity = remaining_quantity + COALESCE((
           SELECT SUM(r.quantity) FROM inventory_reservations r
           WHERE r.${column} = ? AND r.status != 'RELEASED'
             AND r.product_id = daily_inventory.product_id
             AND r.business_date = daily_inventory.business_date
         ), 0), updated_at = ?
         WHERE EXISTS (
           SELECT 1 FROM inventory_reservations r
           WHERE r.${column} = ? AND r.status != 'RELEASED'
             AND r.product_id = daily_inventory.product_id
             AND r.business_date = daily_inventory.business_date
         )`
      ).bind(value, now, value),
      this.env.CATALOG_DB.prepare(
        `UPDATE inventory_reservations SET status = 'RELEASED', updated_at = ?
         WHERE ${column} = ? AND status != 'RELEASED'`
      ).bind(now, value)
    ]);
  }

  private enqueueInventoryEffect(
    effectId: string,
    effectType: "COMMIT_RESERVATION" | "RELEASE_RESERVATION" | "RELEASE_ORDER",
    reservationId: string | null,
    orderId: string | null
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO inventory_effects(
         effect_id, effect_type, reservation_id, order_id, status, attempts,
         next_attempt_at, lease_until, created_at
       ) VALUES (?, ?, ?, ?, 'PENDING', 0, 0, NULL, ?)`,
      effectId,
      effectType,
      reservationId,
      orderId,
      new Date().toISOString()
    );
  }

  private enqueueQueueMessage(messageId: string, body: JsonRecord): void {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO queue_outbox(
         message_id, body_json, published, attempts, next_attempt_at, lease_until, created_at
       ) VALUES (?, ?, 0, 0, 0, NULL, ?)`,
      messageId,
      JSON.stringify(body),
      new Date().toISOString()
    );
  }

  private enqueueOperationsOrder(updateId: number, chatId: string, order: JsonRecord): void {
    this.enqueueQueueMessage(`operations-order:${String(order.orderId)}`, {
      kind: "operations_order",
      updateId,
      chatId,
      order: {
        orderId: String(order.orderId),
        items: (order.items as JsonRecord[]).map((item) => ({
          name: String(item.name),
          quantity: Number(item.quantity),
          unitPrice: Number(item.unitPrice)
        })),
        totalAmount: Number(order.totalAmount)
      }
    });
  }

  private claimInventoryEffect(): {
    effect_id: string;
    effect_type: "COMMIT_RESERVATION" | "RELEASE_RESERVATION" | "RELEASE_ORDER";
    reservation_id: string | null;
    order_id: string | null;
    attempts: number;
  } | null {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const row = this.ctx.storage.sql.exec<{
        effect_id: string;
        effect_type: "COMMIT_RESERVATION" | "RELEASE_RESERVATION" | "RELEASE_ORDER";
        reservation_id: string | null;
        order_id: string | null;
        attempts: number;
      }>(
        `SELECT effect_id, effect_type, reservation_id, order_id, attempts
         FROM inventory_effects
         WHERE (status = 'PENDING' AND next_attempt_at <= ?)
            OR (status = 'PROCESSING' AND lease_until < ?)
         ORDER BY created_at LIMIT 1`,
        now,
        now
      ).toArray()[0];
      if (!row) return null;
      this.ctx.storage.sql.exec(
        `UPDATE inventory_effects
         SET status = 'PROCESSING', lease_until = ? WHERE effect_id = ?`,
        now + 30_000,
        row.effect_id
      );
      return row;
    });
  }

  private async drainInventoryEffects(): Promise<void> {
    for (;;) {
      const effect = this.claimInventoryEffect();
      if (!effect) return;
      try {
        if (effect.effect_type === "COMMIT_RESERVATION") {
          if (!effect.reservation_id || !effect.order_id) throw new Error("Invalid commit effect");
          await this.commitReservation(effect.reservation_id, effect.order_id);
        } else if (effect.effect_type === "RELEASE_RESERVATION") {
          if (!effect.reservation_id) throw new Error("Invalid reservation release effect");
          await this.releaseReservation(effect.reservation_id);
        } else {
          if (!effect.order_id) throw new Error("Invalid order release effect");
          await this.releaseOrderInventory(effect.order_id);
        }
        this.ctx.storage.sql.exec(
          `UPDATE inventory_effects
           SET status = 'DONE', lease_until = NULL, last_error = NULL WHERE effect_id = ?`,
          effect.effect_id
        );
      } catch (error) {
        const attempts = effect.attempts + 1;
        const delayMs = Math.min(60_000, Math.pow(2, attempts) * 1_000);
        this.ctx.storage.sql.exec(
          `UPDATE inventory_effects
           SET status = 'PENDING', attempts = ?, next_attempt_at = ?, lease_until = NULL,
               last_error = ? WHERE effect_id = ?`,
          attempts,
          Date.now() + delayMs,
          error instanceof Error ? error.message : String(error),
          effect.effect_id
        );
        throw error;
      }
    }
  }

  private async drainQueueOutbox(): Promise<void> {
    for (;;) {
      const row = this.ctx.storage.transactionSync(() => {
        const now = Date.now();
        const candidate = this.ctx.storage.sql.exec<{
          message_id: string; body_json: string; attempts: number;
        }>(
          `SELECT message_id, body_json, attempts FROM queue_outbox
           WHERE published = 0 AND next_attempt_at <= ?
             AND (lease_until IS NULL OR lease_until < ?)
           ORDER BY created_at LIMIT 1`,
          now,
          now
        ).toArray()[0];
        if (!candidate) return null;
        this.ctx.storage.sql.exec(
          "UPDATE queue_outbox SET lease_until = ? WHERE message_id = ?",
          now + 30_000,
          candidate.message_id
        );
        return candidate;
      });
      if (!row) return;
      try {
        await this.env.FAST_PATH_SYNC.send(parseRecord(row.body_json));
        this.ctx.storage.sql.exec(
          `UPDATE queue_outbox
           SET published = 1, lease_until = NULL, last_error = NULL WHERE message_id = ?`,
          row.message_id
        );
      } catch (error) {
        const attempts = row.attempts + 1;
        const delayMs = Math.min(60_000, Math.pow(2, attempts) * 1_000);
        this.ctx.storage.sql.exec(
          `UPDATE queue_outbox
           SET attempts = ?, next_attempt_at = ?, lease_until = NULL, last_error = ?
           WHERE message_id = ?`,
          attempts,
          Date.now() + delayMs,
          error instanceof Error ? error.message : String(error),
          row.message_id
        );
        throw error;
      }
    }
  }

  private async drainDurableEffectsBestEffort(): Promise<void> {
    try {
      await this.drainInventoryEffects();
    } catch (error) {
      console.error(JSON.stringify({
        event: "telegram_inventory_effect_pending",
        error: error instanceof Error ? error.message : String(error)
      }));
    }
    try {
      await this.drainQueueOutbox();
    } catch (error) {
      console.error(JSON.stringify({
        event: "telegram_queue_outbox_pending",
        error: error instanceof Error ? error.message : String(error)
      }));
    }
    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm(): Promise<void> {
    const now = Date.now();
    const candidates: number[] = [];
    const inventory = this.ctx.storage.sql.exec<{ due: number | null }>(
      `SELECT MIN(CASE WHEN status = 'PROCESSING' THEN lease_until ELSE next_attempt_at END) AS due
       FROM inventory_effects WHERE status != 'DONE'`
    ).one();
    if (inventory.due != null) candidates.push(Math.max(now + 1_000, inventory.due));
    const queued = this.ctx.storage.sql.exec<{ due: number | null }>(
      `SELECT MIN(CASE
         WHEN lease_until IS NOT NULL AND lease_until > next_attempt_at THEN lease_until
         ELSE next_attempt_at
       END) AS due FROM queue_outbox WHERE published = 0`
    ).one();
    if (queued.due != null) candidates.push(Math.max(now + 1_000, queued.due));
    const pendingNotification = this.ctx.storage.sql.exec<{ due: number | null }>(
      "SELECT MIN(next_attempt_at) AS due FROM notification_outbox WHERE delivered = 0"
    ).one();
    if (pendingNotification.due != null) {
      candidates.push(Math.max(now + 1_000, pendingNotification.due));
    }
    const awaiting = this.ctx.storage.sql.exec<{ record_json: string }>(
      "SELECT record_json FROM orders ORDER BY created_at DESC"
    ).toArray().map((row) => parseRecord(row.record_json))
      .find((order) => order.status === "AWAITING_PAYMENT");
    if (awaiting) {
      const timeout = Number(this.env.PAYMENT_TIMEOUT_MINUTES || "30");
      const dueAt = new Date(String(awaiting.createdAt)).getTime() + timeout * 60_000;
      if (Number.isFinite(dueAt)) candidates.push(Math.max(now + 1_000, dueAt));
    }
    if (candidates.length) await this.ctx.storage.setAlarm(Math.min(...candidates));
    else await this.ctx.storage.deleteAlarm();
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
            [{ text: "✏️ Sửa tên / giá", callback_data: "admin_edit" }],
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
    if (command === "/suamon" || action === "admin_edit") {
      const productId = text.split(/\s+/)[1];
      if (!productId) {
        return this.adminMessage(chatId, "Cú pháp: /suamon PRODUCT_ID\nDùng /kho để xem PRODUCT_ID.");
      }
      const product = await this.env.CATALOG_DB.prepare(
        "SELECT name, price FROM products WHERE product_id = ?"
      ).bind(productId).first<{ name: string; price: number }>();
      if (!product) return this.adminMessage(chatId, "Không tìm thấy món. Dùng /kho để kiểm tra PRODUCT_ID.");
      this.saveAdminDraft(chatId, "EDIT_NAME", {
        productId,
        currentName: product.name,
        currentPrice: product.price
      });
      return this.adminMessage(
        chatId,
        `Đang sửa ${productId}\nTên hiện tại: ${product.name}\nNhập tên mới, hoặc gửi - để giữ nguyên.`
      );
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

    if (draft?.step === "EDIT_NAME") {
      const name = text === "-" ? String(draft.data.currentName) : text.trim();
      if (!name) return this.adminMessage(chatId, "Tên món không được để trống. Nhập tên mới hoặc gửi - để giữ nguyên.");
      this.saveAdminDraft(chatId, "EDIT_PRICE", { ...draft.data, name });
      return this.adminMessage(
        chatId,
        `Giá hiện tại: ${Number(draft.data.currentPrice).toLocaleString("vi-VN")} đ\nNhập giá mới (chỉ nhập số), hoặc gửi - để giữ nguyên.`
      );
    }
    if (draft?.step === "EDIT_PRICE") {
      const price = text === "-"
        ? Number(draft.data.currentPrice)
        : Number(text.replace(/[^0-9]/g, ""));
      if (!Number.isInteger(price) || price <= 0) {
        return this.adminMessage(chatId, "Giá không hợp lệ. Ví dụ: 32000, hoặc gửi - để giữ nguyên.");
      }
      const productId = String(draft.data.productId);
      const result = await this.env.CATALOG_DB.prepare(
        "UPDATE products SET name = ?, price = ?, updated_at = ? WHERE product_id = ?"
      ).bind(String(draft.data.name), price, new Date().toISOString(), productId).run();
      if (!result.meta.changes) {
        this.clearAdminDraft(chatId);
        return this.adminMessage(chatId, "Món không còn tồn tại. Dùng /kho để kiểm tra lại.");
      }
      this.clearAdminDraft(chatId);
      return this.adminMessage(
        chatId,
        `Đã cập nhật ${productId}\nTên: ${draft.data.name}\nGiá: ${price.toLocaleString("vi-VN")} đ`
      );
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

  private nextRevision(): number {
    return this.ctx.storage.sql.exec<{ revision: number }>(
      `UPDATE sync_metadata SET revision = revision + 1 WHERE singleton = 1
       RETURNING revision`
    ).one().revision;
  }

  private createSnapshot(updateId: number): FastPathSnapshot | null {
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
      schemaVersion: 2,
      snapshotId: crypto.randomUUID(),
      customerId,
      revision: this.nextRevision(),
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
