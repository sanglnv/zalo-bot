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

test('expiry scan failure respects cooldown and does not spam Telegram on subsequent runs', (t) => {
  const originalCacheService = global.CacheService;
  const originalTelegramClient = global.TelegramClient;
  t.after(() => {
    global.CacheService = originalCacheService;
    global.TelegramClient = originalTelegramClient;
    delete require.cache[require.resolve('../admin/PaymentExpiry.gs')];
  });

  const telegramCalls = [];
  const cacheStore = new Map();
  global.CacheService = {
    getScriptCache: () => ({
      get(k) { return cacheStore.get(k) || null; },
      put(k, v) { cacheStore.set(k, v); },
      remove(k) { cacheStore.delete(k); }
    })
  };
  global.TelegramClient = {
    create: () => ({ execute(command) { telegramCalls.push(command); } })
  };

  delete require.cache[require.resolve('../admin/PaymentExpiry.gs')];
  const PaymentExpiry = require('../admin/PaymentExpiry.gs');

  // First failure: alerts ops chat and caches cooldown
  assert.throws(() => PaymentExpiry.scanAndExpireStalePayments(), /POS unavailable/);
  assert.equal(telegramCalls.length, 1);

  // Second failure within cooldown: does NOT alert Telegram again
  assert.throws(() => PaymentExpiry.scanAndExpireStalePayments(), /POS unavailable/);
  assert.equal(telegramCalls.length, 1);
});

test('cooldown is not set if Telegram sending fails, allowing retry on next run', (t) => {
  const originalCacheService = global.CacheService;
  const originalTelegramClient = global.TelegramClient;
  t.after(() => {
    global.CacheService = originalCacheService;
    global.TelegramClient = originalTelegramClient;
    delete require.cache[require.resolve('../admin/PaymentExpiry.gs')];
  });

  const cacheStore = new Map();
  global.CacheService = {
    getScriptCache: () => ({
      get(k) { return cacheStore.get(k) || null; },
      put(k, v) { cacheStore.set(k, v); },
      remove(k) { cacheStore.delete(k); }
    })
  };
  let sendAttempts = 0;
  global.TelegramClient = {
    create: () => ({
      execute() {
        sendAttempts++;
        throw new Error('Telegram network error');
      }
    })
  };

  delete require.cache[require.resolve('../admin/PaymentExpiry.gs')];
  const PaymentExpiry = require('../admin/PaymentExpiry.gs');

  // First run: Telegram throws, cooldown should NOT be set
  assert.throws(() => PaymentExpiry.scanAndExpireStalePayments(), /POS unavailable/);
  assert.equal(sendAttempts, 1);
  assert.equal(cacheStore.size, 0);

  // Second run: should attempt to send again because cooldown was not set
  assert.throws(() => PaymentExpiry.scanAndExpireStalePayments(), /POS unavailable/);
  assert.equal(sendAttempts, 2);
});

test('cache read failure does not swallow ops alert and Telegram message is still sent', (t) => {
  const originalCacheService = global.CacheService;
  const originalTelegramClient = global.TelegramClient;
  t.after(() => {
    global.CacheService = originalCacheService;
    global.TelegramClient = originalTelegramClient;
    delete require.cache[require.resolve('../admin/PaymentExpiry.gs')];
  });

  const telegramCalls = [];
  global.CacheService = {
    getScriptCache: () => ({
      get() { throw new Error('CacheService backend quota error'); },
      put() {}
    })
  };
  global.TelegramClient = {
    create: () => ({ execute(command) { telegramCalls.push(command); } })
  };

  delete require.cache[require.resolve('../admin/PaymentExpiry.gs')];
  const PaymentExpiry = require('../admin/PaymentExpiry.gs');

  assert.throws(() => PaymentExpiry.scanAndExpireStalePayments(), /POS unavailable/);
  assert.equal(telegramCalls.length, 1);
  assert.equal(telegramCalls[0].method, 'sendMessage');
  assert.match(telegramCalls[0].params.text, /POS unavailable/);
});

test('distinct error codes and messages use separate cooldown keys and do not suppress each other', (t) => {
  const originalCacheService = global.CacheService;
  const originalTelegramClient = global.TelegramClient;
  const originalBotOrderRepository = global.BotOrderRepository;
  t.after(() => {
    global.CacheService = originalCacheService;
    global.TelegramClient = originalTelegramClient;
    global.BotOrderRepository = originalBotOrderRepository;
    delete require.cache[require.resolve('../admin/PaymentExpiry.gs')];
  });

  const telegramCalls = [];
  const cacheStore = new Map();
  global.CacheService = {
    getScriptCache: () => ({
      get(k) { return cacheStore.get(k) || null; },
      put(k, v) { cacheStore.set(k, v); }
    })
  };
  global.TelegramClient = {
    create: () => ({ execute(command) { telegramCalls.push(command); } })
  };

  let failureCode = 'BOT_WEBHOOK_INFRA_ERROR';
  let failureMessage = 'POS connection timeout';
  global.BotOrderRepository = () => ({
    findAwaitingPaymentOlderThan() {
      const err = new Error(failureMessage);
      if (failureCode) err.code = failureCode;
      throw err;
    }
  });

  delete require.cache[require.resolve('../admin/PaymentExpiry.gs')];
  const PaymentExpiry = require('../admin/PaymentExpiry.gs');

  // First error with BOT_WEBHOOK_INFRA_ERROR -> alerts
  assert.throws(() => PaymentExpiry.scanAndExpireStalePayments(), /POS connection timeout/);
  assert.equal(telegramCalls.length, 1);
  assert.equal(cacheStore.has('alert_cooldown_payment_expiry_scan_failed_BOT_WEBHOOK_INFRA_ERROR_POS_connection_timeout'), true);

  // Second run with same error code and message -> cooldown suppresses
  assert.throws(() => PaymentExpiry.scanAndExpireStalePayments(), /POS connection timeout/);
  assert.equal(telegramCalls.length, 1);

  // Different error message under same code -> has its own cooldown and IS alerted
  failureMessage = 'Gateway 502 bad gateway';
  assert.throws(() => PaymentExpiry.scanAndExpireStalePayments(), /Gateway 502/);
  assert.equal(telegramCalls.length, 2);
  assert.equal(cacheStore.has('alert_cooldown_payment_expiry_scan_failed_BOT_WEBHOOK_INFRA_ERROR_Gateway_502_bad_gateway'), true);

  // Different error with NO code (e.g. Sheet error) -> has its own cooldown and IS alerted
  failureCode = null;
  failureMessage = 'Sheet lock acquired failed';
  assert.throws(() => PaymentExpiry.scanAndExpireStalePayments(), /Sheet lock acquired/);
  assert.equal(telegramCalls.length, 3);
  assert.equal(cacheStore.has('alert_cooldown_payment_expiry_scan_failed_Sheet_lock_acquired_failed'), true);
});


