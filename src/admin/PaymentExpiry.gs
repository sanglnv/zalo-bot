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
    orderRepository: SheetOrderRepository(),
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
  return recordDuration('scanAndExpireStalePayments', function () {
    return PaymentExpiryRunner.create({
      orderRepository: SheetOrderRepository(),
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
