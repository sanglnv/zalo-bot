'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require.extensions['.gs'] = require.extensions['.js'];

function loadRepository(mock) {
  global.BotOrderWebhookClient = mock;
  delete require.cache[require.resolve('../repositories/BotOrderRepository.gs')];
  return require('../repositories/BotOrderRepository.gs');
}

test('save() on a fresh AWAITING_PAYMENT order creates it remotely and mutates orderId in place', () => {
  const calls = [];
  const repo = loadRepository({
    createOrder(input) {
      calls.push(input);
      return { orderId: 'HD-REMOTE-1', createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z', items: [] };
    }
  })();
  const order = {
    orderId: 'local-uuid-1',
    customerId: 'c1',
    items: [{ productId: 'p1', quantity: 2 }],
    status: 'AWAITING_PAYMENT',
    totalAmount: 70000,
    createdAt: 'local-created',
    updatedAt: 'local-created'
  };
  const result = repo.save(order);
  assert.equal(order.orderId, 'HD-REMOTE-1'); // mutated in place
  assert.equal(result, order); // same reference
  assert.equal(order.createdAt, '2026-07-18T00:00:00.000Z');
  assert.equal(calls[0].clawbotOrderId, 'local-uuid-1');
  assert.equal(calls[0].customerId, 'c1');
  assert.equal(calls[0].memberId, null, 'no memberId on the order defaults to null, not undefined');
});

test('save() passes memberId through to createOrder when the order carries one', () => {
  const calls = [];
  const repo = loadRepository({
    createOrder(input) {
      calls.push(input);
      return { orderId: 'HD-REMOTE-1', createdAt: 'a', updatedAt: 'a', items: [] };
    }
  })();
  repo.save({
    orderId: 'local-uuid-1', customerId: 'c1', memberId: 'M1',
    items: [], status: 'AWAITING_PAYMENT', totalAmount: 70000, createdAt: 'a', updatedAt: 'a'
  });
  assert.equal(calls[0].memberId, 'M1');
});

test('save() with status PAID calls completeOrder with the hardcoded bank_transfer payment method', () => {
  const calls = [];
  const repo = loadRepository({
    completeOrder(orderId, paymentMethod) {
      calls.push({ orderId, paymentMethod });
      return { orderId, duplicate: false };
    }
  })();
  const order = {
    orderId: 'HD-REMOTE-1', customerId: 'c1', items: [], status: 'PAID',
    totalAmount: 70000, createdAt: 'a', updatedAt: 'b', confirmedAt: 'b', confirmedBy: 'staff@example.com'
  };
  repo.save(order);
  assert.deepEqual(calls, [{ orderId: 'HD-REMOTE-1', paymentMethod: 'bank_transfer' }]);
});

test('save() with status EXPIRED calls cancelOrder with reason payment_timeout', () => {
  const calls = [];
  const repo = loadRepository({
    cancelOrder(orderId, reason) {
      calls.push({ orderId, reason });
      return { orderId, duplicate: false };
    }
  })();
  repo.save({
    orderId: 'HD-REMOTE-1', customerId: 'c1', items: [], status: 'EXPIRED',
    totalAmount: 70000, createdAt: 'a', updatedAt: 'b'
  });
  assert.deepEqual(calls, [{ orderId: 'HD-REMOTE-1', reason: 'payment_timeout' }]);
});

test('save() rejects any status it does not know how to route', () => {
  const repo = loadRepository({})();
  assert.throws(
    () => repo.save({ orderId: 'HD1', status: 'DONE' }),
    /does not support status: DONE/
  );
});

test('updateStatus only supports CANCELLED and routes to cancelOrder with reason customer_cancelled', () => {
  const calls = [];
  const repo = loadRepository({
    cancelOrder(orderId, reason) {
      calls.push({ orderId, reason });
      return { orderId, duplicate: false };
    }
  })();
  assert.equal(repo.updateStatus('HD1', 'CANCELLED'), true);
  assert.deepEqual(calls, [{ orderId: 'HD1', reason: 'customer_cancelled' }]);
  assert.throws(() => repo.updateStatus('HD1', 'PAID'), /only supports CANCELLED/);
});

test('findById and findByCustomerId delegate directly to the webhook client', () => {
  const repo = loadRepository({
    getOrder: (orderId) => (orderId === 'HD1' ? { orderId: 'HD1' } : null),
    findOrdersByCustomerId: (customerId) => (customerId === 'c1' ? [{ orderId: 'HD1' }] : [])
  })();
  assert.deepEqual(repo.findById('HD1'), { orderId: 'HD1' });
  assert.equal(repo.findById('missing'), null);
  assert.deepEqual(repo.findByCustomerId('c1'), [{ orderId: 'HD1' }]);
});

test('findByCustomerId fails soft to [] when the POS rejects the action as not allowed', () => {
  const repo = loadRepository({
    findOrdersByCustomerId: () => { throw new Error('Webhook action is not allowed'); }
  })();
  assert.deepEqual(repo.findByCustomerId('c1'), []);
});

test('findByCustomerId still rethrows errors unrelated to the not-allowed permission gap', () => {
  const repo = loadRepository({
    findOrdersByCustomerId: () => { throw new Error('Bot order webhook returned HTTP 500'); }
  })();
  assert.throws(() => repo.findByCustomerId('c1'), /returned HTTP 500/);
});

test('findAwaitingPaymentOlderThan filters listOpenOrders by status/cutoff, sorts oldest first, and caps at limit', () => {
  const repo = loadRepository({
    listOpenOrders: () => [
      { orderId: 'fresh', status: 'AWAITING_PAYMENT', createdAt: '2026-07-13T09:50:00.000Z' },
      { orderId: 'paid-somehow', status: 'PAID', createdAt: '2026-07-13T08:00:00.000Z' },
      { orderId: 'old-2', status: 'AWAITING_PAYMENT', createdAt: '2026-07-13T09:00:00.000Z' },
      { orderId: 'old-1', status: 'AWAITING_PAYMENT', createdAt: '2026-07-13T08:30:00.000Z' }
    ]
  })();
  const selected = repo.findAwaitingPaymentOlderThan('2026-07-13T09:30:00.000Z', 10);
  assert.deepEqual(selected.map((o) => o.orderId), ['old-1', 'old-2']);
});

test('findAwaitingPaymentOlderThan validates cutoff and limit', () => {
  const repo = loadRepository({ listOpenOrders: () => [] })();
  assert.throws(() => repo.findAwaitingPaymentOlderThan('not-a-date', 10), /cutoffIso must be a valid timestamp/);
  assert.throws(() => repo.findAwaitingPaymentOlderThan('2026-07-13T09:30:00.000Z', 0), /limit must be a positive integer/);
});
