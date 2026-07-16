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
  global.SheetOrderRepository = () => ({
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
  global.SheetOrderRepository = () => ({
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
  global.SheetOrderRepository = () => ({ findById: () => null });

  const response = AdminApi.doAdminPostWithoutMetrics({
    parameter: { action: 'get_order', admin_token: 'admin-secret', orderId: 'missing' }
  });

  assert.deepEqual(readJsonResponse(response), { ok: false, error: 'ORDER_NOT_FOUND' });
});

test('get_order returns the order and a redacted customer', () => {
  global.SheetOrderRepository = () => ({
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

test('get_catalog reads from TelegramRuntime', () => {
  global.TelegramRuntime = { loadCatalog: () => [{ productId: 'p1', name: 'Trà đá', price: 5000, isAvailable: true }] };

  const response = AdminApi.doAdminPostWithoutMetrics({
    parameter: { action: 'get_catalog', admin_token: 'admin-secret' }
  });

  assert.deepEqual(readJsonResponse(response), {
    ok: true,
    catalog: [{ productId: 'p1', name: 'Trà đá', price: 5000, isAvailable: true }]
  });
});

test('unknown actions and thrown errors are reported without crashing', () => {
  const unknown = AdminApi.doAdminPostWithoutMetrics({
    parameter: { action: 'delete_everything', admin_token: 'admin-secret' }
  });
  assert.deepEqual(readJsonResponse(unknown), { ok: false, error: 'UNKNOWN_ACTION' });

  global.SheetOrderRepository = () => ({
    findAwaitingPaymentOlderThan() { throw new Error('sheet unavailable'); }
  });
  const errored = AdminApi.doAdminPostWithoutMetrics({
    parameter: { action: 'list_pending', admin_token: 'admin-secret' }
  });
  assert.deepEqual(readJsonResponse(errored), {
    ok: false, error: 'INTERNAL_ERROR', message: 'sheet unavailable'
  });
});
