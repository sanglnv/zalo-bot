'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require.extensions['.gs'] = require.extensions['.js'];
const TelegramRuntime = require('../../adapters/telegram/TelegramRuntime.gs');

test('loads catalog from Script Properties and creates a direct VietQR Quick Link', () => {
  const values = {
    CATALOG_JSON: '[{"productId":"p1","name":"Coffee","price":35000,"isAvailable":true}]',
    VIETQR_BANK_ID: '970415',
    VIETQR_ACCOUNT_NO: '113366668888',
    VIETQR_ACCOUNT_NAME: 'NGUYEN VAN A',
    VIETQR_TEMPLATE: 'compact2',
    VIETQR_TRANSFER_PREFIX: 'DH',
    SUPPORT_CONTACT: '0900 000 000'
  };
  global.PropertiesService = {
    getScriptProperties: () => ({ getProperty: (name) => values[name] || null })
  };
  assert.equal(TelegramRuntime.loadCatalog()[0].productId, 'p1');
  assert.equal(
    TelegramRuntime.createPaymentQrUrl({ orderId: 'abc123', totalAmount: 75000 }),
    'https://img.vietqr.io/image/970415-113366668888-compact2.png' +
      '?amount=75000&addInfo=DHabc123&accountName=NGUYEN%20VAN%20A'
  );
  assert.match(TelegramRuntime.fallbackMessage(), /0900 000 000/);
});
