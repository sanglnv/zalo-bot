'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mapInboundMessage,
  encodeCallbackData,
  decodeCallbackData
} = require('../../adapters/telegram/mapInboundMessage');

test('maps a text message update', () => {
  assert.deepEqual(mapInboundMessage({
    update_id: 1,
    message: { message_id: 10, chat: { id: -123 }, text: 'catalog' }
  }), {
    platform: 'telegram', platformUserId: '-123', text: 'catalog', payload: null
  });
});

test('maps a callback query and decodes compact add_item data', () => {
  assert.deepEqual(mapInboundMessage({
    update_id: 2,
    callback_query: {
      id: 'callback-1', data: 'add_item:p1:2', message: { chat: { id: 456 } }
    }
  }), {
    platform: 'telegram', platformUserId: '456', text: '',
    payload: { action: 'add_item', productId: 'p1', quantity: 2 }
  });
});

test('compact callback encoding round-trips and defaults missing quantity to one', () => {
  const encoded = encodeCallbackData({ action: 'add_item', productId: 'coffee:special', quantity: 3 });
  assert.equal(encoded, 'add_item:coffee%3Aspecial:3');
  assert.deepEqual(decodeCallbackData(encoded), {
    action: 'add_item', productId: 'coffee:special', quantity: 3
  });
  assert.deepEqual(decodeCallbackData('add_item:p2'), {
    action: 'add_item', productId: 'p2', quantity: 1
  });
  assert.equal(encodeCallbackData({ action: 'confirm_order' }), 'confirm_order');
  assert.deepEqual(decodeCallbackData('confirm_order'), { action: 'confirm_order' });
});

test('enforces callback_data validation and 64-byte limit', () => {
  assert.throws(
    () => encodeCallbackData({ action: 'add_item', productId: 'x'.repeat(60), quantity: 1 }),
    /64-byte limit/
  );
  assert.throws(() => decodeCallbackData('add_item::1'), /requires productId/);
  assert.throws(() => decodeCallbackData('add_item:p1:zero'), /positive integer/);
});

test('returns null for unsupported update types', () => {
  assert.equal(mapInboundMessage({ update_id: 3, edited_message: {} }), null);
});
