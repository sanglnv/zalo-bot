export interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
  };
  [key: string]: unknown;
}

const encoder = new TextEncoder();

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const suppliedSecret = request.headers.get(
      "X-Telegram-Bot-Api-Secret-Token"
    );

    if (!(await secretsEqual(suppliedSecret, env.TELEGRAM_WEBHOOK_SECRET))) {
      log("warn", "telegram_webhook_rejected");
      return new Response("Unauthorized", { status: 401 });
    }

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

    // Return 200 only after Cloudflare has durably accepted the update.
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

    log("log", "telegram_update_queued", { updateId: update.update_id });
    return new Response("OK", { status: 200 });
  },

  async queue(
    batch: MessageBatch<TelegramUpdate>,
    env: Env
  ): Promise<void> {
    for (const message of batch.messages) {
      const target = new URL(env.GAS_WEB_APP_URL);
      target.searchParams.set("platform", "telegram");
      target.searchParams.set("gateway_token", env.GAS_GATEWAY_TOKEN);

      try {
        const response = await fetch(target.toString(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(message.body),
          redirect: "follow",
          signal: AbortSignal.timeout(60_000)
        });

        if (!response.ok) {
          throw new Error(`GAS returned HTTP ${response.status}`);
        }

        message.ack();
        log("log", "telegram_update_forwarded", {
          updateId: message.body.update_id,
          attempt: message.attempts
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

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
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
} satisfies ExportedHandler<Env, TelegramUpdate>;
