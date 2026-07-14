import {
  TelegramSession,
  telegramChatId,
  type FastPathResult,
  type FastPathSnapshot
} from "./fastpath";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | { [key: string]: JsonValue | undefined } | JsonValue[];

export interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
  };
  _gateway_trace?: {
    receivedAtMs: number;
    authenticatedAtMs: number;
  };
  [key: string]: JsonValue | undefined;
}

const encoder = new TextEncoder();

type FastPathEnvironment = Omit<Env, "FAST_PATH_ENABLED"> & {
  TELEGRAM_SESSIONS: DurableObjectNamespace<TelegramSession>;
  FAST_PATH_ENABLED: string;
  FAST_PATH_CHAT_IDS?: string;
  TELEGRAM_ADMIN_CHAT_IDS?: string;
  CATALOG_DB: D1Database;
  FAST_PATH_SYNC: Queue<FastPathSyncMessage>;
  VIETQR_BANK_ID?: string;
  VIETQR_ACCOUNT_NO?: string;
  VIETQR_ACCOUNT_NAME?: string;
  VIETQR_TEMPLATE?: string;
  VIETQR_TRANSFER_PREFIX?: string;
};

interface FastPathSyncMessage extends FastPathSnapshot {
  kind: "fast_path_sync";
}

interface OperationsOrderMessage {
  kind: "operations_order";
  updateId: number;
  chatId: string;
  order: {
    orderId: string;
    items: Array<{ name: string; quantity: number; unitPrice: number }>;
    totalAmount: number;
  };
}

function isFastPathSyncMessage(value: unknown): value is FastPathSyncMessage {
  return Boolean(value && typeof value === "object" &&
    (value as { kind?: unknown }).kind === "fast_path_sync");
}

function isOperationsOrderMessage(value: unknown): value is OperationsOrderMessage {
  return Boolean(value && typeof value === "object" &&
    (value as { kind?: unknown }).kind === "operations_order");
}

function formatVnd(value: number): string {
  return new Intl.NumberFormat("vi-VN").format(value) + " đ";
}

function operationsOrderText(message: OperationsOrderMessage): string {
  const lines = message.order.items.map((item) =>
    `• ${item.name} × ${item.quantity} — ${formatVnd(item.unitPrice * item.quantity)}`
  );
  return [
    `🔔 ĐƠN MỚI #${message.order.orderId}`,
    `Khách Telegram: ${message.chatId}`,
    "",
    ...lines,
    "",
    `Tổng: ${formatVnd(message.order.totalAmount)}`,
    "Trạng thái: Chờ thanh toán"
  ].join("\n");
}

async function forwardFastPathSnapshot(
  message: Message<FastPathSyncMessage>,
  env: Env
): Promise<void> {
  const target = new URL(env.GAS_WEB_APP_URL);
  target.searchParams.set("platform", "telegram");
  target.searchParams.set("gateway_token", env.GAS_GATEWAY_TOKEN);
  target.searchParams.set("gateway_mode", "fast_path_sync");
  const response = await fetch(target.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message.body),
    redirect: "follow",
    signal: AbortSignal.timeout(60_000)
  });
  const body = (await response.text()).trim();
  if (!response.ok || body !== "SYNC_OK") {
    throw new Error(`GAS fast-path sync failed: HTTP ${response.status}, body ${JSON.stringify(body)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(
  level: "log" | "warn" | "error",
  event: string,
  details: Record<string, unknown> = {}
): void {
  console[level](JSON.stringify({ event, ...details }));
}

async function secretsEqual(
  supplied: string | null,
  expected: string
): Promise<boolean> {
  const [suppliedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied ?? "")),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);

  return crypto.subtle.timingSafeEqual(suppliedHash, expectedHash);
}

function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return Number.isInteger(candidate.update_id);
}

interface TelegramWebhookInfo {
  url: string;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
}

async function callTelegramApi(
  env: Env,
  method: "getWebhookInfo" | "setWebhook",
  params?: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    params ? {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(5_000)
    } : { signal: AbortSignal.timeout(5_000) }
  );
  const payload = await response.json<unknown>();
  const envelope = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : null;

  if (!response.ok || !envelope || envelope.ok !== true) {
    const description = envelope && typeof envelope.description === "string"
      ? envelope.description
      : `HTTP ${response.status}`;
    throw new Error(`Telegram ${method} failed: ${description}`);
  }

  return envelope.result;
}

function isTelegramWebhookInfo(value: unknown): value is TelegramWebhookInfo {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.url === "string" &&
    typeof candidate.pending_update_count === "number"
  );
}

async function inspectTelegramWebhook(env: Env): Promise<void> {
  const initialResult = await callTelegramApi(env, "getWebhookInfo");
  if (!isTelegramWebhookInfo(initialResult)) {
    throw new Error("Telegram getWebhookInfo returned an invalid result");
  }

  let result = initialResult;
  if (result.url !== env.PUBLIC_WEBHOOK_URL) {
    const changed = await callTelegramApi(env, "setWebhook", {
      url: env.PUBLIC_WEBHOOK_URL,
      allowed_updates: ["message", "callback_query"],
      max_connections: 1,
      drop_pending_updates: false,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET
    });
    if (changed !== true) {
      throw new Error("Telegram setWebhook did not confirm the change");
    }

    const confirmedResult = await callTelegramApi(env, "getWebhookInfo");
    if (!isTelegramWebhookInfo(confirmedResult) || confirmedResult.url !== env.PUBLIC_WEBHOOK_URL) {
      throw new Error("Telegram webhook URL still differs after reconciliation");
    }
    result = confirmedResult;
    log("warn", "telegram_webhook_repaired", {
      previousUrl: initialResult.url,
      url: result.url
    });
  }

  const details = {
    url: result.url,
    expectedUrl: env.PUBLIC_WEBHOOK_URL,
    pendingUpdates: result.pending_update_count,
    lastErrorDate: result.last_error_date ?? null,
    lastErrorMessage: result.last_error_message ?? null
  };

  if (result.pending_update_count > 0 || result.last_error_message) {
    log("warn", "telegram_webhook_degraded", details);
  } else {
    log("log", "telegram_webhook_healthy", details);
  }
}

async function inspectGasGateway(env: Env): Promise<void> {
  const target = new URL(env.GAS_WEB_APP_URL);
  target.searchParams.set("platform", "telegram");
  target.searchParams.set("gateway_token", env.GAS_GATEWAY_TOKEN);
  target.searchParams.set("gateway_probe", "1");

  const response = await fetch(target.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    redirect: "follow",
    signal: AbortSignal.timeout(15_000)
  });
  const body = await response.text();

  if (!response.ok || body.trim() !== "GATEWAY_OK") {
    throw new Error(`GAS gateway probe returned HTTP ${response.status} without acknowledgement`);
  }

  log("log", "gas_gateway_healthy");
}

async function sendOperationsAlert(env: Env, text: string): Promise<void> {
  const chatId = env.TELEGRAM_OPERATIONS_CHAT_ID;
  if (!chatId) {
    log("warn", "operations_alert_not_configured");
    return;
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(5_000)
    }
  );

  if (!response.ok) {
    throw new Error(`Operations alert returned HTTP ${response.status}`);
  }
}

async function answerCallback(
  update: TelegramUpdate,
  env: Env
): Promise<boolean> {
  const callbackId = update.callback_query?.id;
  if (!callbackId) return false;

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackId,
        text: "Đang xử lý…"
      }),
      signal: AbortSignal.timeout(3_000)
    }
  );

  return response.ok;
}

function fastPathEnabled(env: FastPathEnvironment, chatId: string | null): boolean {
  if (env.FAST_PATH_ENABLED !== "true" || !chatId) return false;
  const allowed = (env.FAST_PATH_CHAT_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return allowed.includes(chatId);
}

function telegramAdminEnabled(env: FastPathEnvironment, chatId: string): boolean {
  return (env.TELEGRAM_ADMIN_CHAT_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(chatId);
}

async function executeFastPathCommands(
  result: FastPathResult,
  env: FastPathEnvironment
): Promise<void> {
  for (const command of result.commands) {
    const response = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${command.method}`,
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
  }
}

async function handleFastPath(
  update: TelegramUpdate,
  chatId: string,
  env: FastPathEnvironment
): Promise<Response> {
  const startedAtMs = Date.now();
  const session = env.TELEGRAM_SESSIONS.getByName(chatId, {
    locationHint: "apac-se"
  });
  const result: FastPathResult = await session.process(update, {
    bankId: env.VIETQR_BANK_ID ?? "",
    accountNo: env.VIETQR_ACCOUNT_NO ?? "",
    accountName: env.VIETQR_ACCOUNT_NAME ?? "",
    template: env.VIETQR_TEMPLATE || "compact2",
    transferPrefix: env.VIETQR_TRANSFER_PREFIX || "DH"
  }, telegramAdminEnabled(env, chatId));
  log("log", "telegram_fast_path_domain_completed", {
    updateId: update.update_id,
    chatId,
    duplicate: result.duplicate,
    ignored: result.ignored,
    commandCount: result.commands.length,
    domainDurationMs: result.domainDurationMs
  });
  if (result.snapshot) {
    await env.FAST_PATH_SYNC.send({ kind: "fast_path_sync", ...result.snapshot });
  }
  const inboundAction = (update.callback_query as { data?: unknown } | undefined)?.data;
  if (!result.duplicate && inboundAction === "confirm_order" && result.snapshot) {
    const order = [...result.snapshot.orders].reverse().find(
      (candidate) => candidate.status === "AWAITING_PAYMENT"
    );
    if (order) {
      await env.FAST_PATH_SYNC.send({
        kind: "operations_order",
        updateId: update.update_id,
        chatId,
        order: {
          orderId: String(order.orderId),
          items: (order.items as Array<Record<string, unknown>>).map((item) => ({
            name: String(item.name),
            quantity: Number(item.quantity),
            unitPrice: Number(item.unitPrice)
          })),
          totalAmount: Number(order.totalAmount)
        }
      } satisfies OperationsOrderMessage);
    }
  }
  await executeFastPathCommands(result, env);
  const completedAtMs = Date.now();
  log("log", "telegram_fast_path_completed", {
    updateId: update.update_id,
    chatId,
    duplicate: result.duplicate,
    ignored: result.ignored,
    commandCount: result.commands.length,
    domainDurationMs: result.domainDurationMs,
    totalDurationMs: completedAtMs - startedAtMs
  });
  return new Response("OK", { status: 200 });
}

async function handlePaymentOperation(
  request: Request,
  env: FastPathEnvironment
): Promise<Response> {
  if (!(await secretsEqual(request.headers.get("X-GAS-Gateway-Token"), env.GAS_GATEWAY_TOKEN))) {
    return Response.json({ handled: false, error: "unauthorized" }, { status: 401 });
  }
  const payload = await request.json<{
    chatId?: unknown;
    orderId?: unknown;
    action?: unknown;
    actor?: unknown;
  }>();
  if (typeof payload.chatId !== "string" || typeof payload.orderId !== "string" ||
      (payload.action !== "confirm" && payload.action !== "expire")) {
    return Response.json({ handled: false, error: "invalid_request" }, { status: 400 });
  }
  const session = env.TELEGRAM_SESSIONS.getByName(payload.chatId, { locationHint: "apac-se" });
  const resolution = payload.action === "confirm"
    ? await session.confirmPayment(
      payload.orderId,
      typeof payload.actor === "string" && payload.actor ? payload.actor : "staff"
    )
    : await session.expirePayment(payload.orderId);
  if (resolution.outboxId) await session.flushOutbox(resolution.outboxId);
  log("log", "telegram_fast_path_payment_resolved", {
    action: payload.action,
    orderId: payload.orderId,
    chatId: payload.chatId,
    outcome: resolution.outcome,
    status: resolution.status
  });
  return Response.json({
    handled: resolution.outcome !== "not_found",
    ...resolution
  });
}

export default {
  async fetch(request: Request, env: Env, _ctx?: ExecutionContext): Promise<Response> {
    const receivedAtMs = Date.now();
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (new URL(request.url).pathname === "/internal/payment") {
      try {
        return await handlePaymentOperation(request, env as FastPathEnvironment);
      } catch (error) {
        log("error", "telegram_fast_path_payment_failed", { error: errorMessage(error) });
        return Response.json({ handled: false, error: "operation_failed" }, { status: 500 });
      }
    }

    const suppliedSecret = request.headers.get(
      "X-Telegram-Bot-Api-Secret-Token"
    );

    if (!(await secretsEqual(suppliedSecret, env.TELEGRAM_WEBHOOK_SECRET))) {
      log("warn", "telegram_webhook_rejected");
      return new Response("Unauthorized", { status: 401 });
    }
    const authenticatedAtMs = Date.now();

    let rawUpdate: unknown;

    try {
      rawUpdate = await request.json<unknown>();
    } catch (error) {
      log("warn", "telegram_webhook_invalid_json", {
        error: errorMessage(error)
      });
      return new Response("Invalid JSON", { status: 400 });
    }

    if (!isTelegramUpdate(rawUpdate)) {
      log("warn", "telegram_webhook_invalid_update");
      return new Response("Missing update_id", { status: 400 });
    }

    const update = rawUpdate;
    update._gateway_trace = { receivedAtMs, authenticatedAtMs };
    log("log", "telegram_received", {
      updateId: update.update_id,
      receivedAtMs
    });
    log("log", "worker_authenticated", {
      updateId: update.update_id,
      authenticatedAtMs,
      durationMs: authenticatedAtMs - receivedAtMs
    });

    // Stop the callback spinner at the edge, before waiting for a GAS cold start.
    try {
      if (await answerCallback(update, env)) {
        update._gateway_callback_answered = true;
      }
    } catch (error) {
      // GAS will answer the callback if the edge acknowledgement failed.
      log("warn", "telegram_callback_ack_failed", {
        updateId: update.update_id,
        error: errorMessage(error)
      });
    }

    const fastEnv = env as FastPathEnvironment;
    const chatId = telegramChatId(update);
    if (fastPathEnabled(fastEnv, chatId)) {
      try {
        return await handleFastPath(update, chatId!, fastEnv);
      } catch (error) {
        log("error", "telegram_fast_path_failed", {
          updateId: update.update_id,
          chatId,
          error: errorMessage(error)
        });
        // Telegram will retry. The Durable Object stores update idempotency and
        // the rendered commands, so domain mutations are never repeated.
        return new Response("Fast path unavailable", { status: 503 });
      }
    }

    // Return 200 only after Cloudflare has durably accepted the update.
    const queuePublishStartedAtMs = Date.now();
    try {
      await env.TELEGRAM_UPDATES.send(update);
    } catch (error) {
      // Telegram retries non-2xx webhook deliveries.
      log("error", "telegram_queue_publish_failed", {
        updateId: update.update_id,
        error: errorMessage(error)
      });
      return new Response("Queue unavailable", { status: 503 });
    }

    const queuePublishedAtMs = Date.now();
    log("log", "telegram_update_queued", {
      updateId: update.update_id,
      queuePublishedAtMs,
      durationMs: queuePublishedAtMs - queuePublishStartedAtMs,
      edgeTotalMs: queuePublishedAtMs - receivedAtMs
    });
    return new Response("OK", { status: 200 });
  },

  async queue(
    batch: MessageBatch<TelegramUpdate | FastPathSyncMessage | OperationsOrderMessage>,
    env: Env,
    _ctx?: ExecutionContext
  ): Promise<void> {
    for (const message of batch.messages) {
      if (isOperationsOrderMessage(message.body)) {
        try {
          await sendOperationsAlert(env, operationsOrderText(message.body));
          message.ack();
          log("log", "operations_order_notified", {
            updateId: message.body.updateId,
            orderId: message.body.order.orderId,
            attempt: message.attempts
          });
        } catch (error) {
          const delay = Math.min(60, Math.pow(2, message.attempts));
          log("error", "operations_order_notify_failed", {
            updateId: message.body.updateId,
            orderId: message.body.order.orderId,
            attempt: message.attempts,
            retryDelaySeconds: delay,
            error: errorMessage(error)
          });
          message.retry({ delaySeconds: delay });
        }
        continue;
      }
      if (isFastPathSyncMessage(message.body)) {
        try {
          await forwardFastPathSnapshot(message as Message<FastPathSyncMessage>, env);
          message.ack();
          log("log", "telegram_fast_path_synced", {
            updateId: message.body.updateId,
            attempt: message.attempts,
            orderCount: message.body.orders.length
          });
        } catch (error) {
          const delay = Math.min(60, Math.pow(2, message.attempts));
          log("error", "telegram_fast_path_sync_failed", {
            updateId: message.body.updateId,
            attempt: message.attempts,
            retryDelaySeconds: delay,
            error: errorMessage(error)
          });
          message.retry({ delaySeconds: delay });
        }
        continue;
      }
      const queueReceivedAtMs = Date.now();
      log("log", "queue_received", {
        updateId: message.body.update_id,
        attempt: message.attempts,
        queueReceivedAtMs,
        queueWaitMs: Math.max(0, queueReceivedAtMs - message.timestamp.getTime()),
        endToEndSoFarMs: message.body._gateway_trace
          ? Math.max(0, queueReceivedAtMs - message.body._gateway_trace.receivedAtMs)
          : null
      });
      const target = new URL(env.GAS_WEB_APP_URL);
      target.searchParams.set("platform", "telegram");
      target.searchParams.set("gateway_token", env.GAS_GATEWAY_TOKEN);

      try {
        const gasForwardStartedAtMs = Date.now();
        const response = await fetch(target.toString(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(message.body),
          redirect: "follow",
          signal: AbortSignal.timeout(60_000)
        });

        const responseBody = (await response.text()).trim();
        if (!response.ok || responseBody !== "OK") {
          throw new Error(
            `GAS acknowledgement failed: HTTP ${response.status}, body ${JSON.stringify(responseBody)}`
          );
        }

        message.ack();
        const gasForwardCompletedAtMs = Date.now();
        log("log", "telegram_update_forwarded", {
          updateId: message.body.update_id,
          attempt: message.attempts,
          gasForwardStartedAtMs,
          gasForwardCompletedAtMs,
          gasRoundTripMs: gasForwardCompletedAtMs - gasForwardStartedAtMs,
          endToEndMs: message.body._gateway_trace
            ? Math.max(0, gasForwardCompletedAtMs - message.body._gateway_trace.receivedAtMs)
            : null
        });
      } catch (error) {
        const delay = Math.min(60, Math.pow(2, message.attempts));

        log("error", "telegram_update_forward_failed", {
          updateId: message.body.update_id,
          attempt: message.attempts,
          retryDelaySeconds: delay,
          error: errorMessage(error)
        });
        message.retry({ delaySeconds: delay });
      }
    }
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx?: ExecutionContext
  ): Promise<void> {
    try {
      const metrics = await env.TELEGRAM_DLQ.metrics();
      const details = {
        backlogCount: metrics.backlogCount,
        backlogBytes: metrics.backlogBytes,
        oldestMessageTimestamp:
          metrics.oldestMessageTimestamp?.toISOString() ?? null
      };

      if (metrics.backlogCount > 0) {
        log("error", "telegram_dlq_not_empty", details);
        try {
          await sendOperationsAlert(
            env,
            `Zalo Clawbot: Telegram DLQ có ${metrics.backlogCount} message. ` +
              "Kiểm tra Worker logs và xử lý trong vòng 4 ngày."
          );
        } catch (error) {
          log("error", "operations_alert_failed", { error: errorMessage(error) });
        }
      } else {
        log("log", "telegram_dlq_healthy", details);
      }
    } catch (error) {
      log("error", "telegram_dlq_metrics_failed", {
        error: errorMessage(error)
      });
    }

    try {
      await inspectTelegramWebhook(env);
    } catch (error) {
      log("error", "telegram_webhook_healthcheck_failed", {
        error: errorMessage(error)
      });
    }

    try {
      await inspectGasGateway(env);
    } catch (error) {
      log("error", "gas_gateway_healthcheck_failed", {
        error: errorMessage(error)
      });
    }
  }
} satisfies ExportedHandler<Env, TelegramUpdate | FastPathSyncMessage | OperationsOrderMessage>;

export { TelegramSession };
