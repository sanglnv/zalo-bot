'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderOutboundMessage } = require('../../adapters/telegram/renderOutboundMessage');

test('renders text as sendMessage', () => {
  assert.deepEqual(renderOutboundMessage({ type: 'text', content: { text: 'Hello' } }, '10'), {
    method: 'sendMessage', params: { chat_id: '10', text: 'Hello' }
  });
});

test('renders catalog as one inline-keyboard row per product', () => {
  const command = renderOutboundMessage({
    type: 'list',
    content: {
      title: 'Catalog',
      items: [
        { productId: 'p1', name: 'Coffee', price: 35000 },
        { productId: 'p2', name: 'Tea', price: 20000 }
      ]
    }
  }, 10);
  assert.equal(command.method, 'sendMessage');
  assert.deepEqual(command.params.reply_markup.inline_keyboard, [
    [{ text: 'Coffee — 35.000 ₫', callback_data: 'add_item:p1:1' }],
    [{ text: 'Tea — 20.000 ₫', callback_data: 'add_item:p2:1' }]
  ]);
});

test('renders action buttons as an inline keyboard', () => {
  const command = renderOutboundMessage({
    type: 'button',
    content: {
      text: 'Confirm order',
      buttons: [{ action: 'confirm_order', label: 'Confirm' }, { action: 'cancel', label: 'Cancel' }]
    }
  }, '10');
  assert.deepEqual(command.params.reply_markup.inline_keyboard, [[
    { text: 'Confirm', callback_data: 'confirm_order' },
    { text: 'Cancel', callback_data: 'cancel' }
  ]]);
});

test('renders a direct QR URL as sendPhoto', () => {
  assert.deepEqual(renderOutboundMessage({
    type: 'image', content: { data: 'https://img.vietqr.io/image/demo.png' }
  }, '10'), {
    method: 'sendPhoto',
    params: { chat_id: '10', photo: 'https://img.vietqr.io/image/demo.png' }
  });
});

test('renders an optional QR caption', () => {
  assert.deepEqual(renderOutboundMessage({
    type: 'image', content: { data: 'https://example.test/qr.png', caption: 'Đơn #1' }
  }, '10'), {
    method: 'sendPhoto', params: { chat_id: '10', photo: 'https://example.test/qr.png', caption: 'Đơn #1' }
  });
});

test('rejects unsupported output and non-URL image content', () => {
  assert.throws(() => renderOutboundMessage({ type: 'audio', content: {} }, '10'), /Unsupported/);
  assert.throws(
    () => renderOutboundMessage({ type: 'image', content: { data: 'base64-data' } }, '10'),
    /direct HTTP/
  );
});
