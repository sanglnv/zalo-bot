'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const OrderService = require('../core/orderService');

function fixture(options = {}) {
  const customers = [];
  const orders = [];
  const states = new Map();
  let id = 0;
  const orderRepository = {
    save(order) {
      const index = orders.findIndex((candidate) => candidate.orderId === order.orderId);
      if (index < 0) orders.push(structuredClone(order));
      else orders[index] = structuredClone(order);
      if (options.afterOrderSave) options.afterOrderSave();
      return order;
    },
    findById(orderId) { return orders.find((order) => order.orderId === orderId) || null; },
    findByCustomerId(customerId) { return orders.filter((order) => order.customerId === customerId); },
    updateStatus(orderId, status) {
      const order = orders.find((candidate) => candidate.orderId === orderId);
      if (!order) throw new Error('Order not found');
      order.status = status;
    }
  };
  const customerRepository = {
    save(customer) { customers.push(structuredClone(customer)); return customer; },
    findById(customerId) { return customers.find((customer) => customer.customerId === customerId) || null; },
    findByPlatformUserId(platform, platformUserId) {
      return customers.find((customer) => customer.platformLinks.some(
        (link) => link.platform === platform && link.platformUserId === platformUserId
      )) || null;
    }
  };
  const conversationStateRepository = {
    get(customerId) { return states.has(customerId) ? structuredClone(states.get(customerId)) : null; },
    set(customerId, state) { states.set(customerId, structuredClone(state)); return state; }
  };
  const service = OrderService.create({
    orderRepository,
    customerRepository,
    conversationStateRepository,
    getCatalog: () => [
      { productId: 'p1', name: 'House coffee', price: 35_000, isAvailable: true },
      { productId: 'p2', name: 'Green tea', price: 20_000, isAvailable: true },
      { productId: 'p3', name: 'Unavailable item', price: 1, isAvailable: false }
    ],
    createQrContent: (order) => `qr:${order.orderId}:${order.totalAmount}`,
    createId: () => `id-${++id}`,
    now: () => new Date('2026-07-13T10:00:00.000Z'),
    withLock: options.withLock || ((operation) => operation())
  });
  const send = (text, payload = null) => service.handleMessage({
    platform: 'test-channel', platformUserId: 'user-1', text, payload
  });
  return { service, send, customers, orders, states };
}

test('catalog, cart, checkout, confirmation, and payment QR flow', () => {
  const f = fixture();
  const catalog = f.send('catalog');
  assert.equal(catalog[0].type, 'list');
  assert.deepEqual(catalog[0].content.items.map((item) => item.productId), ['p1', 'p2']);

  const added = f.send('', { action: 'add_item', productId: 'p1', quantity: 2 });
  assert.equal(added[0].type, 'button');
  assert.equal(added[0].content.cart[0].quantity, 2);

  const checkout = f.send('', { action: 'checkout' });
  assert.equal(checkout[0].type, 'button');
  assert.equal(checkout[0].content.summary.totalAmount, 70_000);

  const confirmed = f.send('', { action: 'confirm_order' });
  assert.deepEqual(confirmed.map((message) => message.type), ['text', 'image']);
  assert.equal(confirmed[1].content.data, 'qr:id-2:70000');
  assert.equal(f.orders.length, 1);
  assert.equal(f.orders[0].status, 'AWAITING_PAYMENT');
  assert.equal([...f.states.values()][0].currentState, 'AWAITING_PAYMENT');
});

test('adds two different products and keeps both in the cart through checkout', () => {
  const f = fixture();
  f.send('catalog');
  f.send('', { action: 'add_item', productId: 'p1', quantity: 1 });
  f.send('', { action: 'add_item', productId: 'p2', quantity: 2 });
  f.send('', { action: 'checkout' });

  const state = [...f.states.values()][0];
  assert.equal(state.currentState, 'CONFIRMING');
  assert.deepEqual(state.contextData.cart, [
    { productId: 'p1', name: 'House coffee', unitPrice: 35_000, quantity: 1 },
    { productId: 'p2', name: 'Green tea', unitPrice: 20_000, quantity: 2 }
  ]);
  assert.equal(state.contextData.bill.totalAmount, 75_000);
});

test('adding the same product twice accumulates its quantity', () => {
  const f = fixture();
  f.send('catalog');
  f.send('', { action: 'add_item', productId: 'p1', quantity: 2 });
  const response = f.send('', { action: 'add_item', productId: 'p1', quantity: 3 });

  assert.equal(response[0].content.cart.length, 1);
  assert.equal(response[0].content.cart[0].quantity, 5);
  assert.equal([...f.states.values()][0].contextData.cart[0].quantity, 5);
});

test('customers can decrease and remove items without cancelling the whole cart', () => {
  const f = fixture();
  f.send('catalog');
  f.send('', { action: 'add_item', productId: 'p1', quantity: 2 });
  f.send('', { action: 'add_item', productId: 'p2', quantity: 1 });
  let response = f.send('', { action: 'decrease_item', productId: 'p1' });
  assert.match(response[0].content.text, /House coffee × 1/);
  response = f.send('', { action: 'remove_item', productId: 'p2' });
  assert.doesNotMatch(response[0].content.text, /Green tea/);
  assert.deepEqual([...f.states.values()][0].contextData.cart, [
    { productId: 'p1', name: 'House coffee', unitPrice: 35000, quantity: 1 }
  ]);
});

test('cancels a cart before an order is persisted', () => {
  const f = fixture();
  f.send('browse');
  f.send('', { action: 'add_item', productId: 'p1' });
  const response = f.send('', { action: 'cancel' });
  assert.equal(response[0].content.text, 'Đã hủy đơn/giỏ hàng.');
  assert.equal(f.orders.length, 0);
  assert.equal([...f.states.values()][0].currentState, 'CANCELLED');
});

test('cancels an awaiting-payment order and updates its repository status', () => {
  const f = fixture();
  f.send('catalog');
  f.send('', { action: 'add_item', productId: 'p1' });
  f.send('', { action: 'checkout' });
  f.send('', { action: 'confirm_order' });
  f.send('', { action: 'cancel' });
  assert.equal(f.orders[0].status, 'CANCELLED');
});

test('invalid flow and invalid product fail explicitly', () => {
  const f = fixture();
  assert.throws(
    () => f.send('', { action: 'confirm_order' }),
    (error) => error instanceof OrderService.Errors.UserActionError && error.code === 'INVALID_FLOW'
  );
  const other = fixture();
  other.send('catalog');
  assert.throws(
    () => other.send('', { action: 'add_item', productId: 'missing' }),
    (error) => error instanceof OrderService.Errors.UserActionError && error.code === 'PRODUCT_UNAVAILABLE'
  );
});

test('message-wide lock prevents interleaved duplicate confirmation for one customer', () => {
  let held = false;
  const options = {
    withLock(operation) {
      if (held) throw new Error('Message transaction lock is already held');
      held = true;
      try { return operation(); } finally { held = false; }
    }
  };
  const f = fixture(options);
  f.send('catalog');
  f.send('', { action: 'add_item', productId: 'p1' });
  f.send('', { action: 'checkout' });

  let overlappingError;
  options.afterOrderSave = () => {
    options.afterOrderSave = null;
    try { f.send('', { action: 'confirm_order' }); } catch (error) { overlappingError = error; }
  };

  f.send('', { action: 'confirm_order' });
  assert.match(overlappingError.message, /transaction lock is already held/);
  assert.equal(f.orders.length, 1);

  // A queued/retried callback reloads the committed order and returns its
  // payment guidance without creating a second order.
  const retry = f.send('', { action: 'confirm_order' });
  assert.match(retry[0].content.text, /chờ thanh toán/);
  assert.equal(f.orders.length, 1);
});

test('catalog is repeatable and preserves an active cart', () => {
  const f = fixture();
  f.send('/catalog');
  const repeated = f.send('catalog');
  assert.equal(repeated[0].type, 'list');
  f.send('', { action: 'add_item', productId: 'p1', quantity: 2 });
  f.send('catalog');
  const state = [...f.states.values()][0];
  assert.equal(state.currentState, 'CART');
  assert.equal(state.contextData.cart[0].quantity, 2);
});

test('cancelled, expired, and paid customers can start a clean new session', () => {
  const cancelled = fixture();
  cancelled.send('catalog');
  cancelled.send('', { action: 'add_item', productId: 'p1' });
  cancelled.send('cancel');
  cancelled.send('catalog');
  let state = [...cancelled.states.values()][0];
  assert.equal(state.currentState, 'BROWSING');
  assert.deepEqual(state.contextData, { cart: [] });

  const paid = fixture();
  const orderId = createAwaitingPaymentOrder(paid);
  paid.service.confirmPayment(orderId, 'staff@example.com');
  paid.send('', { action: 'new_order' });
  state = [...paid.states.values()][0];
  assert.equal(state.currentState, 'BROWSING');
  assert.deepEqual(state.contextData, { cart: [] });
});

test('awaiting-payment actions return status and QR instead of transition errors', () => {
  const f = fixture();
  const orderId = createAwaitingPaymentOrder(f);
  const catalog = f.send('catalog');
  assert.match(catalog[0].content.text, new RegExp(orderId));
  const qr = f.send('', { action: 'resend_qr' });
  assert.equal(qr[0].type, 'image');
  assert.equal(qr[0].content.data, `qr:${orderId}:35000`);
  assert.equal(f.orders.length, 1);
});

test('start, help, unknown commands, cart, and status always return useful guidance', () => {
  const f = fixture();
  assert.match(f.send('/start')[0].content.text, /Xin chào/);
  assert.match(f.send('something-unknown')[0].content.text, /Catalog/);
  assert.match(f.send('/cart')[0].content.text, /trống/);
  assert.match(f.send('/status')[0].content.text, /chưa có đơn/);
});

test('payment confirmation trusts order status even if UI state was independently reset', () => {
  const f = fixture();
  const orderId = createAwaitingPaymentOrder(f);
  const customerId = f.orders[0].customerId;
  f.states.set(customerId, {
    customerId, currentState: 'BROWSING', contextData: { cart: [] },
    updatedAt: '2026-07-13T10:00:00.000Z'
  });
  f.service.confirmPayment(orderId, 'staff@example.com');
  assert.equal(f.orders[0].status, 'PAID');
  assert.equal(f.states.get(customerId).currentState, 'BROWSING');
});

function createAwaitingPaymentOrder(f) {
  f.send('catalog');
  f.send('', { action: 'add_item', productId: 'p1' });
  f.send('', { action: 'checkout' });
  f.send('', { action: 'confirm_order' });
  return f.orders[0].orderId;
}

test('confirmPayment marks order paid, advances state, and returns a notification', () => {
  const f = fixture();
  const orderId = createAwaitingPaymentOrder(f);
  const result = f.service.confirmPayment(orderId, 'staff@example.com');

  assert.equal(f.orders.length, 1);
  assert.equal(f.orders[0].status, 'PAID');
  assert.equal(f.orders[0].confirmedAt, '2026-07-13T10:00:00.000Z');
  assert.equal(f.orders[0].confirmedBy, 'staff@example.com');
  assert.equal([...f.states.values()][0].currentState, 'PAID');
  assert.deepEqual(result.customer.platformLinks, [
    { platform: 'test-channel', platformUserId: 'user-1' }
  ]);
  assert.deepEqual(result.outboundMessages, [{
    type: 'text',
    content: {
      text: `Payment confirmed for order ${orderId}. Thank you!`,
      orderId
    }
  }]);
});

test('confirmPayment rejects a second confirmation without further changes', () => {
  const f = fixture();
  const orderId = createAwaitingPaymentOrder(f);
  f.service.confirmPayment(orderId, 'first@example.com');
  const beforeOrder = structuredClone(f.orders[0]);
  const beforeState = structuredClone([...f.states.values()][0]);

  assert.throws(
    () => f.service.confirmPayment(orderId, 'second@example.com'),
    (error) => error instanceof OrderService.Errors.PaymentAlreadyResolvedError &&
      error.code === 'PAYMENT_ALREADY_RESOLVED' && error.status === 'PAID'
  );
  assert.deepEqual(f.orders[0], beforeOrder);
  assert.deepEqual([...f.states.values()][0], beforeState);
});

test('confirmPayment distinguishes an unknown order', () => {
  const f = fixture();
  assert.throws(
    () => f.service.confirmPayment('missing-order', 'staff@example.com'),
    (error) => error instanceof OrderService.Errors.OrderNotFoundError &&
      error.code === 'ORDER_NOT_FOUND' && error.orderId === 'missing-order'
  );
  assert.equal(f.orders.length, 0);
});

test('message lock allows only one interleaved payment confirmation', () => {
  let held = false;
  const options = {
    withLock(operation) {
      if (held) throw new Error('Message transaction lock is already held');
      held = true;
      try { return operation(); } finally { held = false; }
    }
  };
  const f = fixture(options);
  const orderId = createAwaitingPaymentOrder(f);
  let overlappingError;
  let paidSaveCount = 0;
  options.afterOrderSave = () => {
    if (f.orders[0].status !== 'PAID') return;
    paidSaveCount += 1;
    options.afterOrderSave = null;
    try { f.service.confirmPayment(orderId, 'second@example.com'); }
    catch (error) { overlappingError = error; }
  };

  const result = f.service.confirmPayment(orderId, 'first@example.com');
  assert.equal(result.outboundMessages.length, 1);
  assert.match(overlappingError.message, /transaction lock is already held/);
  assert.equal(paidSaveCount, 1);
  assert.equal(f.orders[0].status, 'PAID');
  assert.equal(f.orders[0].confirmedBy, 'first@example.com');
});

test('expireOrder marks an awaiting order expired and returns a notification', () => {
  const f = fixture();
  const orderId = createAwaitingPaymentOrder(f);
  const result = f.service.expireOrder(orderId);

  assert.equal(f.orders[0].status, 'EXPIRED');
  assert.equal([...f.states.values()][0].currentState, 'EXPIRED');
  assert.equal(result.customer.customerId, f.orders[0].customerId);
  assert.equal(result.outboundMessages[0].type, 'text');
  assert.match(result.outboundMessages[0].content.text, new RegExp(orderId));
});

test('expireOrder rejects repeated expiry without further changes', () => {
  const f = fixture();
  const orderId = createAwaitingPaymentOrder(f);
  f.service.expireOrder(orderId);
  const beforeOrder = structuredClone(f.orders[0]);
  const beforeState = structuredClone([...f.states.values()][0]);

  assert.throws(
    () => f.service.expireOrder(orderId),
    (error) => error instanceof OrderService.Errors.PaymentAlreadyResolvedError &&
      error.status === 'EXPIRED'
  );
  assert.deepEqual(f.orders[0], beforeOrder);
  assert.deepEqual([...f.states.values()][0], beforeState);
});

test('expireOrder uses OrderNotFoundError for an unknown order', () => {
  const f = fixture();
  assert.throws(
    () => f.service.expireOrder('missing-order'),
    (error) => error instanceof OrderService.Errors.OrderNotFoundError &&
      error.orderId === 'missing-order'
  );
});

test('serialized expiry and payment confirmation allow only one winner', () => {
  let held = false;
  let queuedOperation = null;
  let queuedError = null;
  const options = {
    withLock(operation) {
      if (held) { queuedOperation = operation; return { queued: true }; }
      held = true;
      var result;
      try {
        result = operation();
      } finally {
        held = false;
        if (queuedOperation) {
          var pending = queuedOperation;
          queuedOperation = null;
          try { this.withLock(pending); } catch (error) { queuedError = error; }
        }
      }
      return result;
    }
  };
  const f = fixture(options);
  const orderId = createAwaitingPaymentOrder(f);
  options.afterOrderSave = () => {
    if (f.orders[0].status !== 'EXPIRED') return;
    options.afterOrderSave = null;
    f.service.confirmPayment(orderId, 'staff@example.com');
  };

  f.service.expireOrder(orderId);
  assert.equal(f.orders[0].status, 'EXPIRED');
  assert.equal([...f.states.values()][0].currentState, 'EXPIRED');
  assert.ok(queuedError instanceof OrderService.Errors.PaymentAlreadyResolvedError);
  assert.equal(queuedError.status, 'EXPIRED');

  const paid = fixture();
  const paidOrderId = createAwaitingPaymentOrder(paid);
  paid.service.confirmPayment(paidOrderId, 'staff@example.com');
  assert.throws(
    () => paid.service.expireOrder(paidOrderId),
    (error) => error instanceof OrderService.Errors.PaymentAlreadyResolvedError && error.status === 'PAID'
  );
  assert.equal(paid.orders[0].status, 'PAID');
});
