'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
require.extensions['.gs'] = require.extensions['.js'];

const OrderService = require('../../core/orderService');
const { ZaloWebhook } = require('../../adapters/zalo/webhook.gs');
const { mapInboundMessage } = require('../../adapters/zalo/mapInboundMessage');
const { renderOutboundMessage } = require('../../adapters/zalo/renderOutboundMessage');

function setup() {
  const errors = [];
  const calls = [];
  const processed = new Map();
  const customers = [];
  const orders = [];
  const states = new Map();
  let id = 0;
  let handleCount = 0;
  global.ContentService = {
    MimeType: { TEXT: 'text/plain' },
    createTextOutput(text) { return { text, setMimeType(value) { this.mimeType = value; return this; } }; }
  };
  const service = OrderService.create({
    orderRepository: {
      save(order) { const old = orders.findIndex((x) => x.orderId === order.orderId); if (old < 0) orders.push(structuredClone(order)); else orders[old] = structuredClone(order); return order; },
      findById: (orderId) => orders.find((x) => x.orderId === orderId) || null,
      findByCustomerId: (customerId) => orders.filter((x) => x.customerId === customerId),
      updateStatus(orderId, status) { orders.find((x) => x.orderId === orderId).status = status; }
    },
    customerRepository: {
      save(customer) { customers.push(structuredClone(customer)); return customer; },
      findById: (customerId) => customers.find((x) => x.customerId === customerId) || null,
      findByPlatformUserId: (platform, userId) => customers.find((x) => x.platformLinks.some((l) => l.platform === platform && l.platformUserId === userId)) || null
    },
    conversationStateRepository: {
      get: (customerId) => states.get(customerId) || null,
      set(customerId, state) { states.set(customerId, structuredClone(state)); return state; }
    },
    getCatalog: () => [{ productId: 'p1', name: 'Coffee', price: 35000, isAvailable: true }],
    createQrContent: (order) => `https://img.vietqr.io/qr.png?amount=${order.totalAmount}`,
    createId: () => `id-${++id}`,
    now: () => new Date('2026-07-14T00:00:00.000Z'),
    withLock: (operation) => operation()
  });
  const webhook = ZaloWebhook.create({
    mapInboundMessage,
    renderOutboundMessage,
    verifySignature: (mac) => mac === 'valid',
    withLock: (operation) => operation(),
    now: () => new Date('2026-07-14T00:00:00.000Z'),
    orderService: { handleMessage(message) { handleCount += 1; return service.handleMessage(message); } },
    processedUpdateRepository: {
      has: (key) => processed.has(key),
      markProcessed(key) { processed.set(key, 'pending'); },
      updateDeliveryStatus(key, status) { processed.set(key, status); }
    },
    errorLogRepository: { log(entry) { errors.push(entry); } },
    client: { execute(command) { calls.push(command); return { error: 0 }; } },
    fallbackMessage: () => 'Fallback'
  });
  function post(messageId, text, mac = 'valid') {
    const body = { app_id: 'app', timestamp: '1', event_name: 'user_send_text', sender: { id: 'u1' }, message: { msg_id: messageId, text } };
    return webhook.doPost({ headers: { 'X-ZEvent-Signature': mac }, postData: { contents: JSON.stringify(body) } });
  }
  return { webhook, post, errors, calls, processed, orders, getHandleCount: () => handleCount };
}

test('end-to-end catalog to QR uses normal Zalo Send API and dedupes msg_id', () => {
  const f = setup();
  f.post('m1', 'catalog');
  f.post('m2', 'zc:add_item:p1:1');
  f.post('m3', 'checkout');
  f.post('m4', 'zc:confirm_order');
  f.post('m4', 'zc:confirm_order');
  assert.equal(f.getHandleCount(), 4);
  assert.equal(f.orders.length, 1);
  const image = f.calls.find((call) => call.params.message.attachment && call.params.message.attachment.payload.template_type === 'media');
  assert.ok(image, 'QR must be rendered as a Send API media message');
  assert.match(image.params.message.attachment.payload.elements[0].url, /^https:\/\/img\.vietqr\.io/);
  assert.equal(f.processed.get('m4'), 'delivered');
  assert.equal(f.errors.length, 0);
});

test('invalid signature is logged separately and never reaches business logic', () => {
  const f = setup();
  const response = f.post('bad-1', 'catalog', 'invalid');
  assert.equal(response.text, 'OK');
  assert.equal(f.getHandleCount(), 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.errors[0].context.stage, 'signature_verification');
});

test('invalid customer flow returns guidance instead of a system fallback', () => {
  const f = setup();
  f.post('m-invalid', 'zc:confirm_order');
  assert.equal(f.processed.get('m-invalid'), 'delivered');
  assert.equal(f.calls.some((call) => call.params.message.text === 'Fallback'), false);
  assert.ok(f.calls.some((call) => /chọn sản phẩm/.test(call.params.message.text)));
  assert.equal(f.errors[0].context.stage, 'user_action');
  assert.equal(f.errors[0].context.currentState, 'IDLE');
});
