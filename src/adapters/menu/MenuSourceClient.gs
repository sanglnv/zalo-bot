'use strict';

// Superseded by BotOrderWebhookClient.gs (see docs/bot-order-webhook.md conventions).
// The menu source and the order webhook turned out to be the same Apps Script
// endpoint (POST + secret-in-body + requestId, action "getMenuCatalog"), so
// this file is kept only as a thin deprecated alias to avoid breaking any
// stray reference. New code should call BotOrderWebhookClient.fetchMenuCatalog()
// directly. This file intentionally has no tests of its own.
var MenuSourceClient = (function () {
  function fetchCatalog() {
    return BotOrderWebhookClient.fetchMenuCatalog();
  }
  return Object.freeze({ fetchCatalog: fetchCatalog });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MenuSourceClient;
