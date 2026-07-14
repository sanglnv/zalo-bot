'use strict';

function createPaymentConfirmationHandler(dependencies) {
  dependencies = dependencies || {};
  if (!dependencies.orderService || typeof dependencies.orderService.confirmPayment !== 'function') {
    throw new TypeError('orderService.confirmPayment is required');
  }
  if (typeof dependencies.dispatchNotifications !== 'function') {
    throw new TypeError('dispatchNotifications must be a function');
  }
  if (!dependencies.errorLogRepository || typeof dependencies.errorLogRepository.log !== 'function') {
    throw new TypeError('errorLogRepository.log is required');
  }
  if (typeof dependencies.now !== 'function') throw new TypeError('now must be a function');

  function log(error, stage, orderId, confirmedBy, details) {
    try {
      dependencies.errorLogRepository.log({
        timestamp: dependencies.now().toISOString(),
        context: Object.assign({
          stage: stage,
          orderId: orderId,
          confirmedBy: confirmedBy
        }, details || {}),
        message: error && error.message ? error.message : String(error),
        stack: error && error.stack ? error.stack : ''
      });
    } catch (ignore) {}
  }

  function process(orderId, confirmedBy) {
    var confirmation;
    try {
      confirmation = dependencies.orderService.confirmPayment(orderId, confirmedBy);
    } catch (error) {
      if (error && error.code === 'PAYMENT_ALREADY_RESOLVED') {
        return { ok: false, reason: 'already_resolved' };
      }
      if (error && error.code === 'ORDER_NOT_FOUND') {
        log(error, 'confirm_payment', orderId, confirmedBy);
        return { ok: false, reason: 'not_found', message: error.message };
      }
      log(error, 'confirm_payment', orderId, confirmedBy);
      return {
        ok: false,
        reason: 'error',
        message: error && error.message ? error.message : String(error)
      };
    }

    try {
      var dispatchResults = dependencies.dispatchNotifications(
        confirmation.customer,
        confirmation.outboundMessages,
        dependencies.registry || {}
      );
      return { ok: true, dispatchResults: dispatchResults };
    } catch (error) {
      var customer = confirmation.customer || {};
      var platformLinks = Array.isArray(customer.platformLinks) ? customer.platformLinks : [];
      log(error, 'notification_dispatch', orderId, confirmedBy, {
        customerId: customer.customerId || null,
        platformLinks: platformLinks
      });
      return {
        ok: false,
        reason: 'confirmed_but_notification_failed',
        orderId: orderId,
        platformLinks: platformLinks,
        outboundMessages: confirmation.outboundMessages,
        message: error && error.message ? error.message : String(error)
      };
    }
  }

  return Object.freeze({ process: process });
}

var PaymentConfirmationHandler = Object.freeze({ create: createPaymentConfirmationHandler });

if (typeof module !== 'undefined' && module.exports) module.exports = PaymentConfirmationHandler;
