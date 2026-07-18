'use strict';

/**
 * Order repository backed by the external POS "Bot Order Webhook" instead
 * of the Orders Sheet. Implements the same contract as SheetOrderRepository
 * (save/findById/findByCustomerId/updateStatus/findAwaitingPaymentOlderThan)
 * so it drops into every existing OrderService/PaymentExpiryRunner call site.
 *
 * IMPORTANT -- orderId reassignment on create: OrderService (core/orderService.js)
 * generates `order.orderId` itself via createId() *before* calling
 * repository.save(), then keeps reading `order.orderId` off the same object
 * reference afterward (for the VietQR transfer content, the confirmation
 * message, and conversationState.contextData.orderId). The POS webhook always
 * generates its own order id server-side and ignores any client-supplied id
 * ("order/item IDs ... always generated or reset server-side"). To keep a
 * single canonical orderId throughout Clawbot without a separate local
 * id-mapping table, `save()` mutates the passed-in `order` object in place,
 * overwriting `order.orderId` with the POS-assigned id before returning.
 * Every downstream read of `order.orderId` in the same call happens after
 * save() returns, so this is safe. The original Clawbot-generated id is
 * still sent to the POS as `raw.clawbotOrderId` for traceability.
 */
function BotOrderRepository() {
  function isNewOrder(order) {
    return order.status === 'AWAITING_PAYMENT' && !order.confirmedAt && !order.confirmedBy;
  }

  function save(order) {
    if (isNewOrder(order)) {
      var created = BotOrderWebhookClient.createOrder({
        customerId: order.customerId,
        items: order.items,
        clawbotOrderId: order.orderId,
        memberId: order.memberId || null
      });
      order.orderId = created.orderId;
      order.createdAt = created.createdAt || order.createdAt;
      order.updatedAt = created.updatedAt || order.updatedAt;
      return order;
    }
    if (order.status === 'PAID') {
      // Clawbot only supports VietQR bank transfer today; paymentMethod is
      // mandatory on completeOrder but there is no per-order method to pass
      // through from the current UI.
      BotOrderWebhookClient.completeOrder(order.orderId, 'bank_transfer');
      return order;
    }
    if (order.status === 'EXPIRED') {
      BotOrderWebhookClient.cancelOrder(order.orderId, 'payment_timeout');
      return order;
    }
    throw new Error('BotOrderRepository.save does not support status: ' + order.status);
  }

  function findById(orderId) {
    return BotOrderWebhookClient.getOrder(orderId);
  }

  function findByCustomerId(customerId) {
    // The webhook only returns open orders for this action (no history of
    // completed/cancelled orders by customer). /status after an order
    // leaves "open" will therefore report "no orders" instead of showing
    // the last resolved order -- a capability gap of the webhook, not a bug
    // introduced here.
    try {
      return BotOrderWebhookClient.findOrdersByCustomerId(customerId);
    } catch (error) {
      // OrderService calls this unconditionally on nearly every inbound
      // message (pendingOrder() check on /start, catalog browsing, etc).
      // If the POS has this action disabled/unscoped for our secret, every
      // single message would hard-fail instead of just the features that
      // actually need order history. Fail soft to "no pending orders" so
      // the bot stays usable while the POS-side permission gap gets fixed;
      // log loudly so it's not silently swallowed forever.
      var message = error && error.message ? error.message : String(error);
      if (/not allowed/i.test(message)) {
        if (typeof console !== 'undefined' && console.error) {
          console.error(JSON.stringify({
            event: 'bot_order_webhook_action_not_allowed',
            action: 'findOrdersByCustomerId',
            customerId: customerId,
            message: message
          }));
        }
        return [];
      }
      throw error;
    }
  }

  function findAwaitingPaymentOlderThan(cutoffIso, limit) {
    var cutoff = new Date(cutoffIso).getTime();
    if (!Number.isFinite(cutoff)) throw new TypeError('cutoffIso must be a valid timestamp');
    if (!Number.isInteger(limit) || limit <= 0) throw new TypeError('limit must be a positive integer');
    return BotOrderWebhookClient.listOpenOrders()
      .filter(function (order) {
        var createdAt = new Date(order.createdAt).getTime();
        return order.status === 'AWAITING_PAYMENT' && Number.isFinite(createdAt) && createdAt < cutoff;
      })
      .sort(function (left, right) {
        return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
      })
      .slice(0, limit);
  }

  function updateStatus(orderId, status) {
    if (status !== 'CANCELLED') {
      throw new Error('BotOrderRepository.updateStatus only supports CANCELLED, got: ' + status);
    }
    BotOrderWebhookClient.cancelOrder(orderId, 'customer_cancelled');
    return true;
  }

  return Object.freeze({
    save: save,
    findById: findById,
    findByCustomerId: findByCustomerId,
    findAwaitingPaymentOlderThan: findAwaitingPaymentOlderThan,
    updateStatus: updateStatus
  });
}

if (typeof module !== 'undefined' && module.exports) module.exports = BotOrderRepository;
