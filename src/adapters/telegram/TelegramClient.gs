'use strict';

var TelegramClient = (function () {
  function requiredToken() {
    var token = PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
    if (!token) throw new Error('Missing required script property: TELEGRAM_BOT_TOKEN');
    return token;
  }

  function create() {
    function execute(command) {
      if (!command || typeof command.method !== 'string' || !command.params) {
        throw new TypeError('Telegram command must contain method and params');
      }
      var response = UrlFetchApp.fetch(
        'https://api.telegram.org/bot' + requiredToken() + '/' + command.method,
        {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify(command.params),
          muteHttpExceptions: true
        }
      );
      var status = response.getResponseCode();
      var body = response.getContentText();
      var parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch (ignore) {}
      if (status < 200 || status >= 300 || (parsed && parsed.ok === false)) {
        throw new Error('Telegram Bot API ' + command.method + ' failed with HTTP ' + status + ': ' + body);
      }
      return parsed;
    }

    return Object.freeze({ execute: execute });
  }

  return Object.freeze({ create: create });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TelegramClient;
