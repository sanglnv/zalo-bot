'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require.extensions['.gs'] = require.extensions['.js'];

function loadClient(options = {}) {
  global.SheetOrderRepository = () => ({
    findById: () => {
      if (options.repositoryError) throw new Error('sheet unavailable');
      return options.missingOrder ? null : { orderId: 'o1', customerId: 'c1' };
    }
  });
  global.SheetCustomerRepository = () => ({
    findById: () => options.missingLink ? { platformLinks: [] } : {
      customerId: 'c1',
      platformLinks: [{ platform: 'telegram', platformUserId: 'chat-1' }]
    }
  });
  global.PropertiesService = {
    getScriptProperties: () => ({
      getProperty(name) {
        if (options.missingUrl && name === 'TELEGRAM_WEBHOOK_URL') return null;
        if (options.missingToken && name === 'GAS_GATEWAY_TOKEN') return null;
        return name === 'TELEGRAM_WEBHOOK_URL' ? 'https://gateway.example' : 'gateway-token';
      }
    })
  };
  global.UrlFetchApp = {
    fetch() {
      if (options.fetchError) throw new Error('network unavailable');
      return {
        getResponseCode: () => options.status || 200,
        getContentText: () => options.invalidJson
          ? '{bad'
          : JSON.stringify(options.body || {
            handled: true, outcome: 'resolved', deliveryStatus: 'delivered'
          })
      };
    }
  };
  delete require.cache[require.resolve('../adapters/telegram/FastPathPaymentClient.gs')];
  return require('../adapters/telegram/FastPathPaymentClient.gs');
}

test('fast-path payment client preserves valid not-found fallbacks', () => {
  assert.deepEqual(loadClient({ missingOrder: true }).resolve('o1', 'confirm', 'staff'), {
    handled: false, outcome: 'not_found'
  });
  assert.deepEqual(loadClient({ missingLink: true }).resolve('o1', 'confirm', 'staff'), {
    handled: false, outcome: 'not_found'
  });
});

test('fast-path payment client converts every infrastructure failure into infra_error', () => {
  const cases = [
    { missingUrl: true, pattern: /not configured/ },
    { missingToken: true, pattern: /not configured/ },
    { repositoryError: true, pattern: /sheet unavailable/ },
    { fetchError: true, pattern: /network unavailable/ },
    { status: 503, body: { error: 'down' }, pattern: /HTTP 503/ },
    { invalidJson: true, pattern: /invalid JSON/ },
    { body: [], pattern: /invalid response/ },
    { body: { handled: 'yes', outcome: 'resolved' }, pattern: /invalid response/ }
  ];
  cases.forEach((options) => {
    const result = loadClient(options).resolve('o1', 'confirm', 'staff');
    assert.equal(result.handled, false);
    assert.equal(result.outcome, 'infra_error');
    assert.match(result.message, options.pattern);
  });
});

test('fast-path payment client returns a valid Worker response unchanged', () => {
  const body = {
    handled: true,
    outcome: 'resolved',
    status: 'PAID',
    deliveryStatus: 'pending'
  };
  assert.deepEqual(loadClient({ body }).resolve('o1', 'confirm', 'staff'), body);
});

test('payment confirmation reports fast-path infrastructure failure without falling through', () => {
  const logs = [];
  global.FastPathPaymentClient = {
    resolve: () => ({ handled: false, outcome: 'infra_error', message: 'gateway down' })
  };
  global.SheetErrorLogRepository = () => ({ log(entry) { logs.push(entry); } });
  global.PaymentConfirmationHandler = {
    create() { throw new Error('regular confirmation must not run'); }
  };
  delete require.cache[require.resolve('../admin/PaymentConfirmation.gs')];
  const confirmation = require('../admin/PaymentConfirmation.gs');
  assert.deepEqual(confirmation.processOrderPayment('o1', 'staff'), {
    ok: false,
    reason: 'fast_path_gateway_unavailable',
    message: 'gateway down'
  });
  assert.equal(logs[0].context.stage, 'fast_path_gateway');
});

test('payment confirmation logs a committed fast-path payment with pending notification', () => {
  const logs = [];
  global.FastPathPaymentClient = {
    resolve: () => ({
      handled: true,
      outcome: 'resolved',
      deliveryStatus: 'pending',
      notificationError: 'Telegram unavailable',
      platformLinks: [{ platform: 'telegram', platformUserId: 'chat-1' }]
    })
  };
  global.SheetErrorLogRepository = () => ({ log(entry) { logs.push(entry); } });
  delete require.cache[require.resolve('../admin/PaymentConfirmation.gs')];
  const confirmation = require('../admin/PaymentConfirmation.gs');
  const result = confirmation.processOrderPayment('o1', 'staff');
  assert.equal(result.reason, 'confirmed_but_notification_failed');
  assert.equal(result.orderId, 'o1');
  assert.deepEqual(result.platformLinks, [
    { platform: 'telegram', platformUserId: 'chat-1' }
  ]);
  assert.equal(logs[0].context.stage, 'notification_dispatch');
  assert.equal(logs[0].context.fastPath, true);
});
