'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require.extensions['.gs'] = require.extensions['.js'];

test('whole expiry scan failure logs an operational error and alerts the ops chat', () => {
  const logs = [];
  const telegramCalls = [];
  global.PropertiesService = {
    getScriptProperties: () => ({
      getProperty(name) {
        if (name === 'TELEGRAM_OPERATIONS_CHAT_ID') return 'ops-chat';
        if (name === 'PAYMENT_TIMEOUT_MINUTES') return '30';
        return null;
      }
    })
  };
  global.BotOrderRepository = () => ({
    findAwaitingPaymentOlderThan() { throw new Error('POS unavailable'); }
  });
  global.OrderService = { create: () => ({ expireOrder() {} }) };
  global.SheetCustomerRepository = () => ({});
  global.SheetConversationStateRepository = () => ({});
  global.TelegramRuntime = {
    loadCatalog: () => [], createPaymentQrUrl: () => '', createId: () => 'id'
  };
  global.SheetRepositorySupport = { withScriptLock: (operation) => operation() };
  global.NotificationDispatcher = { dispatchNotifications() {} };
  global.buildNotificationRegistry = () => ({});
  global.SheetErrorLogRepository = () => ({ log(entry) { logs.push(entry); } });
  global.PaymentExpiryRunner = require('../admin/paymentExpiry');
  global.FastPathPaymentClient = undefined;
  global.TelegramClient = {
    create: () => ({ execute(command) { telegramCalls.push(command); } })
  };
  global.recordDuration = (name, operation) => operation();

  delete require.cache[require.resolve('../admin/PaymentExpiry.gs')];
  const PaymentExpiry = require('../admin/PaymentExpiry.gs');
  assert.throws(() => PaymentExpiry.scanAndExpireStalePayments(), /POS unavailable/);

  assert.equal(logs.length, 1);
  assert.equal(logs[0].context.stage, 'payment_expiry_scan_failed');
  assert.equal(telegramCalls.length, 1);
  assert.equal(telegramCalls[0].method, 'sendMessage');
  assert.equal(telegramCalls[0].params.chat_id, 'ops-chat');
  assert.match(telegramCalls[0].params.text, /POS unavailable/);
});
