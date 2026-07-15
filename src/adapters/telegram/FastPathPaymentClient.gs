'use strict';

var FastPathPaymentClient = (function () {
  function resolveUnsafe(orderId, action, actor) {
    var order = SheetOrderRepository().findById(orderId);
    if (!order) return { handled: false, outcome: 'not_found' };
    var customer = SheetCustomerRepository().findById(order.customerId);
    var links = customer && Array.isArray(customer.platformLinks) ? customer.platformLinks : [];
    var telegram = links.find(function (link) { return link.platform === 'telegram'; });
    if (!telegram) return { handled: false, outcome: 'not_found' };
    var properties = PropertiesService.getScriptProperties();
    var gatewayUrl = properties.getProperty('TELEGRAM_WEBHOOK_URL');
    var gatewayToken = properties.getProperty('GAS_GATEWAY_TOKEN');
    if (!gatewayUrl || !gatewayToken) return {
      handled: false,
      outcome: 'infra_error',
      message: 'Fast-path payment gateway is not configured'
    };
    var response;
    try {
      response = UrlFetchApp.fetch(gatewayUrl.replace(/\/$/, '') + '/internal/payment', {
        method: 'post',
        contentType: 'application/json',
        headers: { 'X-GAS-Gateway-Token': gatewayToken },
        payload: JSON.stringify({
          chatId: String(telegram.platformUserId),
          orderId: orderId,
          action: action,
          actor: actor || null
        }),
        muteHttpExceptions: true
      });
    } catch (error) {
      return {
        handled: false,
        outcome: 'infra_error',
        message: error && error.message ? error.message : String(error)
      };
    }
    var status = response.getResponseCode();
    var body;
    try { body = JSON.parse(response.getContentText()); }
    catch (error) { return {
      handled: false,
      outcome: 'infra_error',
      message: 'Fast-path payment gateway returned invalid JSON'
    }; }
    if (status !== 200) return {
      handled: false,
      outcome: 'infra_error',
      message: 'Fast-path payment gateway failed with HTTP ' + status + ': ' + (body.error || 'unknown')
    };
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        typeof body.handled !== 'boolean' || typeof body.outcome !== 'string') return {
      handled: false,
      outcome: 'infra_error',
      message: 'Fast-path payment gateway returned an invalid response'
    };
    return body;
  }

  function resolve(orderId, action, actor) {
    try { return resolveUnsafe(orderId, action, actor); }
    catch (error) {
      return {
        handled: false,
        outcome: 'infra_error',
        message: error && error.message ? error.message : String(error)
      };
    }
  }

  return Object.freeze({ resolve: resolve });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FastPathPaymentClient;
