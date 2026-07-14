'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderOutboundMessage } = require('../../adapters/zalo/renderOutboundMessage');

test('renders text, list, buttons, and URL image for the v3 customer-service API', () => {
  const text = renderOutboundMessage({ type: 'text', content: { text: 'Hello' } }, 'u1');
  assert.deepEqual(text.params, { recipient: { user_id: 'u1' }, message: { text: 'Hello' } });

  const list = renderOutboundMessage({
    type: 'list', content: { title: 'Catalog', items: [{ productId: 'p1', name: 'Coffee', price: 35000 }] }
  }, 'u1');
  assert.equal(list.params.message.attachment.payload.template_type, 'list');
  assert.equal(list.params.message.attachment.payload.elements[0].default_action.type, 'oa.query.hide');
  assert.equal(list.params.message.attachment.payload.elements[0].default_action.payload, 'zc:add_item:p1:1');

  const buttons = renderOutboundMessage({
    type: 'button', content: { text: 'Confirm?', buttons: [
      { action: 'confirm_order', label: 'Confirm' }, { action: 'cancel', label: 'Cancel' }
    ] }
  }, 'u1');
  assert.deepEqual(buttons.params.message.attachment.payload.buttons.map((b) => b.payload), [
    'zc:confirm_order', 'zc:cancel'
  ]);

  const image = renderOutboundMessage({
    type: 'image', content: { data: 'https://img.vietqr.io/test.png' }
  }, 'u1');
  assert.deepEqual(image.params.message.attachment.payload.elements, [
    { media_type: 'image', url: 'https://img.vietqr.io/test.png' }
  ]);
});
