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
