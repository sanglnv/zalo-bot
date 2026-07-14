'use strict';

var ZaloClient = (function () {
  var SEND_ENDPOINT = 'https://openapi.zalo.me/v3.0/oa/message/cs';

  function create(tokenManager) {
    if (!tokenManager || typeof tokenManager.getValidAccessToken !== 'function') {
      throw new TypeError('tokenManager.getValidAccessToken is required');
    }
    function execute(command) {
      if (!command || command.method !== 'sendCustomerServiceMessage' || !command.params) {
        throw new TypeError('Invalid Zalo Send API command');
      }
      var response = UrlFetchApp.fetch(SEND_ENDPOINT, {
        method: 'post',
        contentType: 'application/json',
        headers: { access_token: tokenManager.getValidAccessToken() },
        payload: JSON.stringify(command.params),
        muteHttpExceptions: true
      });
      var status = response.getResponseCode();
      var text = response.getContentText();
      var parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch (ignore) {}
      if (status < 200 || status >= 300 || !parsed || Number(parsed.error) !== 0) {
        throw new Error('Zalo Send API failed with HTTP ' + status + ': ' + text);
      }
      return parsed;
    }
    return Object.freeze({ execute: execute });
  }

  return Object.freeze({ create: create, SEND_ENDPOINT: SEND_ENDPOINT });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ZaloClient;
