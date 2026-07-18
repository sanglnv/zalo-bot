'use strict';

var TelegramRuntime = (function () {
  function shared() {
    return typeof BotRuntime !== 'undefined' ? BotRuntime : require('../BotRuntime.gs');
  }
  return Object.freeze({
    loadCatalog: function () { return shared().loadCatalog(); },
    createPaymentQrUrl: function (order) { return shared().createPaymentQrUrl(order); },
    createId: function () { return shared().createId(); },
    fallbackMessage: function () { return shared().fallbackMessage(); }
  });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TelegramRuntime;
