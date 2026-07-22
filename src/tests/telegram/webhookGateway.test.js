'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require.extensions['.gs'] = require.extensions['.js'];

const telegramWebhookModule = require('../../adapters/telegram/webhook.gs');
const webhookRouter = require('../../adapters/webhookRouter.gs');

function installProperties(values) {
  global.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (name) => values[name] || null
    })
  };
}

function installUtilities() {
  global.Utilities = {
    DigestAlgorithm: { SHA_256: 'sha256' },
    Charset: { UTF_8: 'utf8' },
    computeDigest(_algorithm, value) {
      return Array.from(crypto.createHash('sha256').update(value, 'utf8').digest());
    }
  };
}

test('registerWebhook requires and registers the Cloudflare gateway', () => {
  const calls = [];
  installProperties({
    TELEGRAM_WEBHOOK_URL: 'https://telegram-gateway.example.workers.dev',
    TELEGRAM_WEBHOOK_SECRET: 'telegram-secret'
  });
  global.TelegramClient = {
    create: () => ({ execute(operation) { calls.push(operation); return { ok: true }; } })
  };

  const result = telegramWebhookModule.registerWebhook(false);

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    {
      method: 'setWebhook',
      params: {
        url: 'https://telegram-gateway.example.workers.dev',
        allowed_updates: ['message', 'callback_query'],
        max_connections: 1,
        drop_pending_updates: false,
        secret_token: 'telegram-secret'
      }
    },
    {
      method: 'setMyCommands',
      params: {
        commands: [
          { command: 'batdau', description: 'Bắt đầu đặt món' },
          { command: 'danhmuc', description: 'Xem danh mục món đang bán' },
          { command: 'phong', description: 'Đặt phòng sleepbox' },
          { command: 'giohang', description: 'Xem giỏ hàng hiện tại' },
          { command: 'dathang', description: 'Kiểm tra và xác nhận giỏ hàng' },
          { command: 'xemdon', description: 'Xem trạng thái đơn gần nhất' },
          { command: 'huydon', description: 'Hủy giỏ hoặc đơn hiện tại' },
          { command: 'thanhtoan', description: 'Nhận mã QR thanh toán' },
          { command: 'trogiup', description: 'Xem hướng dẫn sử dụng bot' }
        ]
      }
    },
    {
      method: 'setMyCommands',
      params: {
        commands: [
          { command: 'batdau', description: 'Bắt đầu đặt món' },
          { command: 'danhmuc', description: 'Xem danh mục món đang bán' },
          { command: 'phong', description: 'Đặt phòng sleepbox' },
          { command: 'giohang', description: 'Xem giỏ hàng hiện tại' },
          { command: 'dathang', description: 'Kiểm tra và xác nhận giỏ hàng' },
          { command: 'xemdon', description: 'Xem trạng thái đơn gần nhất' },
          { command: 'huydon', description: 'Hủy giỏ hoặc đơn hiện tại' },
          { command: 'thanhtoan', description: 'Nhận mã QR thanh toán' },
          { command: 'trogiup', description: 'Xem hướng dẫn sử dụng bot' }
        ],
        language_code: 'vi'
      }
    }
  ]);
});

test('registerWebhook refuses a direct GAS webhook or missing secret', () => {
  installProperties({ TELEGRAM_WEBHOOK_SECRET: 'telegram-secret' });
  assert.throws(
    () => telegramWebhookModule.registerWebhook(false),
    /TELEGRAM_WEBHOOK_URL/
  );

  installProperties({ TELEGRAM_WEBHOOK_URL: 'https://gateway.example' });
  assert.throws(
    () => telegramWebhookModule.registerWebhook(false),
    /TELEGRAM_WEBHOOK_SECRET/
  );
});

test('router accepts only Telegram requests authenticated by the gateway', () => {
  installUtilities();
  installProperties({ GAS_GATEWAY_TOKEN: 'gas-secret' });
  global.ContentService = {
    MimeType: { TEXT: 'text/plain' },
    createTextOutput: (text) => ({
      text,
      setMimeType(mimeType) { this.mimeType = mimeType; return this; }
    })
  };
  global.recordDuration = (_operation, fn) => fn();
  global.doZaloPost = () => ({ channel: 'zalo' });
  let telegramCalls = 0;
  global.doTelegramPostWithoutMetrics = () => {
    telegramCalls += 1;
    return { channel: 'telegram' };
  };
  const synced = [];
  global.syncTelegramFastPathSnapshot = (snapshot) => { synced.push(snapshot); };

  const valid = webhookRouter.doPost({
    parameter: { platform: 'telegram', gateway_token: 'gas-secret' },
    postData: { contents: JSON.stringify({ update_id: 1 }) }
  });
  const invalid = webhookRouter.doPost({
    parameter: { platform: 'telegram', gateway_token: 'wrong' },
    postData: { contents: JSON.stringify({ update_id: 2 }) }
  });
  const direct = webhookRouter.doPost({
    parameter: {},
    postData: { contents: JSON.stringify({ update_id: 3 }) }
  });
  const probe = webhookRouter.doPost({
    parameter: {
      platform: 'telegram',
      gateway_token: 'gas-secret',
      gateway_probe: '1'
    },
    postData: { contents: '{}' }
  });
  const sync = webhookRouter.doPost({
    parameter: {
      platform: 'telegram', gateway_token: 'gas-secret', gateway_mode: 'fast_path_sync'
    },
    postData: { contents: JSON.stringify({ kind: 'fast_path_sync', updateId: 4 }) }
  });

  assert.deepEqual(valid, { channel: 'telegram' });
  assert.deepEqual(invalid, { text: 'GATEWAY_AUTH_FAILED', mimeType: 'text/plain', setMimeType: invalid.setMimeType });
  assert.deepEqual(direct, { text: 'OK', mimeType: 'text/plain', setMimeType: direct.setMimeType });
  assert.deepEqual(probe, { text: 'GATEWAY_OK', mimeType: 'text/plain', setMimeType: probe.setMimeType });
  assert.deepEqual(sync, { text: 'SYNC_OK', mimeType: 'text/plain', setMimeType: sync.setMimeType });
  assert.deepEqual(synced, [{ kind: 'fast_path_sync', updateId: 4 }]);
  assert.equal(telegramCalls, 1);
});

test('gateway token comparison rejects missing and different values', () => {
  installUtilities();
  assert.equal(webhookRouter.secureGatewayTokenEquals('same', 'same'), true);
  assert.equal(webhookRouter.secureGatewayTokenEquals('same', 'other'), false);
  assert.equal(webhookRouter.secureGatewayTokenEquals('', 'other'), false);
});
