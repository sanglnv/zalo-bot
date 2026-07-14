'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require.extensions['.gs'] = require.extensions['.js'];

test('recordDuration preserves return value and records elapsed time', () => {
  const entries = [];
  global.SheetOperationMetricsRepository = () => ({ record(entry) { entries.push(entry); } });
  delete require.cache[require.resolve('../admin/Metrics.gs')];
  const { recordDuration } = require('../admin/Metrics.gs');
  const originalNow = Date.now;
  const readings = [1000, 1025];
  Date.now = () => readings.shift();
  try {
    assert.equal(recordDuration('demo', () => 'result'), 'result');
  } finally {
    Date.now = originalNow;
  }
  assert.equal(entries.length, 1);
  assert.equal(entries[0].operation, 'demo');
  assert.equal(entries[0].durationMs, 25);
});

test('recordDuration records failed operations and rethrows the original error', () => {
  const entries = [];
  global.SheetOperationMetricsRepository = () => ({ record(entry) { entries.push(entry); } });
  delete require.cache[require.resolve('../admin/Metrics.gs')];
  const { recordDuration } = require('../admin/Metrics.gs');
  assert.throws(() => recordDuration('failure', () => { throw new Error('boom'); }), /boom/);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].operation, 'failure');
  assert.ok(entries[0].durationMs >= 0);
});

test('operation metrics repository appends raw duration under a lock', () => {
  const rows = [];
  let lockCalls = 0;
  global.SheetRepositorySupport = {
    writableSheet: () => ({ appendRow(row) { rows.push(row); } }),
    withScriptLock(operation) { lockCalls += 1; return operation(); }
  };
  delete require.cache[require.resolve('../repositories/SheetOperationMetricsRepository.gs')];
  const SheetOperationMetricsRepository = require('../repositories/SheetOperationMetricsRepository.gs');
  SheetOperationMetricsRepository().record({
    timestamp: '2026-07-13T10:00:00.000Z', operation: 'doPost', durationMs: 12
  });
  assert.deepEqual(rows, [['2026-07-13T10:00:00.000Z', 'doPost', 12]]);
  assert.equal(lockCalls, 1);
});
