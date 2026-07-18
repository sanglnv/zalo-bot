'use strict';

var ZaloRuntime = (function () {
  function shared() {
    return typeof BotRuntime !== 'undefined' ? BotRuntime : require('../BotRuntime.gs');
  }
  return Object.freeze({
    loadCatalog: function () { return shared().loadCatalog(); },
    createPaymentQrUrl: function (order) { return shared().createPaymentQrUrl(order); },
    createId: function () { return shared().createId(); },
    fallbackMessage: function () { return shared().fallbackMessage(); },
    requiredProperty: function (name) { return shared().requiredProperty(name); }
  });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ZaloRuntime;
