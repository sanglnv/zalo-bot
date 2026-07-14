'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PaymentConfirmationHandler = require('../admin/paymentConfirmation');
const OrderService = require('../core/orderService');

function fixture(confirmPayment, dispatchImplementation) {
  const logs = [];
  const dispatches = [];
  const handler = PaymentConfirmationHandler.create({
    orderService: { confirmPayment },
    dispatchNotifications(customer, messages, registry) {
      dispatches.push({ customer, messages, registry });
      if (dispatchImplementation) return dispatchImplementation(customer, messages, registry);
      return [{ platform: 'alpha', skipped: false }];
    },
    registry: { alpha: {} },
    errorLogRepository: { log(entry) { logs.push(entry); } },
    now: () => new Date('2026-07-13T10:00:00.000Z')
  });
  return { handler, logs, dispatches };
}

test('payment handler confirms and dispatches normalized notifications', () => {
  const customer = { platformLinks: [{ platform: 'alpha', platformUserId: '1' }] };
  const outboundMessages = [{ type: 'text', content: { text: 'Paid' } }];
  const f = fixture(() => ({ customer, outboundMessages }));
  assert.deepEqual(f.handler.process('o1', 'staff'), {
    ok: true, dispatchResults: [{ platform: 'alpha', skipped: false }]
  });
  assert.deepEqual(f.dispatches[0].customer, customer);
  assert.equal(f.logs.length, 0);
});

test('payment handler treats already-resolved as a non-error', () => {
  const f = fixture(() => { const error = new Error('resolved'); error.code = 'PAYMENT_ALREADY_RESOLVED'; throw error; });
  assert.deepEqual(f.handler.process('o1', 'staff'), { ok: false, reason: 'already_resolved' });
  assert.equal(f.logs.length, 0);
});

test('payment handler distinguishes and logs not-found and system errors', () => {
  const missing = fixture(() => { const error = new Error('missing'); error.code = 'ORDER_NOT_FOUND'; throw error; });
  assert.deepEqual(missing.handler.process('o1', 'staff'), {
    ok: false, reason: 'not_found', message: 'missing'
  });
  assert.equal(missing.logs.length, 1);
  assert.equal(missing.logs[0].context.stage, 'confirm_payment');

  const broken = fixture(() => { throw new Error('storage failed'); });
  assert.deepEqual(broken.handler.process('o1', 'staff'), {
    ok: false, reason: 'error', message: 'storage failed'
  });
  assert.equal(broken.logs.length, 1);
  assert.equal(broken.logs[0].context.stage, 'confirm_payment');
});

test('payment handler distinguishes a committed payment from notification failure', () => {
  const customer = {
    customerId: 'c1',
    platformLinks: [{ platform: 'alpha', platformUserId: 'chat-1' }]
  };
  const outboundMessages = [{ type: 'text', content: { text: 'Paid' } }];
  const f = fixture(
    () => ({ customer, outboundMessages }),
    () => { throw new Error('channel unavailable'); }
  );

  assert.deepEqual(f.handler.process('o1', 'staff'), {
    ok: false,
    reason: 'confirmed_but_notification_failed',
    orderId: 'o1',
    platformLinks: customer.platformLinks,
    outboundMessages,
    message: 'channel unavailable'
  });
  assert.equal(f.logs.length, 1);
  assert.deepEqual(f.logs[0].context, {
    stage: 'notification_dispatch',
    orderId: 'o1',
    confirmedBy: 'staff',
    customerId: 'c1',
    platformLinks: customer.platformLinks
  });
});

test('real OrderService stays PAID when the real handler cannot dispatch', () => {
  let order = {
    orderId: 'o-real', customerId: 'c-real', items: [], status: 'AWAITING_PAYMENT',
    totalAmount: 100000, createdAt: '2026-07-13T09:00:00.000Z',
    updatedAt: '2026-07-13T09:00:00.000Z'
  };
  let state = {
    customerId: 'c-real', currentState: 'AWAITING_PAYMENT',
    contextData: { orderId: 'o-real', cart: [] }, updatedAt: '2026-07-13T09:00:00.000Z'
  };
  const customer = {
    customerId: 'c-real', phone: null, displayName: '',
    platformLinks: [{ platform: 'alpha', platformUserId: 'chat-real' }]
  };
  const orderRepository = {
    save(value) { order = structuredClone(value); return value; },
    findById(id) { return id === order.orderId ? structuredClone(order) : null; },
    findByCustomerId(id) { return id === order.customerId ? [structuredClone(order)] : []; },
    updateStatus(id, status) { if (id === order.orderId) order.status = status; }
  };
  const customerRepository = {
    save: (value) => value,
    findById: (id) => id === customer.customerId ? structuredClone(customer) : null,
    findByPlatformUserId: () => null
  };
  const conversationStateRepository = {
    get: (id) => id === state.customerId ? structuredClone(state) : null,
    set(id, value) { state = structuredClone(value); return value; }
  };
  const service = OrderService.create({
    orderRepository,
    customerRepository,
    conversationStateRepository,
    getCatalog: () => [],
    createQrContent: () => '',
    createId: () => 'unused',
    now: () => new Date('2026-07-13T10:00:00.000Z'),
    withLock: (operation) => operation()
  });
  const logs = [];
  const handler = PaymentConfirmationHandler.create({
    orderService: service,
    dispatchNotifications: () => { throw new Error('forced dispatch failure'); },
    registry: {},
    errorLogRepository: { log(entry) { logs.push(entry); } },
    now: () => new Date('2026-07-13T10:00:00.000Z')
  });

  const result = handler.process('o-real', 'staff@example.com');
  assert.equal(order.status, 'PAID');
  assert.equal(state.currentState, 'PAID');
  assert.equal(result.reason, 'confirmed_but_notification_failed');
  assert.equal(result.message, 'forced dispatch failure');
  assert.equal(logs[0].context.stage, 'notification_dispatch');
  assert.deepEqual(logs[0].context.platformLinks, customer.platformLinks);
});
