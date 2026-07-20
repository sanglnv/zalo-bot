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
    save(customer) {
      const index = customers.findIndex((candidate) => candidate.customerId === customer.customerId);
      if (index < 0) customers.push(structuredClone(customer));
      else customers[index] = structuredClone(customer);
      return customer;
    },
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
    memberRepository: options.memberRepository,
    getCatalog: () => options.catalog || [
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
  if (options.skipProfileWarmup !== true) {
    // Every fixture starts as an already-registered customer by default --
    // the name+phone profile-collection gate is exercised by its own
    // dedicated tests, not smuggled into every unrelated cart/order test.
    // This warm-up still goes through handleMessage/createId() exactly like
    // a real first contact, so createId() sequencing for the customer (id-1)
    // is unaffected -- tests below assume orderId starts at id-2.
    send('/start');
    send('Test Customer');
    send('bỏ qua');
  }
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
  // The QR is no longer sent immediately -- staff triggers it later via
  // OrderService.sendPaymentQr (mirrors the Telegram Fast Path's /thanhtoan
  // flow). confirm_order only returns a text confirmation, but it carries
  // `items` so the adapter layer can build an ops-chat notification.
  assert.deepEqual(confirmed.map((message) => message.type), ['text']);
  assert.deepEqual(confirmed[0].content.items.map((item) => item.productId), ['p1']);
  assert.equal(f.orders.length, 1);
  assert.equal(f.orders[0].status, 'AWAITING_PAYMENT');
  assert.equal([...f.states.values()][0].currentState, 'AWAITING_PAYMENT');
});

test('category catalog shows groups before products and preserves navigation', () => {
  const f = fixture({ catalog: [
    { productId: 'c1', name: 'Coffee', price: 35000, isAvailable: true,
      categoryId: 'CAT_CAFE', categoryName: 'Cà phê' },
    { productId: 't1', name: 'Tea', price: 25000, isAvailable: true,
      categoryId: 'CAT_TEA', categoryName: 'Trà trái cây' }
  ] });
  const categories = f.send('catalog')[0];
  assert.equal(categories.type, 'button');
  assert.deepEqual(categories.content.buttons.map((button) => button.label), [
    'Cà phê', 'Trà trái cây', 'Giỏ hàng'
  ]);
  const products = f.send('', { action: 'select_category', categoryId: 'CAT_TEA' })[0];
  assert.deepEqual(products.content.items.map((item) => item.productId), ['t1']);
  assert.deepEqual(products.content.buttons.map((button) => button.action), ['catalog', 'cart']);

  const product = f.send('', { action: 'view_product', productId: 't1' })[0];
  assert.equal(product.type, 'button');
  assert.match(product.content.text, /Tea/);
  assert.match(product.content.text, /25\.000 ₫/);
  assert.deepEqual(product.content.buttons.map((button) => button.label), [
    'Thêm 1', 'Thêm 2', 'Thêm 3', 'Thêm 5', '← Sản phẩm', 'Giỏ hàng'
  ]);
  assert.deepEqual(product.content.buttons[2], {
    action: 'add_item', productId: 't1', quantity: 3, label: 'Thêm 3'
  });
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
  assert.match(f.send('/batdau')[0].content.text, /Xin chào/);
  assert.match(f.send('something-unknown')[0].content.text, /\/danhmuc/);
  assert.match(f.send('/giohang')[0].content.text, /trống/);
  assert.match(f.send('/xemdon')[0].content.text, /chưa có đơn/);
});

test('Vietnamese customer commands cover the complete ordering flow', () => {
  const f = fixture();
  assert.equal(f.send('/danhmuc')[0].type, 'list');
  f.send('', { action: 'add_item', productId: 'p1' });
  assert.match(f.send('/giohang')[0].content.text, /House coffee/);
  assert.match(f.send('/dathang')[0].content.text, /xác nhận/i);
  assert.match(f.send('/huydon')[0].content.text, /Đã hủy/);
  assert.match(f.send('/trogiup')[0].content.text, /\/thanhtoan/);
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

test('a brand-new customer is asked for a name before any command is processed', () => {
  const f = fixture({ skipProfileWarmup: true });
  const response = f.send('catalog');
  assert.match(response[0].content.text, /tên của bạn/);
  assert.equal(f.customers.length, 1);
  assert.equal(f.customers[0].displayName, '', 'the gate only asked -- it must not treat "catalog" itself as the name');
  assert.equal([...f.states.values()][0].currentState, 'IDLE', 'the gate never touches the cart/order state machine');
  assert.equal([...f.states.values()][0].contextData.profileStep, 'awaiting_name');
});

test('providing a name saves it and asks for a phone number next', () => {
  const f = fixture({ skipProfileWarmup: true });
  f.send('/start');
  const response = f.send('Sang');
  assert.equal(f.customers[0].displayName, 'Sang');
  assert.match(response[0].content.text, /Cảm ơn Sang/);
  assert.match(response[0].content.text, /số điện thoại/);
  assert.equal([...f.states.values()][0].contextData.profileStep, 'awaiting_phone');
});

test('a button tap during name/phone collection re-prompts instead of being treated as a command', () => {
  const f = fixture({ skipProfileWarmup: true });
  f.send('/start');
  const duringName = f.send('', { action: 'catalog' });
  assert.match(duringName[0].content.text, /tên của bạn/);
  f.send('Sang');
  const duringPhone = f.send('', { action: 'catalog' });
  assert.match(duringPhone[0].content.text, /số điện thoại/);
});

test('providing a phone resolves a POS member and clears the gate, then shows the normal menu', () => {
  const resolveCalls = [];
  const f = fixture({
    skipProfileWarmup: true,
    memberRepository: {
      resolve(profile) { resolveCalls.push(profile); return { memberId: 'M1' }; }
    }
  });
  f.send('/start');
  f.send('Sang');
  const response = f.send('0901234567');
  assert.deepEqual(resolveCalls, [{ name: 'Sang', phone: '0901234567' }]);
  assert.equal(f.customers[0].phone, '0901234567');
  assert.equal(f.customers[0].memberId, 'M1');
  assert.equal([...f.states.values()][0].contextData.profileStep, null);
  assert.equal(response.length, 2);
  assert.match(response[1].content.text, /đặt món hay kiểm tra/);

  // The gate no longer intercepts once a name is on file.
  const next = f.send('catalog');
  assert.equal(next[0].type, 'list');
});

test('skipping the phone number clears the gate without ever calling memberRepository', () => {
  let resolveCalled = false;
  const f = fixture({
    skipProfileWarmup: true,
    memberRepository: { resolve: () => { resolveCalled = true; return { memberId: 'M1' }; } }
  });
  f.send('/start');
  f.send('Sang');
  f.send('bỏ qua');
  assert.equal(resolveCalled, false);
  assert.equal(f.customers[0].phone, null);
  assert.equal(f.customers[0].memberId, undefined);
});

test('member resolution failure is swallowed -- ordering must never block on a POS outage', () => {
  const f = fixture({
    skipProfileWarmup: true,
    memberRepository: { resolve: () => { throw new Error('POS unreachable'); } }
  });
  f.send('/start');
  f.send('Sang');
  const response = f.send('0901234567');
  assert.equal(f.customers[0].phone, '0901234567');
  assert.equal(f.customers[0].memberId, undefined);
  assert.match(response[1].content.text, /đặt món hay kiểm tra/);
});

test('collecting a name is skipped entirely without a memberRepository dependency configured', () => {
  const f = fixture({ skipProfileWarmup: true });
  f.send('/start');
  f.send('Sang');
  const response = f.send('0901234567');
  assert.equal(f.customers[0].phone, '0901234567');
  assert.equal(f.customers[0].memberId, undefined);
  assert.match(response[1].content.text, /đặt món hay kiểm tra/);
});

test('/thongtin lets an already-registered customer re-enter name/phone, showing current values and defaulting to keep-as-is on skip', () => {
  const resolveCalls = [];
  const updateCalls = [];
  const f = fixture({
    memberRepository: {
      resolve(profile) { resolveCalls.push(profile); return { memberId: 'M1' }; },
      update(memberId, profile) { updateCalls.push({ memberId, profile }); return { memberId }; }
    }
  });
  // fixture()'s default warmup already gave this customer 'Test Customer'
  // with no phone/memberId on file yet.
  const askName = f.send('/thongtin');
  assert.match(askName[0].content.text, /Tên hiện tại: Test Customer/);
  const askPhone = f.send('bỏ qua');
  assert.match(askPhone[0].content.text, /Cảm ơn Test Customer/);
  assert.match(askPhone[0].content.text, /Cho mình xin số điện thoại/); // no phone on file yet -- first-time wording
  const done = f.send('0909999999');
  assert.equal(f.customers[0].displayName, 'Test Customer');
  assert.equal(f.customers[0].phone, '0909999999');
  assert.equal(f.customers[0].memberId, 'M1');
  assert.deepEqual(resolveCalls, [{ name: 'Test Customer', phone: '0909999999' }]);
  assert.equal(updateCalls.length, 0, 'no memberId yet -- must find-or-create via resolve, not update');
  assert.match(done[1].content.text, /đặt món hay kiểm tra/);

  // Second /thongtin run: memberId is now on file, so a name/phone edit
  // must sync via update(), not resolve() (which would risk a duplicate).
  const askName2 = f.send('/thongtin');
  assert.match(askName2[0].content.text, /Tên hiện tại: Test Customer/);
  const askPhone2 = f.send('Nguyen Van A');
  assert.match(askPhone2[0].content.text, /Số điện thoại hiện tại: 0909999999/);
  f.send('bỏ qua');
  assert.equal(f.customers[0].displayName, 'Nguyen Van A');
  assert.equal(f.customers[0].phone, '0909999999', 'kept as-is on skip');
  assert.deepEqual(updateCalls, [{ memberId: 'M1', profile: { name: 'Nguyen Van A', phone: '0909999999' } }]);
  assert.equal(resolveCalls.length, 1, 'resolve must not be called again once a memberId is on file');
});

test('/thongtin re-prompts if the customer tries to skip the name on a brand-new profile (nothing to keep yet)', () => {
  const f = fixture({ skipProfileWarmup: true });
  f.send('/start');
  const reprompt = f.send('bỏ qua');
  assert.match(reprompt[0].content.text, /tên của bạn/);
  assert.equal([...f.states.values()][0].contextData.profileStep, 'awaiting_name');
});

test('a button tap for update_profile mid-collection is deferred to the in-progress answer, not treated as a restart', () => {
  const f = fixture({ skipProfileWarmup: true });
  f.send('/start');
  f.send('Sang');
  // While mid phone-collection, an update_profile button tap must not
  // restart the flow -- it re-prompts for the phone like any other
  // non-free-text input during collection.
  const reprompt = f.send('', { action: 'update_profile' });
  assert.match(reprompt[0].content.text, /số điện thoại/);
});

test('confirm_order carries the resolved memberId on the order and the customer name on the outbound text', () => {
  const f = fixture({
    skipProfileWarmup: true,
    memberRepository: { resolve: () => ({ memberId: 'M1' }) }
  });
  f.send('/start');
  f.send('Sang');
  f.send('0901234567');
  f.send('catalog');
  f.send('', { action: 'add_item', productId: 'p1' });
  f.send('', { action: 'checkout' });
  const confirmed = f.send('', { action: 'confirm_order' });
  assert.equal(f.orders[0].memberId, 'M1');
  assert.equal(confirmed[0].content.customerName, 'Sang');
});

test('confirm_order defaults memberId to null when no member was resolved, and carries whatever name is on file', () => {
  // fixture()'s default warmup ("Test Customer", then skipping the phone)
  // means a displayName exists but no memberId was ever resolved.
  const f = fixture();
  f.send('catalog');
  f.send('', { action: 'add_item', productId: 'p1' });
  f.send('', { action: 'checkout' });
  const confirmed = f.send('', { action: 'confirm_order' });
  assert.equal(f.orders[0].memberId, null);
  assert.equal(confirmed[0].content.customerName, 'Test Customer');
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
      kind: 'payment_confirmed',
      text: `Đã xác nhận thanh toán cho đơn #${orderId}. Cảm ơn bạn!`,
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
  assert.equal(result.outboundMessages[0].content.kind, 'payment_expired');
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

test('sendPaymentQr returns the QR for an awaiting order without changing its status', () => {
  const f = fixture();
  const orderId = createAwaitingPaymentOrder(f);
  const beforeOrder = structuredClone(f.orders[0]);
  const beforeState = structuredClone([...f.states.values()][0]);

  const result = f.service.sendPaymentQr(orderId);

  assert.deepEqual(result.customer.platformLinks, [
    { platform: 'test-channel', platformUserId: 'user-1' }
  ]);
  assert.deepEqual(result.outboundMessages.map((message) => message.type), ['text', 'image']);
  assert.equal(result.outboundMessages[1].content.data, `qr:${orderId}:35000`);
  assert.equal(result.outboundMessages[1].content.orderId, orderId);
  // Sending the QR is not a state transition -- order/status/state are
  // untouched, unlike confirmPayment/expireOrder.
  assert.deepEqual(f.orders[0], beforeOrder);
  assert.deepEqual([...f.states.values()][0], beforeState);
});

test('sendPaymentQr rejects an order that already left AWAITING_PAYMENT', () => {
  const f = fixture();
  const orderId = createAwaitingPaymentOrder(f);
  f.service.confirmPayment(orderId, 'staff@example.com');
  assert.throws(
    () => f.service.sendPaymentQr(orderId),
    (error) => error instanceof OrderService.Errors.PaymentAlreadyResolvedError &&
      error.code === 'PAYMENT_ALREADY_RESOLVED' && error.status === 'PAID'
  );
});

test('sendPaymentQr uses OrderNotFoundError for an unknown order', () => {
  const f = fixture();
  assert.throws(
    () => f.service.sendPaymentQr('missing-order'),
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
