'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require.extensions['.gs'] = require.extensions['.js'];

const OrderService = require('../../core/orderService');
const TelegramClient = require('../../adapters/telegram/TelegramClient.gs');
const { TelegramWebhook } = require('../../adapters/telegram/webhook.gs');
const { mapInboundMessage } = require('../../adapters/telegram/mapInboundMessage');
const { renderOutboundMessage } = require('../../adapters/telegram/renderOutboundMessage');

function setup(setupOptions = {}) {
  const fetchCalls = [];
  const errors = [];
  const telemetry = [];
  const processed = new Map();
  const customers = [];
  const orders = [];
  const states = new Map();
  let lockHeld = false;
  let id = 0;
  let handleCount = 0;

  global.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (name) => name === 'TELEGRAM_BOT_TOKEN'
        ? 'test-token'
        : name === 'TELEGRAM_OPERATIONS_CHAT_ID' ? (setupOptions.opsChatId || null) : null
    })
  };
  global.UrlFetchApp = {
    fetch(url, options) {
      const method = url.slice(url.lastIndexOf('/') + 1);
      const params = JSON.parse(options.payload);
      fetchCalls.push({ url, options, params });
      if (method === setupOptions.failMethod) {
        return { getResponseCode: () => 500, getContentText: () => '{"ok":false,"description":"forced"}' };
      }
      if (setupOptions.failOperations && params.chat_id === setupOptions.opsChatId) {
        return { getResponseCode: () => 500, getContentText: () => '{"ok":false,"description":"ops forced"}' };
      }
      return { getResponseCode: () => 200, getContentText: () => '{"ok":true,"result":{}}' };
    }
  };
  global.ContentService = {
    MimeType: { TEXT: 'text/plain' },
    createTextOutput(text) {
      return { text, setMimeType(mimeType) { this.mimeType = mimeType; return this; } };
    }
  };
  global.LockService = {
    getScriptLock: () => ({
      hasLock: () => lockHeld,
      tryLock: () => { if (lockHeld) return false; lockHeld = true; return true; },
      releaseLock: () => { lockHeld = false; }
    })
  };
  delete require.cache[require.resolve('../../repositories/SheetRepositorySupport.gs')];
  const lockSupport = require('../../repositories/SheetRepositorySupport.gs');

  const orderRepository = {
    save(order) { orders.push(structuredClone(order)); return order; },
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
  const coreService = OrderService.create({
    orderRepository,
    customerRepository,
    conversationStateRepository,
    getCatalog: () => [
      { productId: 'p1', name: 'Coffee', price: 35_000, isAvailable: true },
      { productId: 'p2', name: 'Tea', price: 20_000, isAvailable: true }
    ],
    createQrContent: (order) => `https://img.vietqr.io/image/test.png?amount=${order.totalAmount}`,
    createId: () => `id-${++id}`,
    now: () => new Date('2026-07-13T10:00:00.000Z'),
    withLock: lockSupport.withScriptLock,
    telemetry(event, details) { telemetry.push({ event, details }); }
  });
  const orderService = {
    handleMessage(message) { handleCount += 1; return coreService.handleMessage(message); }
  };
  const webhook = TelegramWebhook.create({
    mapInboundMessage,
    renderOutboundMessage,
    withLock: lockSupport.withScriptLock,
    now: () => new Date('2026-07-13T10:00:00.000Z'),
    orderService,
    processedUpdateRepository: {
      has: (updateId) => processed.has(String(updateId)),
      markProcessed(updateId) { processed.set(String(updateId), 'pending'); return true; },
      updateDeliveryStatus(updateId, status) { processed.set(String(updateId), status); return status; }
    },
    errorLogRepository: { log(entry) { errors.push(entry); } },
    client: TelegramClient.create(),
    fallbackMessage: () => 'Processing failed. Please contact support.',
    telemetry(event, details) { telemetry.push({ event, details }); }
  });

  function post(update) {
    return webhook.doPost({ postData: { contents: JSON.stringify(update) } });
  }
  return {
    webhook, post, fetchCalls, errors, telemetry, processed, orders, states,
    getHandleCount: () => handleCount
  };
}

function message(updateId, text) {
  return { update_id: updateId, message: { message_id: updateId, chat: { id: 777 }, text } };
}

function callback(updateId, id, data) {
  return {
    update_id: updateId,
    callback_query: { id, data, message: { message_id: 1, chat: { id: 777 } } }
  };
}

test('end-to-end catalog, two items, checkout, confirm, QR, and duplicate update id', () => {
  const f = setup();
  const updates = [
    message(100, 'catalog'),
    callback(101, 'cb-add-1', 'add_item:p1:1'),
    callback(102, 'cb-add-2', 'add_item:p2:1'),
    message(103, 'checkout'),
    callback(104, 'cb-confirm', 'confirm_order')
  ];
  const responses = updates.map(f.post);
  const duplicateResponse = f.post(updates[4]);

  responses.concat(duplicateResponse).forEach((response) => {
    assert.equal(response.text, 'OK');
    assert.equal(response.mimeType, 'text/plain');
  });
  assert.equal(f.getHandleCount(), 5, 'duplicate update must not reach OrderService');
  assert.equal(f.orders.length, 1);
  assert.deepEqual(f.orders[0].items.map((item) => item.productId), ['p1', 'p2']);

  const apiCalls = f.fetchCalls.map((call) => ({
    method: call.url.slice(call.url.lastIndexOf('/') + 1), params: call.params
  }));
  const photoCalls = apiCalls.filter((call) => call.method === 'sendPhoto');
  assert.equal(photoCalls.length, 1, 'duplicate confirmation must not send another QR');
  assert.match(photoCalls[0].params.photo, /^https:\/\/img\.vietqr\.io\/image\//);
  assert.equal(photoCalls[0].params.chat_id, '777');
  assert.equal(apiCalls.filter((call) => call.method === 'answerCallbackQuery').length, 4);
  assert.equal(apiCalls.filter((call) => call.method === 'editMessageReplyMarkup').length, 1);
  assert.equal(f.errors.length, 0);
  assert.equal(f.processed.get('104'), 'delivered');
  const finalTrace = f.telemetry.find((entry) =>
    entry.event === 'telegram_request_completed' && entry.details.updateId === '104'
  );
  assert.ok(finalTrace);
  assert.ok(finalTrace.details.durationMs >= 0);
  assert.ok(f.telemetry.some((entry) =>
    entry.event === 'state_loaded' && entry.details.traceId === '104'
  ));
  assert.ok(f.telemetry.some((entry) =>
    entry.event === 'domain_completed' && entry.details.updateId === '104'
  ));
});

test('failed QR delivery sends fallback, marks failed, and logs manual recovery data', () => {
  const options = {};
  const f = setup(options);
  f.post(message(300, 'catalog'));
  f.post(callback(301, 'cb-add', 'add_item:p1:1'));
  f.post(message(302, 'checkout'));

  options.failMethod = 'sendPhoto';
  const response = f.post(callback(303, 'cb-confirm-failed', 'confirm_order'));
  assert.equal(response.text, 'OK');
  assert.equal(f.orders.length, 1, 'business order is already committed');
  assert.equal(f.processed.get('303'), 'failed');

  const apiCalls = f.fetchCalls.map((call) => ({
    method: call.url.slice(call.url.lastIndexOf('/') + 1), params: call.params
  }));
  const fallback = apiCalls.find((call) =>
    call.method === 'sendMessage' && call.params.text === 'Processing failed. Please contact support.'
  );
  assert.ok(fallback, 'customer must receive a fallback after QR delivery failure');
  assert.equal(fallback.params.chat_id, '777');

  const deliveryLog = f.errors.find((entry) => entry.context.stage === 'delivery');
  assert.ok(deliveryLog);
  assert.equal(deliveryLog.context.orderId, 'id-2');
  assert.equal(deliveryLog.context.chatId, '777');
  assert.match(deliveryLog.context.qrUrl, /^https:\/\/img\.vietqr\.io\/image\//);
  assert.equal(deliveryLog.context.failedMethod, 'sendPhoto');
  assert.equal(deliveryLog.context.fallbackDelivered, true);

  // Re-confirming cannot repeat the financial transition. It returns the
  // existing pending-order guidance rather than a system-error fallback.
  const fallbackCount = () => f.fetchCalls.filter((call) =>
    call.url.endsWith('/sendMessage') &&
    call.params.text === 'Processing failed. Please contact support.'
  ).length;
  const beforeRetry = fallbackCount();
  const retryResponse = f.post(callback(304, 'cb-confirm-retry', 'confirm_order'));
  assert.equal(retryResponse.text, 'OK');
  assert.equal(f.orders.length, 1);
  assert.equal(f.processed.get('304'), 'delivered');
  assert.equal(fallbackCount(), beforeRetry);
  assert.ok(f.fetchCalls.some((call) =>
    call.url.endsWith('/sendMessage') && /chờ thanh toán/.test(call.params.text)
  ));
});

test('user action errors send guidance and never masquerade as system failures', () => {
  const f = setup();
  const response = f.post(callback(400, 'cb-invalid-confirm', 'confirm_order'));
  assert.equal(response.text, 'OK');
  assert.equal(f.processed.get('400'), 'delivered');
  const guidance = f.fetchCalls.find((call) =>
    call.url.endsWith('/sendMessage') && /chọn sản phẩm/.test(call.params.text)
  );
  assert.ok(guidance);
  assert.equal(f.fetchCalls.some((call) =>
    call.url.endsWith('/sendMessage') && call.params.text === 'Processing failed. Please contact support.'
  ), false);
  const log = f.errors.find((entry) => entry.context.stage === 'user_action');
  assert.equal(log.context.action, 'confirm_order');
  assert.equal(log.context.currentState, 'IDLE');
});

test('unsupported update is claimed but does not call core or Telegram API', () => {
  const f = setup();
  const response = f.post({ update_id: 200, edited_message: {} });
  assert.equal(response.text, 'OK');
  assert.equal(f.getHandleCount(), 0);
  assert.equal(f.fetchCalls.length, 0);
  assert.equal(f.processed.has('200'), true);
  assert.equal(f.processed.get('200'), 'delivered');
});

test('internal errors are logged and webhook still returns success', () => {
  const f = setup();
  const response = f.webhook.doPost({ postData: { contents: '{bad json' } });
  assert.equal(response.text, 'OK');
  assert.equal(response.mimeType, 'text/plain');
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0].message, /JSON/);
});

test('confirm_order notifies operations once while status and duplicates do not', () => {
  const f = setup({ opsChatId: 'ops-1' });
  f.post(message(500, 'catalog'));
  f.post(callback(501, 'cb-add', 'add_item:p1:1'));
  f.post(message(502, 'checkout'));
  const confirmation = callback(503, 'cb-confirm', 'confirm_order');
  f.post(confirmation);
  f.post(confirmation);
  f.post(message(504, 'status'));

  const operations = f.fetchCalls.filter((call) => call.params.chat_id === 'ops-1');
  assert.equal(operations.length, 1);
  assert.match(operations[0].params.text, /ĐƠN MỚI #id-2/);
  assert.match(operations[0].params.text, /35\.000 đ/);
  assert.match(operations[0].params.text, /Chờ thanh toán/);
});

test('operations notification is optional and failure is isolated from customer delivery', () => {
  const withoutOps = setup();
  withoutOps.post(message(510, 'catalog'));
  withoutOps.post(callback(511, 'cb-add', 'add_item:p1:1'));
  withoutOps.post(message(512, 'checkout'));
  assert.equal(withoutOps.post(callback(513, 'cb-confirm', 'confirm_order')).text, 'OK');
  assert.equal(withoutOps.fetchCalls.some((call) =>
    call.params.chat_id != null && String(call.params.chat_id) !== '777'
  ), false);

  const brokenOps = setup({ opsChatId: 'ops-fail', failOperations: true });
  brokenOps.post(message(520, 'catalog'));
  brokenOps.post(callback(521, 'cb-add', 'add_item:p1:1'));
  brokenOps.post(message(522, 'checkout'));
  const response = brokenOps.post(callback(523, 'cb-confirm', 'confirm_order'));
  assert.equal(response.text, 'OK');
  assert.equal(brokenOps.processed.get('523'), 'delivered');
  assert.ok(brokenOps.errors.some((entry) => entry.context.stage === 'operations_notify'));
});
