import { createExecutionContext } from "cloudflare:test";
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
    PUBLIC_WEBHOOK_URL: "https://gateway.example/webhook",
  };
  return { environment, queued, dlqMetrics };
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
    expect(queued).toEqual([{ update_id: 10, message: { chat: { id: 7 }, text: "catalog" } }]);
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

describe("GAS queue consumer", () => {
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
      url: "https://gateway.example/webhook",
      drop_pending_updates: false,
      secret_token: "telegram-secret",
    }));
  });
});
