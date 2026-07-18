'use strict';

var SystemSetup = (function () {
  var REQUIRED_PROPERTIES = [
    'SPREADSHEET_ID',
    'TELEGRAM_BOT_TOKEN',
    'BOT_ORDER_WEBHOOK_URL',
    'BOT_ORDER_WEBHOOK_SECRET',
    'VIETQR_BANK_ID',
    'VIETQR_ACCOUNT_NO',
    'VIETQR_ACCOUNT_NAME',
    'WEB_APP_URL',
    'TELEGRAM_WEBHOOK_URL',
    'TELEGRAM_WEBHOOK_SECRET',
    'GAS_GATEWAY_TOKEN',
    'TELEGRAM_ADMIN_USER_IDS',
    // QR is no longer sent to the customer at confirm_order time -- staff
    // sends it manually via "/thanhtoan <orderId>" in this chat (see
    // OperationsNotifier.gs/PaymentQrDispatch.gs). Without this, confirmed
    // orders are silently never notified to anyone and customers never
    // receive a QR at all, for EITHER Telegram or Zalo customers (Zalo has
    // no ops chat of its own and reuses this one). This is required, not
    // optional, unlike before.
    'TELEGRAM_OPERATIONS_CHAT_ID'
  ];
  // 'Orders' is intentionally not managed here anymore for the normal path:
  // BotOrderRepository uses the POS webhook. SheetOrderRepository remains a
  // live compatibility mirror for FastPathSync and FastPathPaymentClient.
  var SHEETS = [
    ['Customers', ['customerId', 'phone', 'displayName', 'platformLinksJson', 'memberId']],
    ['ConversationStates', ['customerId', 'currentState', 'contextDataJson', 'updatedAt']],
    ['ProcessedUpdates', ['updateId', 'processedAt', 'deliveryStatus']],
    ['FastPathSyncedUpdates', ['updateId', 'syncedAt']],
    ['FastPathSyncState', ['customerId', 'lastRevision', 'lastSnapshotId', 'syncedAt']],
    ['ZaloProcessedUpdates', ['messageId', 'processedAt', 'deliveryStatus']],
    ['ErrorLogs', ['timestamp', 'context', 'message', 'stack']],
    ['OperationMetrics', ['timestamp', 'operation', 'durationMs']]
  ];

  function validateConfiguration() {
    var properties = PropertiesService.getScriptProperties();
    var missing = REQUIRED_PROPERTIES.filter(function (name) { return !properties.getProperty(name); });
    if (missing.length) throw new Error('Missing required script properties: ' + missing.join(', '));
    return { properties: 'ok' };
  }

  function checkBotOrderWebhook() {
    try {
      var products = BotOrderWebhookClient.fetchMenuCatalog();
      return { status: 'ok', catalogProducts: products.length };
    } catch (error) {
      return { status: 'error', message: error && error.message ? error.message : String(error) };
    }
  }

  function ensureSheets() {
    return SHEETS.map(function (definition) {
      var sheet = SheetRepositorySupport.writableSheet(definition[0], definition[1]);
      var actual = sheet.getRange(1, 1, 1, definition[1].length).getValues()[0];
      definition[1].forEach(function (header, index) {
        if (actual[index] !== header) sheet.getRange(1, index + 1).setValue(header);
      });
      return definition[0];
    });
  }

  function setupProject(options) {
    options = options || {};
    var configuration = validateConfiguration();
    var menuSource = checkBotOrderWebhook();
    if (menuSource.status !== 'ok') throw new Error('Bot order webhook is not reachable: ' + menuSource.message);
    configuration = { properties: configuration.properties, catalogProducts: menuSource.catalogProducts };
    var sheets = ensureSheets();
    var webhook = options.registerWebhook === false ? null : registerWebhook(options.dropPendingUpdates === true);
    return { configuration: configuration, sheets: sheets, webhook: webhook };
  }

  function healthCheck() {
    var configuration;
    var sheets;
    var webhook;
    try { configuration = validateConfiguration(); }
    catch (error) { configuration = { status: 'error', message: error.message }; }
    try { sheets = ensureSheets(); }
    catch (error) { sheets = { status: 'error', message: error.message }; }
    try {
      var response = TelegramClient.create().execute({ method: 'getWebhookInfo', params: {} });
      var expectedWebhookUrl = PropertiesService
        .getScriptProperties()
        .getProperty('TELEGRAM_WEBHOOK_URL');
      webhook = response && response.result ? {
        status: response.result.url !== expectedWebhookUrl
          ? 'misconfigured'
          : response.result.pending_update_count === 0 ? 'ok' : 'pending',
        pendingUpdates: response.result.pending_update_count,
        lastErrorDate: response.result.last_error_date || null,
        lastErrorMessage: response.result.last_error_message || null,
        url: response.result.url || '',
        expectedUrl: expectedWebhookUrl || ''
      } : { status: 'error', message: 'Unexpected Telegram response' };
    } catch (error) { webhook = { status: 'error', message: error.message }; }
    var menuSource = checkBotOrderWebhook();
    return { configuration: configuration, sheets: sheets, telegramWebhook: webhook, menuSource: menuSource };
  }

  return Object.freeze({
    validateConfiguration: validateConfiguration,
    checkBotOrderWebhook: checkBotOrderWebhook,
    ensureSheets: ensureSheets,
    setupProject: setupProject,
    healthCheck: healthCheck
  });
})();

function setupProject(options) { return SystemSetup.setupProject(options); }
function healthCheck() {
  var result = SystemSetup.healthCheck();
  var output = JSON.stringify(result, null, 2);
  if (typeof console !== 'undefined' && console.log) console.log(output);
  else if (typeof Logger !== 'undefined' && Logger.log) Logger.log(output);
  return result;
}

if (typeof module !== 'undefined' && module.exports) module.exports = SystemSetup;
