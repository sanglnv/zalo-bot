'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require.extensions['.gs'] = require.extensions['.js'];
const SystemSetup = require('../admin/SystemSetup.gs');

const validProperties = {
  SPREADSHEET_ID: 'sheet-1',
  TELEGRAM_BOT_TOKEN: 'token',
  BOT_ORDER_WEBHOOK_URL: 'https://script.google.com/macros/s/bot-order-webhook/exec',
  BOT_ORDER_WEBHOOK_SECRET: 'bot-order-webhook-secret',
  VIETQR_BANK_ID: '970407',
  VIETQR_ACCOUNT_NO: '123',
  VIETQR_ACCOUNT_NAME: 'SHOP',
  WEB_APP_URL: 'https://script.google.com/macros/s/example/exec',
  TELEGRAM_WEBHOOK_URL: 'https://telegram-gateway.example.workers.dev',
  TELEGRAM_WEBHOOK_SECRET: 'telegram-webhook-secret',
  GAS_GATEWAY_TOKEN: 'gas-gateway-token',
  TELEGRAM_ADMIN_USER_IDS: '111,222',
  TELEGRAM_OPERATIONS_CHAT_ID: '-100200300'
};

function installProperties(properties) {
  global.PropertiesService = {
    getScriptProperties: () => ({ getProperty: (name) => properties[name] || null })
  };
}

function installMenuSource(result) {
  global.BotOrderWebhookClient = {
    fetchMenuCatalog: () => {
      if (result && result.error) throw new Error(result.error);
      return result && result.products
        ? result.products
        : [{ productId: 'p1', name: 'Coffee', price: 35000, isAvailable: true }];
    }
  };
}

test('setup validation reports missing properties', () => {
  installProperties({});
  assert.throws(() => SystemSetup.validateConfiguration(), /Missing required script properties/);
  installProperties(validProperties);
  assert.deepEqual(SystemSetup.validateConfiguration(), { properties: 'ok' });
});

test('checkBotOrderWebhook reports live webhook failures without throwing', () => {
  installProperties(validProperties);
  installMenuSource({ error: 'Bot order webhook returned HTTP 503' });
  assert.deepEqual(SystemSetup.checkBotOrderWebhook(), {
    status: 'error',
    message: 'Bot order webhook returned HTTP 503'
  });
  installMenuSource();
  assert.deepEqual(SystemSetup.checkBotOrderWebhook(), { status: 'ok', catalogProducts: 1 });
});

test('setup creates every repository sheet and validates headers without sample rows', () => {
  installProperties(validProperties);
  installMenuSource();
  const created = [];
  global.SheetRepositorySupport = {
    writableSheet(name, headers) {
      created.push({ name, headers: [...headers] });
      return {
        getRange(row, column, rowCount, columnCount) {
          return {
            getValues: () => [headers.slice(0, columnCount)],
            setValue() { throw new Error('valid headers must not be rewritten'); }
          };
        }
      };
    }
  };
  const result = SystemSetup.setupProject({ registerWebhook: false });
  assert.equal(result.configuration.properties, 'ok');
  assert.equal(result.configuration.catalogProducts, 1);
  assert.deepEqual(result.sheets, [
    'Customers', 'ConversationStates', 'ProcessedUpdates', 'FastPathSyncedUpdates',
    'FastPathSyncState', 'ZaloProcessedUpdates', 'ErrorLogs', 'OperationMetrics'
  ]);
  assert.equal(created.length, 8);
});

test('health check exposes Telegram queue and last webhook error', () => {
  installProperties(validProperties);
  installMenuSource();
  global.SheetRepositorySupport = {
    writableSheet(name, headers) {
      return {
        getRange(row, column, rowCount, columnCount) {
          return { getValues: () => [headers.slice(0, columnCount)], setValue() {} };
        }
      };
    }
  };
  global.TelegramClient = {
    create: () => ({ execute: () => ({
      ok: true,
      result: {
        url: 'https://telegram-gateway.example.workers.dev',
        pending_update_count: 0
      }
    }) })
  };
  const result = SystemSetup.healthCheck();
  assert.equal(result.telegramWebhook.status, 'ok');
  assert.equal(result.telegramWebhook.pendingUpdates, 0);
  assert.equal(result.telegramWebhook.expectedUrl, validProperties.TELEGRAM_WEBHOOK_URL);
});

test('health check reports a Telegram webhook that bypasses the gateway', () => {
  installProperties(validProperties);
  installMenuSource();
  global.SheetRepositorySupport = {
    writableSheet(name, headers) {
      return {
        getRange() {
          return { getValues: () => [headers], setValue() {} };
        }
      };
    }
  };
  global.TelegramClient = {
    create: () => ({ execute: () => ({
      ok: true,
      result: { url: validProperties.WEB_APP_URL, pending_update_count: 0 }
    }) })
  };

  const result = SystemSetup.healthCheck();
  assert.equal(result.telegramWebhook.status, 'misconfigured');
  assert.equal(result.telegramWebhook.url, validProperties.WEB_APP_URL);
});
