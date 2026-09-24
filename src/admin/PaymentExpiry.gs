'use strict';

function paymentTimeoutMinutes() {
  var raw = PropertiesService.getScriptProperties().getProperty('PAYMENT_TIMEOUT_MINUTES');
  if (!raw) return 30;
  var value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('PAYMENT_TIMEOUT_MINUTES must be a positive number');
  }
  return value;
}

function buildPaymentExpiryOrderService() {
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

function scanAndExpireStalePayments() {
  try {
    return recordDuration('scanAndExpireStalePayments', function () {
      return PaymentExpiryRunner.create({
        orderRepository: BotOrderRepository(),
        orderService: buildPaymentExpiryOrderService(),
        dispatchNotifications: NotificationDispatcher.dispatchNotifications,
        registry: buildNotificationRegistry(),
        errorLogRepository: SheetErrorLogRepository(),
        now: function () { return new Date(); },
        timeoutMinutes: paymentTimeoutMinutes(),
        batchLimit: 50,
        resolveFastPath: typeof FastPathPaymentClient === 'undefined' ? null : function (order) {
          return FastPathPaymentClient.resolve(order.orderId, 'expire', 'system:gas-expiry-scan');
        }
      }).scan();
    });
  } catch (error) {
    try {
      SheetErrorLogRepository().log({
        timestamp: new Date().toISOString(),
        context: { stage: 'payment_expiry_scan_failed' },
        message: error && error.message ? error.message : String(error),
        stack: error && error.stack ? error.stack : ''
      });
    } catch (ignore) {}
    try {
      var chatId = PropertiesService.getScriptProperties()
        .getProperty('TELEGRAM_OPERATIONS_CHAT_ID');
      if (chatId) {
        var cache = typeof CacheService === 'undefined' ? null : CacheService.getScriptCache();
        var codePart = (error && error.code)
          ? String(error.code).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32)
          : '';
        var msgPart = (error && error.message)
          ? String(error.message).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 50)
          : '';
        var discriminant = [codePart, msgPart].filter(Boolean).join('_');
        var cacheKey = 'alert_cooldown_payment_expiry_scan_failed' +
          (discriminant ? '_' + discriminant : '');
        var isCoolingDown = false;
        if (cache) {
          try {
            isCoolingDown = !!cache.get(cacheKey);
          } catch (cacheError) {
            isCoolingDown = false;
          }
        }
        if (!isCoolingDown) {
          TelegramClient.create().execute({
            method: 'sendMessage',
            params: {
              chat_id: chatId,
              text: '⚠️ Quét đơn chờ thanh toán đã thất bại: ' +
                (error && error.message ? error.message : String(error))
            }
          });
          if (cache) {
            try { cache.put(cacheKey, '1', 1800); } catch (e) {}
          }
        }
      }
    } catch (ignore) {}
    throw error;
  }
}

function registerPaymentExpiryTrigger() {
  var exists = ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getHandlerFunction() === 'scanAndExpireStalePayments';
  });
  if (exists) return { created: false };
  ScriptApp.newTrigger('scanAndExpireStalePayments').timeBased().everyMinutes(10).create();
  return { created: true };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    paymentTimeoutMinutes: paymentTimeoutMinutes,
    scanAndExpireStalePayments: scanAndExpireStalePayments,
    registerPaymentExpiryTrigger: registerPaymentExpiryTrigger
  };
}
