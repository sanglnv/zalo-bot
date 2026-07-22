'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require.extensions['.gs'] = require.extensions['.js'];

function loadRepository(mock) {
  global.SleepboxWebhookClient = mock;
  delete require.cache[require.resolve('../repositories/PosRoomRepository.gs')];
  return require('../repositories/PosRoomRepository.gs')();
}

test('checkAvailability delegates straight to the webhook client', () => {
  const rooms = [{ roomId: 'R1', name: 'Box 1', hourlyRate: 50000, overnightRate: 300000, isAvailable: true }];
  const repo = loadRepository({ checkAvailability: (startAt, endAt) => { assert.equal(startAt, 'a'); assert.equal(endAt, 'b'); return rooms; } });
  assert.equal(repo.checkAvailability('a', 'b'), rooms);
});

test('list() and findById() throw clearly instead of silently returning nothing -- the POS contract has no such actions', () => {
  const repo = loadRepository({});
  assert.throws(() => repo.list(), /use checkAvailability/);
  assert.throws(() => repo.findById('R1'), /use checkAvailability/);
});
