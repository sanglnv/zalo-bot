'use strict';

var TelegramRuntime = (function () {
  function properties() {
    return PropertiesService.getScriptProperties();
  }

  function requiredProperty(name) {
    var value = properties().getProperty(name);
    if (!value) throw new Error('Missing required script property: ' + name);
    return value;
  }

  function loadCatalog() {
    return BotOrderWebhookClient.fetchMenuCatalog();
  }

  function createPaymentQrUrl(order) {
    var bankId = requiredProperty('VIETQR_BANK_ID');
    var accountNo = requiredProperty('VIETQR_ACCOUNT_NO');
    var accountName = requiredProperty('VIETQR_ACCOUNT_NAME');
    var template = properties().getProperty('VIETQR_TEMPLATE') || 'compact2';
    var prefix = properties().getProperty('VIETQR_TRANSFER_PREFIX') || 'DH';
    var transferContent = prefix + order.orderId;
    return 'https://img.vietqr.io/image/' +
      encodeURIComponent(bankId) + '-' + encodeURIComponent(accountNo) + '-' + encodeURIComponent(template) +
      '.png?amount=' + encodeURIComponent(String(order.totalAmount)) +
      '&addInfo=' + encodeURIComponent(transferContent) +
      '&accountName=' + encodeURIComponent(accountName);
  }

  function createId() {
    return Utilities.getUuid().replace(/-/g, '').slice(0, 20);
  }

  function fallbackMessage() {
    var contact = properties().getProperty('SUPPORT_CONTACT');
    return 'Đã có lỗi khi xử lý yêu cầu. Vui lòng thử lại' +
      (contact ? ' hoặc liên hệ ' + contact : ' hoặc liên hệ nhân viên hỗ trợ') + '.';
  }

  return Object.freeze({
    loadCatalog: loadCatalog,
    createPaymentQrUrl: createPaymentQrUrl,
    createId: createId,
    fallbackMessage: fallbackMessage
  });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TelegramRuntime;
