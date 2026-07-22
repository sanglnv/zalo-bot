'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require.extensions['.gs'] = require.extensions['.js'];

function runtime() {
  const rows = [];
  const sheet = { getLastRow: () => rows.length, getLastColumn: () => rows.length ? rows[0].length : 0,
    appendRow: (row) => rows.push([...row]), getRange(row, col, count = 1, width = 1) { return {
      getValues: () => rows.slice(row - 1, row - 1 + count).map((source) => source.slice(col - 1, col - 1 + width)),
      setValues(values) { values.forEach((value, offset) => { rows[row - 1 + offset] = [...value]; }); },
      setValue(value) { while (!rows[row - 1]) rows.push([]); rows[row - 1][col - 1] = value; }
    }; } };
  const book = { getSheetByName: () => rows.length ? sheet : null, insertSheet: () => sheet };
  let locks = 0;
  global.PropertiesService = { getScriptProperties: () => ({ getProperty: () => 'sheet-id' }) };
  global.SpreadsheetApp = { openById: () => book };
  global.LockService = { getScriptLock: () => ({ tryLock: () => { locks++; return true; }, releaseLock() {} }) };
  return { rows, locks: () => locks };
}
function load() {
  delete require.cache[require.resolve('../repositories/SheetRepositorySupport.gs')];
  delete require.cache[require.resolve('../repositories/SheetBookingRepository.gs')];
  global.SheetRepositorySupport = require('../repositories/SheetRepositorySupport.gs');
  return require('../repositories/SheetBookingRepository.gs')();
}
test('booking repository round-trips, updates under lock, and checks half-open overlap', () => {
  const rt = runtime();
  const repo = load();
  const base = { customerId: 'C1', memberId: null, roomId: 'R1', unit: 'hourly',
    status: 'AWAITING_PAYMENT', totalAmount: 100000, createdAt: '2026-07-22T00:00:00Z',
    updatedAt: '2026-07-22T00:00:00Z' };
  repo.save({ ...base, bookingId: 'B1', startAt: '2026-08-01T10:00:00Z', durationHours: 2 });
  repo.save({ ...base, bookingId: 'B2', startAt: '2026-08-01T12:00:00Z', durationHours: 1 });
  assert.equal(repo.findById('B1').durationHours, 2);
  assert.equal(repo.findByCustomerId('C1').length, 2);
  assert.deepEqual(repo.findOverlapping('R1', '2026-08-01T11:00:00Z', '2026-08-01T12:00:00Z')
    .map((booking) => booking.bookingId), ['B1']);
  repo.updateStatus('B1', 'PAID');
  assert.equal(repo.findById('B1').status, 'PAID');
  assert.ok(rt.locks() >= 3);
});
