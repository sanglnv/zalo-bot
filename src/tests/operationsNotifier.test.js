'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require.extensions['.gs'] = require.extensions['.js'];

function loadModule(properties, telegramClientFactory) {
  global.PropertiesService = {
    getScriptProperties: () => ({ getProperty: (name) => properties[name] || null })
  };
  global.TelegramClient = { create: telegramClientFactory };
  delete require.cache[require.resolve('../admin/OperationsNotifier.gs')];
  return require('../admin/OperationsNotifier.gs');
}

const sampleOrder = {
  orderId: 'HD1',
  totalAmount: 60000,
  items: [
    { name: 'Mì bò', quantity: 1, unitPrice: 35000 },
    { name: 'Trà', quantity: 1, unitPrice: 25000 }
  ]
};

test('operationsOrderText includes item breakdown, total, source platform, and the /thanhtoan instruction', () => {
  const OperationsNotifier = loadModule({}, () => ({ execute() {} }));
  const text = OperationsNotifier.operationsOrderText(sampleOrder, 'telegram');
  assert.match(text, /ĐƠN MỚI #HD1/);
  assert.match(text, /Kênh: telegram/);
  assert.match(text, /Mì bò × 1 — 35\.000 đ/);
  assert.match(text, /Trà × 1 — 25\.000 đ/);
  assert.match(text, /Tổng: 60\.000 đ/);
  assert.match(text, /\/thanhtoan HD1/);
});

test('operationsOrderText shows the customer name when present, and omits the line entirely when absent', () => {
  const OperationsNotifier = loadModule({}, () => ({ execute() {} }));
  const withName = OperationsNotifier.operationsOrderText(
    Object.assign({}, sampleOrder, { customerName: 'Sang' }), 'telegram'
  );
  assert.match(withName, /Khách: Sang/);

  const withoutName = OperationsNotifier.operationsOrderText(sampleOrder, 'telegram');
  assert.doesNotMatch(withoutName, /Khách:/);
});

test('notifyStaffOfNewOrder skips (returns false, no throw) when the ops chat is not configured', () => {
  let called = false;
  const OperationsNotifier = loadModule({}, () => ({ execute() { called = true; } }));
  assert.equal(OperationsNotifier.notifyStaffOfNewOrder(sampleOrder, 'telegram'), false);
  assert.equal(called, false);
});

test('notifyStaffOfNewOrder sends to the configured ops chat', () => {
  const calls = [];
  const OperationsNotifier = loadModule(
    { TELEGRAM_OPERATIONS_CHAT_ID: '-100200300' },
    () => ({ execute(command) { calls.push(command); } })
  );
  assert.equal(OperationsNotifier.notifyStaffOfNewOrder(sampleOrder, 'zalo'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendMessage');
  assert.equal(calls[0].params.chat_id, '-100200300');
  assert.match(calls[0].params.text, /Kênh: zalo/);
});

test('notifyStaffOfNewOrder logs and returns false instead of throwing when the send fails', () => {
  const logs = [];
  const OperationsNotifier = loadModule(
    { TELEGRAM_OPERATIONS_CHAT_ID: '-100200300' },
    () => ({ execute() { throw new Error('Telegram API down'); } })
  );
  const result = OperationsNotifier.notifyStaffOfNewOrder(sampleOrder, 'telegram', { log(entry) { logs.push(entry); } });
  assert.equal(result, false);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].context.stage, 'operations_notify');
  assert.match(logs[0].message, /Telegram API down/);
});

test('isAuthorizedOpsAdmin allows everyone when TELEGRAM_ADMIN_USER_IDS is unset, else checks the allowlist', () => {
  const openModule = loadModule({}, () => ({ execute() {} }));
  assert.equal(openModule.isAuthorizedOpsAdmin('12345'), true);

  const restricted = loadModule({ TELEGRAM_ADMIN_USER_IDS: '111, 222' }, () => ({ execute() {} }));
  assert.equal(restricted.isAuthorizedOpsAdmin('111'), true);
  assert.equal(restricted.isAuthorizedOpsAdmin(222), true);
  assert.equal(restricted.isAuthorizedOpsAdmin('333'), false);
});
