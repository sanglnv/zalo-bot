import { createExecutionContext, env as workerEnv } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type TelegramUpdate } from "../src/index";

const emptyMetrics = {
  backlogCount: 0,
  backlogBytes: 0,
  oldestMessageTimestamp: undefined,
};

function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  return Boolean(
    value &&
    typeof value === "object" &&
    Number.isInteger((value as Record<string, unknown>).update_id)
  );
}

function fixture(options: { queueFailure?: boolean; dlqBacklog?: number } = {}) {
  const queued: TelegramUpdate[] = [];
  const synced: unknown[] = [];
  const queue: Queue = {
    async send(update) {
      if (options.queueFailure) throw new Error("queue unavailable");
      if (!isTelegramUpdate(update)) throw new Error("invalid update fixture");
      queued.push(structuredClone(update));
      return { metadata: { metrics: emptyMetrics } };
    },
    async sendBatch() {
      throw new Error("sendBatch is not used by this worker");
    },
    async metrics() { return emptyMetrics; },
  };
  const dlqMetrics = vi.fn(async () => ({
    ...emptyMetrics,
    backlogCount: options.dlqBacklog ?? 0,
  }));
  const dlq: Queue = {
    async send() { throw new Error("DLQ producer is metrics-only"); },
    async sendBatch() { throw new Error("DLQ producer is metrics-only"); },
    metrics: dlqMetrics,
  };
  const environment: Env = {
    TELEGRAM_UPDATES: queue,
    TELEGRAM_DLQ: dlq,
    TELEGRAM_WEBHOOK_SECRET: "telegram-secret",
    TELEGRAM_BOT_TOKEN: "bot-token",
    GAS_WEB_APP_URL: "https://script.google.com/macros/s/deployment/exec",
    GAS_GATEWAY_TOKEN: "gas-secret",
    TELEGRAM_OPERATIONS_CHAT_ID: "operations-chat",
    PUBLIC_WEBHOOK_URL: "https://zalo-clawbot-telegram-gateway.sunka-bot.workers.dev",
    FAST_PATH_ENABLED: "true",
    PAYMENT_TIMEOUT_MINUTES: "30",
    TELEGRAM_SESSIONS: workerEnv.TELEGRAM_SESSIONS,
    CATALOG_DB: workerEnv.CATALOG_DB,
    FAST_PATH_SYNC: {
      async send(snapshot) {
        synced.push(structuredClone(snapshot));
        return { metadata: { metrics: emptyMetrics } };
      },
      async sendBatch() { throw new Error("sendBatch is not used by this worker"); },
      async metrics() { return emptyMetrics; },
    },
  };
  return { environment, queued, synced, dlqMetrics };
}

function webhookRequest(body: unknown, secret = "telegram-secret") {
  return new Request("https://gateway.example/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret,
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Telegram webhook ingress", () => {
  it("rejects non-POST and requests with an invalid secret", async () => {
    const { environment } = fixture();
    const ctx = createExecutionContext();
    expect((await worker.fetch(new Request("https://gateway.example"), environment, ctx)).status).toBe(405);
    expect((await worker.fetch(webhookRequest({ update_id: 1 }, "wrong"), environment, ctx)).status).toBe(401);
  });

  it("rejects invalid JSON and payloads without an integer update id", async () => {
    const { environment } = fixture();
    const invalidJson = new Request("https://gateway.example/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "telegram-secret" },
      body: "{bad",
    });
    expect((await worker.fetch(invalidJson, environment, createExecutionContext())).status).toBe(400);
    expect((await worker.fetch(webhookRequest({ message: {} }), environment, createExecutionContext())).status).toBe(400);
  });

  it("durably enqueues a valid update before returning OK", async () => {
    const { environment, queued } = fixture();
    const response = await worker.fetch(
      webhookRequest({ update_id: 10, message: { chat: { id: 7 }, text: "catalog" } }),
      environment,
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
    expect(queued).toEqual([expect.objectContaining({
      update_id: 10,
      message: { chat: { id: 7 }, text: "catalog" },
      _gateway_trace: expect.objectContaining({
        receivedAtMs: expect.any(Number),
        authenticatedAtMs: expect.any(Number),
      }),
    })]);
  });

  it("answers callback queries at the edge and marks them for GAS", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
    const { environment, queued } = fixture();
    const response = await worker.fetch(
      webhookRequest({ update_id: 11, callback_query: { id: "callback-1" } }),
      environment,
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
    expect(queued[0]._gateway_callback_answered).toBe(true);
    expect(queued[0]._gateway_trace).toEqual(expect.objectContaining({
      receivedAtMs: expect.any(Number),
      authenticatedAtMs: expect.any(Number),
    }));
    expect(fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/answerCallbackQuery",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns 503 so Telegram retries when queue publishing fails", async () => {
    const { environment } = fixture({ queueFailure: true });
    const response = await worker.fetch(
      webhookRequest({ update_id: 12 }),
      environment,
      createExecutionContext(),
    );
    expect(response.status).toBe(503);
  });
});

describe("Telegram Durable Object fast path", () => {
  it("processes a pilot chat directly without publishing to the GAS queue", async () => {
    const telegramFetch = vi.fn(async () => Response.json({ ok: true, result: {} }));
    vi.stubGlobal("fetch", telegramFetch);
    await workerEnv.CATALOG_DB.exec(
      "CREATE TABLE IF NOT EXISTS categories (category_id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL, active INTEGER NOT NULL, updated_at TEXT NOT NULL)"
    );
    await workerEnv.CATALOG_DB.exec(
      "CREATE TABLE IF NOT EXISTS products (product_id TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL, is_available INTEGER NOT NULL, sort_order INTEGER NOT NULL, updated_at TEXT NOT NULL, category_id TEXT NOT NULL DEFAULT 'CAT_OTHER', category_name TEXT NOT NULL DEFAULT 'Khác')"
    );
    await workerEnv.CATALOG_DB.exec(
      "CREATE TABLE IF NOT EXISTS daily_inventory (product_id TEXT NOT NULL, business_date TEXT NOT NULL, initial_quantity INTEGER NOT NULL CHECK(initial_quantity >= 0), remaining_quantity INTEGER NOT NULL CHECK(remaining_quantity >= 0), active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, PRIMARY KEY(product_id, business_date))"
    );
    await workerEnv.CATALOG_DB.exec(
      "CREATE TABLE IF NOT EXISTS inventory_reservations (reservation_id TEXT NOT NULL, product_id TEXT NOT NULL, business_date TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0), status TEXT NOT NULL DEFAULT 'RESERVED', order_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(reservation_id, product_id))"
    );
    await workerEnv.CATALOG_DB.exec("DELETE FROM daily_inventory");
    await workerEnv.CATALOG_DB.exec("DELETE FROM inventory_reservations");
    await workerEnv.CATALOG_DB.exec("DELETE FROM products");
    await workerEnv.CATALOG_DB.exec("DELETE FROM categories");
    await workerEnv.CATALOG_DB.prepare(
      `INSERT INTO categories(category_id, name, sort_order, active, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind("CAT_CAFE", "CAFE", 1, 1, new Date().toISOString()).run();
    await workerEnv.CATALOG_DB.prepare(
      `INSERT INTO products(
         product_id, name, price, is_available, sort_order, updated_at, category_id, category_name
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      "p1", "Coffee", 35000, 1, 0, new Date().toISOString(), "CAT_CAFE", "CAFE"
    ).run();
    await workerEnv.CATALOG_DB.prepare(
      `INSERT INTO daily_inventory(
         product_id, business_date, initial_quantity, remaining_quantity, active, updated_at
       ) VALUES ('p1', date('now', '+7 hours'), 2, 2, 1, ?)`
    ).bind(new Date().toISOString()).run();
    const { environment, queued, synced } = fixture();
    const pilotEnvironment = {
      ...environment,
      FAST_PATH_ENABLED: "true",
      FAST_PATH_CHAT_IDS: "7001",
      TELEGRAM_ADMIN_CHAT_IDS: "7001",
      VIETQR_BANK_ID: "970422",
      VIETQR_ACCOUNT_NO: "123456789",
      VIETQR_ACCOUNT_NAME: "TEST SHOP",
      VIETQR_TEMPLATE: "compact2",
      VIETQR_TRANSFER_PREFIX: "DH",
    } as unknown as Env;

    const updates = [
      { update_id: 70010, message: { chat: { id: 7001 }, text: "catalog" } },
      {
        update_id: 70011,
        callback_query: {
          id: "cb-70011",
          data: "select_category:CAT_CAFE",
          message: { chat: { id: 7001 } },
        },
      },
      {
        update_id: 70012,
        callback_query: {
          id: "cb-70012",
          data: "view_product:p1",
          message: { chat: { id: 7001 } },
        },
      },
      {
        update_id: 70013,
        callback_query: {
          id: "cb-70013",
          data: "add_item:p1:2",
          message: { chat: { id: 7001 } },
        },
      },
      { update_id: 70014, message: { chat: { id: 7001 }, text: "checkout" } },
      {
        update_id: 70015,
        callback_query: {
          id: "cb-70015",
          data: "confirm_order",
          message: { chat: { id: 7001 } },
        },
      },
    ];

    for (const update of updates) {
      const response = await worker.fetch(
        webhookRequest(update), pilotEnvironment, createExecutionContext()
      );
      expect(response.status).toBe(200);
    }

    expect(queued).toEqual([]);
    const snapshots = synced.filter(
      (message) => (message as { kind?: string }).kind === "fast_path_sync"
    );
    const operations = synced.filter(
      (message) => (message as { kind?: string }).kind === "operations_order"
    );
    expect(snapshots).toHaveLength(6);
    expect(operations).toEqual([expect.objectContaining({
      kind: "operations_order",
      chatId: "7001",
      order: expect.objectContaining({
        items: [{ name: "Coffee", quantity: 2, unitPrice: 35000 }],
        totalAmount: 70000,
      }),
    })]);
    expect(snapshots.at(-1)).toEqual(expect.objectContaining({
      kind: "fast_path_sync",
      updateId: 70015,
      orders: [expect.objectContaining({ status: "AWAITING_PAYMENT" })],
    }));
    const inventory = await workerEnv.CATALOG_DB.prepare(
      "SELECT remaining_quantity AS remainingQuantity FROM daily_inventory WHERE product_id = 'p1'"
    ).first<{ remainingQuantity: number }>();
    expect(inventory?.remainingQuantity).toBe(0);
    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/sendPhoto",
      expect.objectContaining({ method: "POST" }),
    );

    const orderId = (snapshots.at(-1) as { orders: Array<{ orderId: string }> }).orders[0].orderId;
    const paymentResponse = await worker.fetch(
      new Request("https://gateway.example/internal/payment", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-GAS-Gateway-Token": "gas-secret",
        },
        body: JSON.stringify({
          chatId: "7001", orderId, action: "confirm", actor: "staff@example.com",
        }),
      }),
      pilotEnvironment,
      createExecutionContext(),
    );
    expect(paymentResponse.status).toBe(200);
    expect(await paymentResponse.json()).toEqual(expect.objectContaining({
      handled: true, outcome: "resolved", status: "PAID",
    }));

    await worker.fetch(
      webhookRequest({ update_id: 70016, message: { chat: { id: 7001 }, text: "/admin" } }),
      pilotEnvironment,
      createExecutionContext(),
    );
    await worker.fetch(
      webhookRequest({ update_id: 70017, message: { chat: { id: 7001 }, text: "/ton p1 5" } }),
      pilotEnvironment,
      createExecutionContext(),
    );
    const adjusted = await workerEnv.CATALOG_DB.prepare(
      "SELECT remaining_quantity AS remainingQuantity FROM daily_inventory WHERE product_id = 'p1'"
    ).first<{ remainingQuantity: number }>();
    expect(adjusted?.remainingQuantity).toBe(5);
  });

  it("rejects unauthenticated internal payment operations", async () => {
    const { environment } = fixture();
    const response = await worker.fetch(
      new Request("https://gateway.example/internal/payment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatId: "1", orderId: "o1", action: "confirm" }),
      }),
      environment,
      createExecutionContext(),
    );
    expect(response.status).toBe(401);
  });

  it("keeps non-allowlisted chats on the durable Queue fallback", async () => {
    const { environment, queued } = fixture();
    const pilotEnvironment = {
      ...environment,
      FAST_PATH_ENABLED: "true",
      FAST_PATH_CHAT_IDS: "9999",
    } as unknown as Env;

    const response = await worker.fetch(
      webhookRequest({ update_id: 70020, message: { chat: { id: 7002 }, text: "catalog" } }),
      pilotEnvironment,
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(queued).toHaveLength(1);
  });
});

describe("GAS queue consumer", () => {
  it("notifies the employee group when a confirmed fast-path order arrives", async () => {
    const telegramFetch = vi.fn(async () => Response.json({ ok: true, result: {} }));
    vi.stubGlobal("fetch", telegramFetch);
    const { environment } = fixture();
    const ack = vi.fn();
    const retry = vi.fn();
    const message = {
      id: "operations-order-1",
      timestamp: new Date(),
      body: {
        kind: "operations_order",
        updateId: 31,
        chatId: "7001",
        order: {
          orderId: "DH31",
          items: [{ name: "Coffee", quantity: 2, unitPrice: 35000 }],
          totalAmount: 70000,
        },
      },
      attempts: 1,
      ack,
      retry,
    };
    const batch = {
      messages: [message],
      queue: "zalo-clawbot-fast-path-sync",
      metadata: { metrics: emptyMetrics },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    };

    await worker.queue(batch as never, environment);

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    const request = telegramFetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.chat_id).toBe("operations-chat");
    expect(body.text).toContain("🔔 ĐƠN MỚI #DH31");
    expect(body.text).toContain("Coffee × 2 — 70.000 đ");
    expect(body.text).toContain("Tổng: 70.000 đ");
  });

  it("forwards the original update with gateway authentication and acknowledges success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("OK", { status: 200 })));
    const { environment } = fixture();
    const ack = vi.fn();
    const retry = vi.fn();
    const message = {
      id: "message-20",
      timestamp: new Date(),
      body: { update_id: 20 },
      attempts: 1,
      ack,
      retry,
    } satisfies Message<TelegramUpdate>;
    const batch = {
      messages: [message],
      queue: "zalo-clawbot-telegram",
      metadata: { metrics: emptyMetrics },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } satisfies MessageBatch<TelegramUpdate>;
    await worker.queue(
      batch,
      environment,
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    const target = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
    expect(target.searchParams.get("platform")).toBe("telegram");
    expect(target.searchParams.get("gateway_token")).toBe("gas-secret");
  });

  it("retries failed GAS deliveries with bounded exponential backoff", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 503 })));
    const { environment } = fixture();
    const ack = vi.fn();
    const retry = vi.fn();
    const message = {
      id: "message-21",
      timestamp: new Date(),
      body: { update_id: 21 },
      attempts: 3,
      ack,
      retry,
    } satisfies Message<TelegramUpdate>;
    const batch = {
      messages: [message],
      queue: "zalo-clawbot-telegram",
      metadata: { metrics: emptyMetrics },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } satisfies MessageBatch<TelegramUpdate>;
    await worker.queue(
      batch,
      environment,
    );
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 8 });
  });

  it("retries a 2xx response that does not contain the authenticated acknowledgement", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("GATEWAY_AUTH_FAILED", { status: 200 })));
    const { environment } = fixture();
    const ack = vi.fn();
    const retry = vi.fn();
    const message = {
      id: "message-22",
      timestamp: new Date(),
      body: { update_id: 22 },
      attempts: 1,
      ack,
      retry,
    } satisfies Message<TelegramUpdate>;
    const batch = {
      messages: [message],
      queue: "zalo-clawbot-telegram",
      metadata: { metrics: emptyMetrics },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } satisfies MessageBatch<TelegramUpdate>;

    await worker.queue(batch, environment);

    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 2 });
  });
});

describe("DLQ monitoring", () => {
  it("checks realtime DLQ backlog on the scheduled trigger", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      if (String(input).includes("getWebhookInfo")) {
        return Response.json({
          ok: true,
          result: {
            url: "https://gateway.example/webhook",
            pending_update_count: 0,
          },
        });
      }
      return new Response("GATEWAY_OK", { status: 200 });
    }));
    const { environment, dlqMetrics } = fixture({ dlqBacklog: 2 });
    await worker.scheduled(
      { cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
      environment,
    );
    expect(dlqMetrics).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("telegram_dlq_not_empty"));
    expect(fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/sendMessage",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/getWebhookInfo",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("repairs Telegram webhook URL drift without dropping pending updates", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const responses = [
      Response.json({
        ok: true,
        result: {
          url: "https://script.google.com/macros/s/direct/exec?platform=telegram",
          pending_update_count: 0,
        },
      }),
      Response.json({ ok: true, result: true }),
      Response.json({
        ok: true,
        result: {
          url: "https://gateway.example/webhook",
          pending_update_count: 0,
        },
      }),
      new Response("GATEWAY_OK", { status: 200 }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));
    const { environment } = fixture();

    await worker.scheduled(
      { cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry: vi.fn() },
      environment,
    );

    const setWebhookCall = vi.mocked(fetch).mock.calls[1];
    expect(String(setWebhookCall[0])).toContain("/setWebhook");
    const options = setWebhookCall[1] as RequestInit;
    expect(JSON.parse(String(options.body))).toEqual(expect.objectContaining({
      url: environment.PUBLIC_WEBHOOK_URL,
      drop_pending_updates: false,
      secret_token: "telegram-secret",
    }));
  });
});
