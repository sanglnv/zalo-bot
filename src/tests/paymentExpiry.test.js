'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PaymentExpiryRunner = require('../admin/paymentExpiry');

require.extensions['.gs'] = require.extensions['.js'];

function order(id, status, createdAt) {
  return {
    orderId: id,
    customerId: 'customer-' + id,
    items: [],
    status,
    totalAmount: 100,
    createdAt,
    updatedAt: createdAt,
    confirmedAt: null,
    confirmedBy: null
  };
}

function asRow(value) {
  return [
    value.orderId, value.customerId, JSON.stringify(value.items), value.status,
    value.totalAmount, value.createdAt, value.updatedAt, '', ''
  ];
}

test('SheetOrderRepository selects only stale awaiting-payment orders, oldest first', () => {
  const values = [
    order('fresh', 'AWAITING_PAYMENT', '2026-07-13T09:50:00.000Z'),
    order('paid', 'PAID', '2026-07-13T08:00:00.000Z'),
    order('old-2', 'AWAITING_PAYMENT', '2026-07-13T09:00:00.000Z'),
    order('cancelled', 'CANCELLED', '2026-07-13T08:00:00.000Z'),
    order('old-1', 'AWAITING_PAYMENT', '2026-07-13T08:30:00.000Z')
  ];
  global.SheetRepositorySupport = {
    readSheet: () => ({}),
    rows: () => values.map(asRow)
  };
  delete require.cache[require.resolve('../repositories/SheetOrderRepository.gs')];
  const SheetOrderRepository = require('../repositories/SheetOrderRepository.gs');
  const selected = SheetOrderRepository().findAwaitingPaymentOlderThan(
    '2026-07-13T09:30:00.000Z',
    10
  );
  assert.deepEqual(selected.map((candidate) => candidate.orderId), ['old-1', 'old-2']);
});

test('expiry scan isolates errors and distinguishes notification failure', () => {
  const candidates = [
    order('notify-fails', 'AWAITING_PAYMENT', '2026-07-13T08:00:00.000Z'),
    order('domain-fails', 'AWAITING_PAYMENT', '2026-07-13T08:10:00.000Z'),
    order('succeeds', 'AWAITING_PAYMENT', '2026-07-13T08:20:00.000Z')
  ];
  const logs = [];
  const expired = [];
  const runner = PaymentExpiryRunner.create({
    orderRepository: { findAwaitingPaymentOlderThan: () => candidates },
    orderService: {
      expireOrder(orderId) {
        if (orderId === 'domain-fails') throw new Error('sheet unavailable');
        expired.push(orderId);
        return {
          customer: {
            customerId: 'customer-' + orderId,
            platformLinks: [{ platform: 'alpha', platformUserId: 'chat-' + orderId }]
          },
          outboundMessages: [{ type: 'text', content: { text: 'Expired' } }]
        };
      }
    },
    dispatchNotifications(customer) {
      if (customer.customerId === 'customer-notify-fails') throw new Error('channel unavailable');
      return [{ platform: 'alpha', skipped: false }];
    },
    registry: { alpha: {} },
    errorLogRepository: { log(entry) { logs.push(entry); } },
    now: () => new Date('2026-07-13T10:00:00.000Z'),
    timeoutMinutes: 30,
    batchLimit: 50
  });

  const summary = runner.scan();
  assert.deepEqual(expired, ['notify-fails', 'succeeds']);
  assert.equal(summary.scanned, 3);
  assert.equal(summary.expired, 2);
  assert.equal(summary.notificationFailed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.results[0].reason, 'expired_but_notification_failed');
  assert.equal(summary.results[1].reason, 'error');
  assert.equal(summary.results[2].ok, true);
  assert.deepEqual(logs.map((entry) => entry.context.stage), [
    'expiry_notification_dispatch', 'expire_order'
  ]);
  assert.equal(logs[0].context.platformLinks[0].platformUserId, 'chat-notify-fails');
});

test('expiry scan caps each run at 50 orders', () => {
  const candidates = Array.from({ length: 60 }, (_, index) =>
    order('order-' + index, 'AWAITING_PAYMENT', '2026-07-13T08:00:00.000Z')
  );
  var receivedLimit = null;
  var expiredCount = 0;
  const runner = PaymentExpiryRunner.create({
    orderRepository: {
      findAwaitingPaymentOlderThan(cutoff, limit) {
        receivedLimit = limit;
        return candidates.slice(0, limit);
      }
    },
    orderService: {
      expireOrder(orderId) {
        expiredCount += 1;
        return { customer: { platformLinks: [] }, outboundMessages: [] };
      }
    },
    dispatchNotifications: () => [],
    errorLogRepository: { log() {} },
    now: () => new Date('2026-07-13T10:00:00.000Z'),
    timeoutMinutes: 30,
    batchLimit: 500
  });

  const summary = runner.scan();
  assert.equal(receivedLimit, 50);
  assert.equal(summary.scanned, 50);
  assert.equal(expiredCount, 50);
});

test('already-resolved race loser does not block later candidates or log a system error', () => {
  const candidates = [
    order('resolved', 'AWAITING_PAYMENT', '2026-07-13T08:00:00.000Z'),
    order('next', 'AWAITING_PAYMENT', '2026-07-13T08:10:00.000Z')
  ];
  const logs = [];
  const runner = PaymentExpiryRunner.create({
    orderRepository: { findAwaitingPaymentOlderThan: () => candidates },
    orderService: {
      expireOrder(orderId) {
        if (orderId === 'resolved') {
          const error = new Error('already paid');
          error.code = 'PAYMENT_ALREADY_RESOLVED';
          throw error;
        }
        return { customer: { platformLinks: [] }, outboundMessages: [] };
      }
    },
    dispatchNotifications: () => [],
    errorLogRepository: { log(entry) { logs.push(entry); } },
    now: () => new Date('2026-07-13T10:00:00.000Z')
  });

  const summary = runner.scan();
  assert.equal(summary.resolved, 1);
  assert.equal(summary.expired, 1);
  assert.equal(summary.results[1].ok, true);
  assert.equal(logs.length, 0);
});
