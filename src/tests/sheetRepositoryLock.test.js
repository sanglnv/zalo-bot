'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require.extensions['.gs'] = require.extensions['.js'];

function makeRuntime(onAppend) {
  let locked = false;
  const rows = [];
  const sheet = {
    getLastRow: () => rows.length,
    getLastColumn: () => rows.length ? rows[0].length : 0,
    appendRow(row) { rows.push([...row]); if (onAppend) onAppend(row); },
    getRange(row, column, rowCount, columnCount) {
      return {
        getValues() {
          return rows.slice(row - 1, row - 1 + rowCount)
            .map((source) => source.slice(column - 1, column - 1 + columnCount));
        },
        setValues(values) {
          values.forEach((value, offset) => { rows[row - 1 + offset] = [...value]; });
        },
        getValue() { return rows[row - 1] && rows[row - 1][column - 1]; },
        setValue(value) { rows[row - 1][column - 1] = value; }
      };
    }
  };
  const book = {
    getSheetByName: () => rows.length ? sheet : null,
    insertSheet: () => sheet
  };
  const metrics = { acquisitions: 0, rejected: 0, releases: 0 };
  global.PropertiesService = {
    getScriptProperties: () => ({ getProperty: (name) => name === 'SPREADSHEET_ID' ? 'sheet-id' : null })
  };
  global.SpreadsheetApp = { openById: () => book };
  global.LockService = {
    getScriptLock: () => ({
      tryLock() {
        if (locked) { metrics.rejected += 1; return false; }
        locked = true;
        metrics.acquisitions += 1;
        return true;
      },
      releaseLock() { locked = false; metrics.releases += 1; }
    })
  };
  return { rows, metrics };
}

function order(id) {
  return {
    orderId: id, customerId: 'customer-1', items: [], status: 'AWAITING_PAYMENT',
    totalAmount: 10, createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z'
  };
}

test('script lock rejects an overlapping order write and releases for a retry', () => {
  delete require.cache[require.resolve('../repositories/SheetRepositorySupport.gs')];
  delete require.cache[require.resolve('../repositories/SheetOrderRepository.gs')];

  let firstRepository;
  let secondRepository;
  let firstExecutionSupport;
  let secondExecutionSupport;
  let overlapError;
  const runtime = makeRuntime((row) => {
    if (row[0] === 'order-a') {
      // A separate GAS execution has separate module globals/lock depth, while
      // both executions contend for the same underlying script lock.
      global.SheetRepositorySupport = secondExecutionSupport;
      try { secondRepository.save(order('order-b')); } catch (error) { overlapError = error; }
      finally { global.SheetRepositorySupport = firstExecutionSupport; }
    }
  });
  firstExecutionSupport = require('../repositories/SheetRepositorySupport.gs');
  delete require.cache[require.resolve('../repositories/SheetRepositorySupport.gs')];
  secondExecutionSupport = require('../repositories/SheetRepositorySupport.gs');
  global.SheetRepositorySupport = firstExecutionSupport;
  const SheetOrderRepository = require('../repositories/SheetOrderRepository.gs');
  firstRepository = SheetOrderRepository();
  secondRepository = SheetOrderRepository();

  firstRepository.save(order('order-a'));
  assert.match(overlapError.message, /Could not acquire script lock/);
  assert.equal(runtime.metrics.rejected, 1);
  assert.equal(runtime.metrics.acquisitions, 1);
  assert.equal(runtime.metrics.releases, 1);
  assert.equal(firstRepository.findById('order-b'), null);

  firstRepository.save(order('order-b'));
  assert.equal(firstRepository.findById('order-b').orderId, 'order-b');
  assert.equal(runtime.metrics.acquisitions, 2);
  assert.equal(runtime.metrics.releases, 2);

  firstExecutionSupport.withScriptLock(() => firstRepository.save(order('order-c')));
  assert.equal(firstRepository.findById('order-c').orderId, 'order-c');
  assert.equal(runtime.metrics.acquisitions, 3, 'nested repository save must reuse the outer lock');
  assert.equal(runtime.metrics.releases, 3);
  assert.deepEqual(runtime.rows[0].slice(7), ['confirmedAt', 'confirmedBy']);
  assert.equal(firstRepository.findById('order-c').confirmedAt, null);
  assert.equal(firstRepository.findById('order-c').confirmedBy, null);

  firstRepository.save(Object.assign({}, order('order-c'), {
    status: 'PAID',
    confirmedAt: '2026-07-13T01:00:00.000Z',
    confirmedBy: 'staff@example.com'
  }));
  assert.equal(firstRepository.findById('order-c').confirmedAt, '2026-07-13T01:00:00.000Z');
  assert.equal(firstRepository.findById('order-c').confirmedBy, 'staff@example.com');
});

test('script lock emits a structured contention warning after one second', () => {
  delete require.cache[require.resolve('../repositories/SheetRepositorySupport.gs')];
  const warnings = [];
  const originalNow = Date.now;
  const originalConsole = global.console;
  const readings = [1000, 2200];
  Date.now = () => readings.shift();
  global.console = Object.assign({}, originalConsole, { warn(value) { warnings.push(value); } });
  global.LockService = {
    getScriptLock: () => ({
      tryLock: () => true,
      releaseLock() {}
    })
  };

  try {
    const support = require('../repositories/SheetRepositorySupport.gs');
    support.withScriptLock(() => undefined);
  } finally {
    Date.now = originalNow;
    global.console = originalConsole;
  }

  assert.deepEqual(JSON.parse(warnings[0]), {
    event: 'script_lock_contention',
    waitMs: 1200
  });
});

test('script lock timeout appends a structured ErrorLogs entry without reacquiring the lock', () => {
  delete require.cache[require.resolve('../repositories/SheetRepositorySupport.gs')];
  const sheets = new Map();
  function createSheet() {
    const values = [];
    return {
      values,
      getLastRow: () => values.length,
      appendRow: (row) => values.push([...row])
    };
  }
  const book = {
    getSheetByName: (name) => sheets.get(name) || null,
    insertSheet(name) { const sheet = createSheet(); sheets.set(name, sheet); return sheet; }
  };
  global.PropertiesService = {
    getScriptProperties: () => ({ getProperty: () => 'sheet-id' })
  };
  global.SpreadsheetApp = { openById: () => book };
  let tryLockCalls = 0;
  global.LockService = {
    getScriptLock: () => ({
      tryLock() { tryLockCalls += 1; return false; },
      releaseLock() {}
    })
  };
  const originalNow = Date.now;
  const readings = [1_000, 31_000];
  Date.now = () => readings.shift();
  try {
    const support = require('../repositories/SheetRepositorySupport.gs');
    assert.throws(() => support.withScriptLock(() => undefined), /Could not acquire script lock/);
  } finally {
    Date.now = originalNow;
  }

  assert.equal(tryLockCalls, 1, 'timeout logging must not attempt the same lock again');
  const errorRows = sheets.get('ErrorLogs').values;
  assert.deepEqual(errorRows[0], ['timestamp', 'context', 'message', 'stack']);
  const context = JSON.parse(errorRows[1][1]);
  assert.deepEqual(context, {
    stage: 'script_lock_timeout', waitMs: 30000, timeoutMs: 30000
  });
});
