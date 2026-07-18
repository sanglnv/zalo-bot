'use strict';

/**
 * Staff-triggered QR send, invoked when an admin types `/thanhtoan <orderId>`
 * in the Telegram ops chat (see OperationsNotifier.gs for the notification
 * that tells them to do this, and telegram/webhook.gs for where the command
 * is intercepted before it ever reaches OrderService.handleMessage).
 *
 * This intentionally does NOT reuse buildNotificationRegistry() from
 * NotificationRegistry.gs -- that registry sends Zalo messages through
 * pre-approved ZBS templates (paymentConfirmed/expired only), which cannot
 * carry an arbitrary QR image. The QR send is a same-session-ish reply
 * shortly after the customer's own confirm_order message, so it uses the
 * same interactive clients/renderers the live webhooks use (normal Zalo
 * Send API within the 48h customer-service window, normal Telegram
 * sendMessage/sendPhoto).
 */
function buildPaymentQrOrderService() {
  return OrderService.create({
    orderRepository: BotOrderRepository(),
    customerRepository: SheetCustomerRepository(),
    conversationStateRepository: SheetConversationStateRepository(),
    getCatalog: TelegramRuntime.loadCatalog,
    createQrContent: TelegramRuntime.createPaymentQrUrl,
    createId: TelegramRuntime.createId,
    now: function () { return new Date(); },
    withLock: SheetRepositorySupport.withScriptLock
  });
}

function buildInteractivePushRegistry() {
  return {
    telegram: {
      renderOutboundMessage: TelegramOutboundRenderer.renderOutboundMessage,
      client: TelegramClient.create()
    },
    zalo: {
      renderOutboundMessage: ZaloOutboundRenderer.renderOutboundMessage,
      client: ZaloClient.create(ZaloTokenManager.createDefault())
    }
  };
}

// "/thanhtoan HD123" or "/thanhtoan@BotName HD123" -> "HD123".
// Returns `false` when the text isn't a /thanhtoan command at all (caller
// should let the message fall through to the normal pipeline), or `null`
// when it IS the command but is missing its orderId argument (caller should
// reply with usage instead of silently ignoring it).
function parseThanhToanCommand(text) {
  var parts = String(text || '').trim().split(/\s+/);
  var command = (parts[0] || '').toLowerCase().split('@')[0];
  if (command !== '/thanhtoan') return false;
  return parts[1] || null;
}

function dispatchPaymentQr(orderId) {
  var orderService = buildPaymentQrOrderService();
  var result;
  try {
    result = orderService.sendPaymentQr(orderId);
  } catch (error) {
    if (error && error.code === 'ORDER_NOT_FOUND') {
      return { ok: false, reason: 'not_found', message: error.message };
    }
    if (error && error.code === 'PAYMENT_ALREADY_RESOLVED') {
      return { ok: false, reason: 'already_resolved', status: error.status };
    }
    return { ok: false, reason: 'error', message: error && error.message ? error.message : String(error) };
  }
  try {
    var dispatchResults = NotificationDispatcher.dispatchNotifications(
      result.customer, result.outboundMessages, buildInteractivePushRegistry()
    );
    return { ok: true, dispatchResults: dispatchResults };
  } catch (error) {
    return {
      ok: false,
      reason: 'sent_but_delivery_failed',
      message: error && error.message ? error.message : String(error)
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseThanhToanCommand: parseThanhToanCommand,
    dispatchPaymentQr: dispatchPaymentQr,
    buildInteractivePushRegistry: buildInteractivePushRegistry
  };
}
