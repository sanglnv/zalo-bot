'use strict';

function createPaymentExpiryRunner(dependencies) {
  dependencies = dependencies || {};
  if (!dependencies.orderRepository ||
      typeof dependencies.orderRepository.findAwaitingPaymentOlderThan !== 'function') {
    throw new TypeError('orderRepository.findAwaitingPaymentOlderThan is required');
  }
  if (!dependencies.orderService || typeof dependencies.orderService.expireOrder !== 'function') {
    throw new TypeError('orderService.expireOrder is required');
  }
  if (typeof dependencies.dispatchNotifications !== 'function') {
    throw new TypeError('dispatchNotifications must be a function');
  }
  if (!dependencies.errorLogRepository || typeof dependencies.errorLogRepository.log !== 'function') {
    throw new TypeError('errorLogRepository.log is required');
  }
  if (typeof dependencies.now !== 'function') throw new TypeError('now must be a function');

  var timeoutMinutes = dependencies.timeoutMinutes == null ? 30 : dependencies.timeoutMinutes;
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new TypeError('timeoutMinutes must be a positive number');
  }
  var requestedLimit = dependencies.batchLimit == null ? 50 : dependencies.batchLimit;
  if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) {
    throw new TypeError('batchLimit must be a positive integer');
  }
  var batchLimit = Math.min(requestedLimit, 50);

  function log(error, stage, order, details) {
    try {
      dependencies.errorLogRepository.log({
        timestamp: dependencies.now().toISOString(),
        context: Object.assign({
          stage: stage,
          orderId: order && order.orderId ? order.orderId : null,
          customerId: order && order.customerId ? order.customerId : null
        }, details || {}),
        message: error && error.message ? error.message : String(error),
        stack: error && error.stack ? error.stack : ''
      });
    } catch (ignore) {}
  }

  function scan() {
    var currentTime = dependencies.now();
    var cutoff = new Date(currentTime.getTime() - timeoutMinutes * 60 * 1000).toISOString();
    var candidates = dependencies.orderRepository.findAwaitingPaymentOlderThan(cutoff, batchLimit);
    var summary = {
      cutoff: cutoff,
      scanned: candidates.length,
      expired: 0,
      notificationFailed: 0,
      resolved: 0,
      failed: 0,
      results: []
    };
    candidates.forEach(function (order) {
      if (typeof dependencies.resolveFastPath === 'function') {
        var fastPath = dependencies.resolveFastPath(order);
        if (fastPath && fastPath.handled) {
          if (fastPath.outcome === 'resolved') summary.expired += 1;
          else summary.resolved += 1;
          summary.results.push({
            orderId: order.orderId,
            ok: fastPath.outcome === 'resolved',
            reason: fastPath.outcome,
            deliveryStatus: fastPath.deliveryStatus || null,
            fastPath: true
          });
          return;
        }
        if (fastPath && fastPath.outcome === 'infra_error') {
          log(
            new Error(fastPath.message || 'Fast-path probe failed'),
            'fast_path_probe_failed',
            order
          );
        }
      }
      var expiration;
      try {
        expiration = dependencies.orderService.expireOrder(order.orderId);
        summary.expired += 1;
      } catch (error) {
        if (error && error.code === 'PAYMENT_ALREADY_RESOLVED') {
          summary.resolved += 1;
          summary.results.push({ orderId: order.orderId, ok: false, reason: 'already_resolved' });
          return;
        }
        summary.failed += 1;
        log(error, 'expire_order', order);
        summary.results.push({
          orderId: order.orderId,
          ok: false,
          reason: error && error.code === 'ORDER_NOT_FOUND' ? 'not_found' : 'error',
          message: error && error.message ? error.message : String(error)
        });
        return;
      }

      try {
        var dispatchResults = dependencies.dispatchNotifications(
          expiration.customer,
          expiration.outboundMessages,
          dependencies.registry || {}
        );
        summary.results.push({ orderId: order.orderId, ok: true, dispatchResults: dispatchResults });
      } catch (error) {
        var customer = expiration.customer || {};
        var platformLinks = Array.isArray(customer.platformLinks) ? customer.platformLinks : [];
        summary.notificationFailed += 1;
        log(error, 'expiry_notification_dispatch', order, {
          platformLinks: platformLinks
        });
        summary.results.push({
          orderId: order.orderId,
          ok: false,
          reason: 'expired_but_notification_failed',
          platformLinks: platformLinks,
          outboundMessages: expiration.outboundMessages,
          message: error && error.message ? error.message : String(error)
        });
      }
    });
    return summary;
  }

  return Object.freeze({ scan: scan });
}

var PaymentExpiryRunner = Object.freeze({ create: createPaymentExpiryRunner });

if (typeof module !== 'undefined' && module.exports) module.exports = PaymentExpiryRunner;
