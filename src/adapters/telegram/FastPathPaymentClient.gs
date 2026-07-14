'use strict';

var FastPathPaymentClient = (function () {
  function resolve(orderId, action, actor) {
    var order = SheetOrderRepository().findById(orderId);
    if (!order) return { handled: false, outcome: 'not_found' };
    var customer = SheetCustomerRepository().findById(order.customerId);
    var links = customer && Array.isArray(customer.platformLinks) ? customer.platformLinks : [];
    var telegram = links.find(function (link) { return link.platform === 'telegram'; });
    if (!telegram) return { handled: false, outcome: 'not_found' };
    var properties = PropertiesService.getScriptProperties();
    var gatewayUrl = properties.getProperty('TELEGRAM_WEBHOOK_URL');
    var gatewayToken = properties.getProperty('GAS_GATEWAY_TOKEN');
    if (!gatewayUrl || !gatewayToken) throw new Error('Fast-path payment gateway is not configured');
    var response = UrlFetchApp.fetch(gatewayUrl.replace(/\/$/, '') + '/internal/payment', {
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
    var status = response.getResponseCode();
    var body;
    try { body = JSON.parse(response.getContentText()); }
    catch (error) { throw new Error('Fast-path payment gateway returned invalid JSON'); }
    if (status !== 200) throw new Error(
      'Fast-path payment gateway failed with HTTP ' + status + ': ' + (body.error || 'unknown')
    );
    return body;
  }

  return Object.freeze({ resolve: resolve });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FastPathPaymentClient;
