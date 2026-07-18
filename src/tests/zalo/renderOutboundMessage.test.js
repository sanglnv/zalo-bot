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

test('category selection buttons carry categoryId through the query payload', () => {
  const buttons = renderOutboundMessage({
    type: 'button', content: { text: 'Chọn danh mục:', buttons: [
      { action: 'select_category', categoryId: 'CAT1', label: 'Đồ uống' },
      { action: 'cart', label: 'Giỏ hàng' }
    ] }
  }, 'u1');
  assert.deepEqual(buttons.params.message.attachment.payload.buttons.map((b) => b.payload), [
    'zc:select_category:CAT1', 'zc:cart'
  ]);
});

test('more than 5 buttons (e.g. >4 categories + cart) degrades to a list instead of throwing', () => {
  const manyCategoryButtons = [
    { action: 'select_category', categoryId: 'CAT1', label: 'Cà phê' },
    { action: 'select_category', categoryId: 'CAT2', label: 'Trà' },
    { action: 'select_category', categoryId: 'CAT3', label: 'Bánh' },
    { action: 'select_category', categoryId: 'CAT4', label: 'Nước ép' },
    { action: 'select_category', categoryId: 'CAT5', label: 'Đá xay' },
    { action: 'cart', label: 'Giỏ hàng' }
  ];
  const result = renderOutboundMessage({
    type: 'button', content: { text: 'Chọn danh mục:', buttons: manyCategoryButtons }
  }, 'u1');
  assert.equal(result.params.message.attachment.payload.template_type, 'list');
  assert.equal(result.params.message.attachment.payload.elements.length, 6);
  assert.equal(result.params.message.attachment.payload.elements[0].title, 'Cà phê');
  assert.equal(
    result.params.message.attachment.payload.elements[0].default_action.payload,
    'zc:select_category:CAT1'
  );
  assert.equal(
    result.params.message.attachment.payload.elements[5].default_action.payload,
    'zc:cart'
  );
});
