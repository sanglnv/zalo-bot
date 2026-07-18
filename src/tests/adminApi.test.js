'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require.extensions['.gs'] = require.extensions['.js'];

const AdminApi = require('../admin/AdminApi.gs');
const webhookRouter = require('../adapters/webhookRouter.gs');

global.secureGatewayTokenEquals = webhookRouter.secureGatewayTokenEquals;

function installUtilities() {
  global.Utilities = {
    DigestAlgorithm: { SHA_256: 'sha256' },
    Charset: { UTF_8: 'utf8' },
    computeDigest(_algorithm, value) {
      return Array.from(crypto.createHash('sha256').update(value, 'utf8').digest());
    }
  };
}

function installProperties(values) {
  global.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (name) => (values[name] != null ? values[name] : null)
    })
  };
}

function installContentService() {
  global.ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput: (text) => ({
      text,
      setMimeType(mimeType) { this.mimeType = mimeType; return this; }
    })
  };
}

function readJsonResponse(response) {
  return JSON.parse(response.text);
}

test.beforeEach(() => {
  installUtilities();
  installContentService();
  installProperties({ ADMIN_API_TOKEN: 'admin-secret' });
  global.recordDuration = (_operation, fn) => fn();
  global.SheetErrorLogRepository = () => ({ log() {} });
  delete global.UrlFetchApp;
});

test('rejects requests with a missing or wrong admin token', () => {
  const missing = AdminApi.doAdminPostWithoutMetrics({ parameter: { action: 'get_catalog' } });
  const wrong = AdminApi.doAdminPostWithoutMetrics({
    parameter: { action: 'get_catalog', admin_token: 'nope' }
  });
  assert.deepEqual(readJsonResponse(missing), { ok: false, error: 'UNAUTHORIZED' });
  assert.deepEqual(readJsonResponse(wrong), { ok: false, error: 'UNAUTHORIZED' });
});

test('list_pending returns orders from the order repository', () => {
  const orders = [
    { orderId: 'o1', customerId: 'c1', status: 'AWAITING_PAYMENT', totalAmount: 50000,
      items: [], createdAt: '2026-07-13T09:00:00.000Z', updatedAt: '2026-07-13T09:00:00.000Z' }
  ];
  global.BotOrderRepository = () => ({
    findAwaitingPaymentOlderThan(_cutoff, limit) {
      assert.equal(limit, 20);
      return orders;
    }
  });

  const response = AdminApi.doAdminPostWithoutMetrics({
    parameter: { action: 'list_pending', admin_token: 'admin-secret' }
  });

  assert.deepEqual(readJsonResponse(response), {
    ok: true,
    orders: [{
      orderId: 'o1', customerId: 'c1', status: 'AWAITING_PAYMENT', totalAmount: 50000,
      items: [], createdAt: '2026-07-13T09:00:00.000Z', updatedAt: '2026-07-13T09:00:00.000Z',
      confirmedAt: null, confirmedBy: null
    }]
  });
});

test('list_pending clamps an oversized limit to 50', () => {
  global.BotOrderRepository = () => ({
    findAwaitingPaymentOlderThan(_cutoff, limit) {
      assert.equal(limit, 50);
      return [];
    }
  });

  AdminApi.doAdminPostWithoutMetrics({
    parameter: { action: 'list_pending', admin_token: 'admin-secret', limit: '500' }
  });
});

test('get_order reports not found for an unknown order', () => {
  global.BotOrderRepository = () => ({ findById: () => null });

  const response = AdminApi.doAdminPostWithoutMetrics({
    parameter: { action: 'get_order', admin_token: 'admin-secret', orderId: 'missing' }
  });

  assert.deepEqual(readJsonResponse(response), { ok: false, error: 'ORDER_NOT_FOUND' });
});

test('get_order returns the order and a redacted customer', () => {
  global.BotOrderRepository = () => ({
    findById: (orderId) => (orderId === 'o1' ? {
      orderId: 'o1', customerId: 'c1', status: 'PAID', totalAmount: 50000, items: [],
      createdAt: '2026-07-13T09:00:00.000Z', updatedAt: '2026-07-13T09:05:00.000Z',
      confirmedAt: '2026-07-13T09:05:00.000Z', confirmedBy: 'staff@example.com'
    } : null)
  });
  global.SheetCustomerRepository = () => ({
    findById: (customerId) => (customerId === 'c1'
      ? { customerId: 'c1', phone: '0900000000', displayName: 'Khách A', platformLinks: [] }
      : null)
  });

  const response = AdminApi.doAdminPostWithoutMetrics({
    parameter: { action: 'get_order', admin_token: 'admin-secret', orderId: 'o1' }
  });

  assert.deepEqual(readJsonResponse(response), {
    ok: true,
    order: {
      orderId: 'o1', customerId: 'c1', status: 'PAID', totalAmount: 50000, items: [],
      createdAt: '2026-07-13T09:00:00.000Z', updatedAt: '2026-07-13T09:05:00.000Z',
      confirmedAt: '2026-07-13T09:05:00.000Z', confirmedBy: 'staff@example.com'
    },
    customer: { customerId: 'c1', phone: '0900000000', displayName: 'Khách A' }
  });
});

test('confirm_payment validates input before delegating to processOrderPayment', () => {
  const missingOrderId = AdminApi.doAdminPostWithoutMetrics({
    parameter: { action: 'confirm_payment', admin_token: 'admin-secret' },
    postData: { contents: JSON.stringify({ confirmedBy: 'openclaw:sang' }) }
  });
  assert.deepEqual(readJsonResponse(missingOrderId), { ok: false, error: 'MISSING_ORDER_ID' });

  const missingConfirmedBy = AdminApi.doAdminPostWithoutMetrics({
    parameter: { action: 'confirm_payment', admin_token: 'admin-secret' },
    postData: { contents: JSON.stringify({ orderId: 'o1' }) }
  });
  assert.deepEqual(readJsonResponse(missingConfirmedBy), { ok: false, error: 'MISSING_CONFIRMED_BY' });
});

test('confirm_payment delegates to the existing processOrderPayment path', () => {
  const calls = [];
  global.processOrderPayment = (orderId, confirmedBy) => {
    calls.push({ orderId, confirmedBy });
    return { ok: true };
  };

  const response = AdminApi.doAdminPostWithoutMetrics({
    parameter: { action: 'confirm_payment', admin_token: 'admin-secret' },
    postData: { contents: JSON.stringify({ orderId: 'o1', confirmedBy: 'openclaw:sang' }) }
  });

  assert.deepEqual(readJsonResponse(response), { ok: true });
  assert.deepEqual(calls, [{ orderId: 'o1', confirmedBy: 'openclaw:sang' }]);
});

test('get_catalog reads the live D1 catalog via the Telegram gateway when available', () => {
  installProperties({
    ADMIN_API_TOKEN: 'admin-secret',
    TELEGRAM_WEBHOOK_URL: 'https://telegram-gateway.example.workers.dev/',
    GAS_GATEWAY_TOKEN: 'gateway-secret'
  });
  const calls = [];
  global.UrlFetchApp = {
    fetch(url, options) {
      calls.push({ url, options });
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          ok: true,
          source: 'd1',
          catalog: [{ productId: 'p1', name: 'Cà phê', price: 35000, isAvailable: true }]
        })
      };
    }
  };
  global.TelegramRuntime = { loadCatalog: () => { throw new Error('should not be used'); } };

  const response = AdminApi.doAdminPostWithoutMetrics({
    parameter: { action: 'get_catalog', admin_token: 'admin-secret' }
  });

  assert.deepEqual(readJsonResponse(response), {
    ok: true,
    source: 'd1_fast_path',
    catalog: [{ productId: 'p1', name: 'Cà phê', price: 35000, isAvailable: true }]
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://telegram-gateway.example.workers.dev/internal/catalog');
  assert.equal(calls[0].options.headers['X-GAS-Gateway-Token'], 'gateway-secret');
});

test('get_catalog falls back to TelegramRuntime (CATALOG_JSON) when the gateway is unreachable', () => {
  installProperties({
    ADMIN_API_TOKEN: 'admin-secret',
    TELEGRAM_WEBHOOK_URL: 'https://telegram-gateway.example.workers.dev/',
    GAS_GATEWAY_TOKEN: 'gateway-secret'
  });
  global.UrlFetchApp = {
    fetch() { throw new Error('network unreachable'); }
  };
  global.TelegramRuntime = { loadCatalog: () => [{ productId: 'p1', name: 'Trà đá', price: 5000, isAvailable: true }] };

  const response = AdminApi.doAdminPostWithoutMetrics({
    parameter: { action: 'get_catalog', admin_token: 'admin-secret' }
  });

  assert.deepEqual(readJsonResponse(response), {
    ok: true,
    source: 'catalog_json_fallback',
    catalog: [{ productId: 'p1', name: 'Trà đá', price: 5000, isAvailable: true }]
  });
});

test('get_catalog falls back to TelegramRuntime when gateway properties are not configured', () => {
  installProperties({ ADMIN_API_TOKEN: 'admin-secret' });
  global.TelegramRuntime = { loadCatalog: () => [{ productId: 'p1', name: 'Trà đá', price: 5000, isAvailable: true }] };

  const response = AdminApi.doAdminPostWithoutMetrics({
    parameter: { action: 'get_catalog', admin_token: 'admin-secret' }
  });

  assert.deepEqual(readJsonResponse(response), {
    ok: true,
    source: 'catalog_json_fallback',
    catalog: [{ productId: 'p1', name: 'Trà đá', price: 5000, isAvailable: true }]
  });
});

test('get_catalog_from_pos always reads the POS webhook directly, never the D1 mirror', () => {
  global.BotOrderWebhookClient = {
    fetchMenuCatalog: () => [{ productId: 'p1', name: 'Cà phê', price: 35000, isAvailable: true }]
  };
  global.UrlFetchApp = { fetch() { throw new Error('must not call the D1 gateway for this action'); } };

  const response = AdminApi.doAdminPostWithoutMetrics({
    parameter: { action: 'get_catalog_from_pos', admin_token: 'admin-secret' }
  });

  assert.deepEqual(readJsonResponse(response), {
    ok: true,
    source: 'bot_order_webhook',
    catalog: [{ productId: 'p1', name: 'Cà phê', price: 35000, isAvailable: true }]
  });
});

test('unknown actions and thrown errors are reported without crashing', () => {
  const unknown = AdminApi.doAdminPostWithoutMetrics({
    parameter: { action: 'delete_everything', admin_token: 'admin-secret' }
  });
  assert.deepEqual(readJsonResponse(unknown), { ok: false, error: 'UNKNOWN_ACTION' });

  global.BotOrderRepository = () => ({
    findAwaitingPaymentOlderThan() { throw new Error('sheet unavailable'); }
  });
  const errored = AdminApi.doAdminPostWithoutMetrics({
    parameter: { action: 'list_pending', admin_token: 'admin-secret' }
  });
  assert.deepEqual(readJsonResponse(errored), {
    ok: false, error: 'INTERNAL_ERROR', message: 'sheet unavailable'
  });
});
