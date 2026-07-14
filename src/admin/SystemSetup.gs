'use strict';

var SystemSetup = (function () {
  var REQUIRED_PROPERTIES = [
    'SPREADSHEET_ID',
    'TELEGRAM_BOT_TOKEN',
    'CATALOG_JSON',
    'VIETQR_BANK_ID',
    'VIETQR_ACCOUNT_NO',
    'VIETQR_ACCOUNT_NAME',
    'WEB_APP_URL',
    'TELEGRAM_WEBHOOK_URL',
    'TELEGRAM_WEBHOOK_SECRET',
    'GAS_GATEWAY_TOKEN'
  ];
  var SHEETS = [
    ['Orders', ['orderId', 'customerId', 'itemsJson', 'status', 'totalAmount', 'createdAt', 'updatedAt', 'confirmedAt', 'confirmedBy']],
    ['Customers', ['customerId', 'phone', 'displayName', 'platformLinksJson']],
    ['ConversationStates', ['customerId', 'currentState', 'contextDataJson', 'updatedAt']],
    ['ProcessedUpdates', ['updateId', 'processedAt', 'deliveryStatus']],
    ['ZaloProcessedUpdates', ['messageId', 'processedAt', 'deliveryStatus']],
    ['ErrorLogs', ['timestamp', 'context', 'message', 'stack']],
    ['OperationMetrics', ['timestamp', 'operation', 'durationMs']]
  ];

  function validateConfiguration() {
    var properties = PropertiesService.getScriptProperties();
    var missing = REQUIRED_PROPERTIES.filter(function (name) { return !properties.getProperty(name); });
    if (missing.length) throw new Error('Missing required script properties: ' + missing.join(', '));
    var catalog;
    try { catalog = JSON.parse(properties.getProperty('CATALOG_JSON')); }
    catch (error) { throw new Error('CATALOG_JSON must be valid JSON: ' + error.message); }
    if (!Array.isArray(catalog)) throw new Error('CATALOG_JSON must contain an array');
    catalog.forEach(function (product, index) {
      if (!product || typeof product.productId !== 'string' || typeof product.name !== 'string' ||
          typeof product.price !== 'number' || typeof product.isAvailable !== 'boolean') {
        throw new Error('CATALOG_JSON product at index ' + index + ' is invalid');
      }
    });
    return { properties: 'ok', catalogProducts: catalog.length };
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
    return { configuration: configuration, sheets: sheets, telegramWebhook: webhook };
  }

  return Object.freeze({
    validateConfiguration: validateConfiguration,
    ensureSheets: ensureSheets,
    setupProject: setupProject,
    healthCheck: healthCheck
  });
})();

function setupProject(options) { return SystemSetup.setupProject(options); }
function healthCheck() { return SystemSetup.healthCheck(); }

if (typeof module !== 'undefined' && module.exports) module.exports = SystemSetup;
