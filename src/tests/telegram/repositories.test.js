'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require.extensions['.gs'] = require.extensions['.js'];

test('processed-update repository stores each update id once under a write lock', () => {
  const dataRows = [];
  let lockCalls = 0;
  const sheet = {
    header: ['', '', ''],
    appendRow(row) { dataRows.push([...row]); },
    getRange(row, column) {
      return {
        getValue: () => row === 1 ? sheet.header[column - 1] : dataRows[row - 2][column - 1],
        setValue(value) {
          if (row === 1) sheet.header[column - 1] = value;
          else dataRows[row - 2][column - 1] = value;
        }
      };
    }
  };
  global.SheetRepositorySupport = {
    readSheet: () => sheet,
    writableSheet: () => sheet,
    rows: () => dataRows,
    withScriptLock(operation) { lockCalls += 1; return operation(); }
  };
  delete require.cache[require.resolve('../../repositories/SheetProcessedUpdateRepository.gs')];
  const SheetProcessedUpdateRepository = require('../../repositories/SheetProcessedUpdateRepository.gs');
  const repository = SheetProcessedUpdateRepository();

  assert.equal(repository.has(123), false);
  assert.equal(repository.markProcessed(123, '2026-07-13T00:00:00.000Z'), true);
  assert.equal(repository.has('123'), true);
  assert.equal(repository.getDeliveryStatus('123'), 'pending');
  assert.equal(repository.updateDeliveryStatus('123', 'delivered'), 'delivered');
  assert.equal(repository.getDeliveryStatus('123'), 'delivered');
  assert.equal(repository.markProcessed('123', '2026-07-13T00:01:00.000Z'), false);
  assert.equal(dataRows.length, 1);
  assert.deepEqual(dataRows[0], ['123', '2026-07-13T00:00:00.000Z', 'delivered']);
  assert.equal(sheet.header[2], 'deliveryStatus');
  assert.equal(lockCalls, 3);
});

test('error-log repository appends structured failure details under a lock', () => {
  const rows = [];
  let lockCalls = 0;
  global.SheetRepositorySupport = {
    writableSheet: () => ({ appendRow(row) { rows.push(row); } }),
    withScriptLock(operation) { lockCalls += 1; return operation(); }
  };
  delete require.cache[require.resolve('../../repositories/SheetErrorLogRepository.gs')];
  const SheetErrorLogRepository = require('../../repositories/SheetErrorLogRepository.gs');
  SheetErrorLogRepository().log({
    timestamp: '2026-07-13T00:00:00.000Z',
    context: { updateId: '123' },
    message: 'boom',
    stack: 'stack'
  });
  assert.deepEqual(rows[0], [
    '2026-07-13T00:00:00.000Z', '{"updateId":"123"}', 'boom', 'stack'
  ]);
  assert.equal(lockCalls, 1);
});

test('customer platform lookup uses cache without reading Sheets and populates on miss', () => {
  const cacheValues = new Map();
  global.CacheService = {
    getScriptCache: () => ({
      get: (key) => cacheValues.get(key) || null,
      put: (key, value) => cacheValues.set(key, value),
      remove: (key) => cacheValues.delete(key)
    })
  };
  let sheetReads = 0;
  const rows = [[
    'customer-1', '', 'Sang',
    JSON.stringify([{ platform: 'telegram', platformUserId: '7001' }]), ''
  ]];
  global.SheetRepositorySupport = {
    readSheet: () => { sheetReads += 1; return {}; },
    rows: () => rows,
    withScriptLock: (operation) => operation()
  };
  delete require.cache[require.resolve('../../repositories/SheetCustomerRepository.gs')];
  const repository = require('../../repositories/SheetCustomerRepository.gs')();

  assert.equal(repository.findByPlatformUserId('telegram', '7001').customerId, 'customer-1');
  assert.equal(sheetReads, 1, 'cache miss must scan the Sheet');
  assert.equal(repository.findByPlatformUserId('telegram', '7001').customerId, 'customer-1');
  assert.equal(sheetReads, 1, 'cache hit must not read the Sheet');
});

test('stale customer platform cache falls back to a Sheet scan without throwing', () => {
  const cacheValues = new Map([['customer:telegram:7001', 'deleted-customer']]);
  global.CacheService = {
    getScriptCache: () => ({
      get: (key) => cacheValues.get(key) || null,
      put: (key, value) => cacheValues.set(key, value),
      remove: (key) => cacheValues.delete(key)
    })
  };
  let sheetReads = 0;
  const rows = [[
    'customer-2', '', 'Replacement',
    JSON.stringify([{ platform: 'telegram', platformUserId: '7001' }]), ''
  ]];
  global.SheetRepositorySupport = {
    readSheet: () => { sheetReads += 1; return {}; },
    rows: () => rows,
    withScriptLock: (operation) => operation()
  };
  delete require.cache[require.resolve('../../repositories/SheetCustomerRepository.gs')];
  const repository = require('../../repositories/SheetCustomerRepository.gs')();

  assert.equal(repository.findByPlatformUserId('telegram', '7001').customerId, 'customer-2');
  assert.equal(sheetReads, 2, 'stale id lookup and fallback platform scan both consult Sheets');
  assert.equal(cacheValues.get('customer:telegram:7001'), 'customer-2');
});

test('conversation state cache avoids repeated Sheet scans and set refreshes the cached value', () => {
  const cacheValues = new Map();
  global.CacheService = {
    getScriptCache: () => ({
      get: (key) => cacheValues.get(key) || null,
      put: (key, value) => cacheValues.set(key, value),
      remove: (key) => cacheValues.delete(key)
    })
  };
  let sheetReads = 0;
  const rows = [['customer-1', 'CART', '{"cart":[]}', '2026-07-18T00:00:00.000Z']];
  const sheet = {
    getRange() { return { setValues(values) { rows[0] = values[0]; } }; }
  };
  global.SheetRepositorySupport = {
    readSheet: () => { sheetReads += 1; return sheet; },
    writableSheet: () => sheet,
    rows: () => rows,
    withScriptLock: (operation) => operation()
  };
  delete require.cache[require.resolve('../../repositories/SheetConversationStateRepository.gs')];
  const repository = require('../../repositories/SheetConversationStateRepository.gs')();

  assert.equal(repository.get('customer-1').currentState, 'CART');
  assert.equal(repository.get('customer-1').currentState, 'CART');
  assert.equal(sheetReads, 1);
  repository.set('customer-1', {
    customerId: 'customer-1', currentState: 'CONFIRMING', contextData: { cart: [] },
    updatedAt: '2026-07-18T00:01:00.000Z'
  });
  assert.equal(repository.get('customer-1').currentState, 'CONFIRMING');
  assert.equal(sheetReads, 1);
});
