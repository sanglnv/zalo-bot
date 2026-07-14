'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mapper = require('../../adapters/zalo/mapInboundMessage');

test('maps user text and decodes oa.query.hide payloads from message.text', () => {
  assert.deepEqual(mapper.mapInboundMessage({
    event_name: 'user_send_text', sender: { id: 'u1' }, message: { text: 'catalog', msg_id: 'm1' }
  }), { platform: 'zalo', platformUserId: 'u1', text: 'catalog', payload: null });

  const encoded = mapper.encodeQueryPayload({ action: 'add_item', productId: 'cà-phê:1', quantity: 2 });
  assert.deepEqual(mapper.mapInboundMessage({
    event_name: 'user_send_text', sender: { id: 'u1' }, message: { text: encoded, msg_id: 'm2' }
  }), {
    platform: 'zalo', platformUserId: 'u1', text: '',
    payload: { action: 'add_item', productId: 'cà-phê:1', quantity: 2 }
  });
});

test('ignores non-user-message events and enforces payload limit', () => {
  assert.equal(mapper.mapInboundMessage({ event_name: 'follow' }), null);
  assert.throws(() => mapper.encodeQueryPayload({ action: 'x'.repeat(1001) }), /1000/);
});
