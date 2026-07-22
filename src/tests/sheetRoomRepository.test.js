'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require.extensions['.gs'] = require.extensions['.js'];

test('SheetRoomRepository lists and finds manually seeded rooms', () => {
  const rows = [
    ['roomId', 'name', 'roomType', 'pricePerHour', 'pricePerNight', 'isAvailable'],
    ['R1', 'Box 1', 'single', 50000, 300000, true],
    ['R2', 'Box 2', 'double', 70000, 400000, false]
  ];
  const sheet = { getLastRow: () => rows.length, getLastColumn: () => rows[0].length,
    getRange(row, col, count, width) { return { getValues: () => rows.slice(row - 1, row - 1 + count)
      .map((source) => source.slice(col - 1, col - 1 + width)) }; } };
  global.PropertiesService = { getScriptProperties: () => ({ getProperty: () => 'sheet-id' }) };
  global.SpreadsheetApp = { openById: () => ({ getSheetByName: () => sheet }) };
  global.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  delete require.cache[require.resolve('../repositories/SheetRepositorySupport.gs')];
  delete require.cache[require.resolve('../repositories/SheetRoomRepository.gs')];
  global.SheetRepositorySupport = require('../repositories/SheetRepositorySupport.gs');
  const repo = require('../repositories/SheetRoomRepository.gs')();
  assert.equal(repo.list().length, 2);
  assert.deepEqual(repo.findById('R1'), { roomId: 'R1', name: 'Box 1', roomType: 'single',
    pricePerHour: 50000, pricePerNight: 300000, isAvailable: true });
  assert.equal(repo.findById('missing'), null);
});
