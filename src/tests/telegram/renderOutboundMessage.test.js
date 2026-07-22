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
    [{ text: 'Coffee — 35.000 ₫', callback_data: 'view_product:p1' }],
    [{ text: 'Tea — 20.000 ₫', callback_data: 'view_product:p2' }]
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

test('renders category navigation below a product list', () => {
  const command = renderOutboundMessage({
    type: 'list',
    content: {
      title: 'Cà phê',
      items: [{ productId: 'p1', name: 'Coffee', price: 35000 }],
      buttons: [
        { action: 'catalog', label: '← Danh mục' },
        { action: 'cart', label: 'Giỏ hàng' }
      ]
    }
  }, '10');
  assert.deepEqual(command.params.reply_markup.inline_keyboard.at(-1), [
    { text: '← Danh mục', callback_data: 'catalog' },
    { text: 'Giỏ hàng', callback_data: 'cart' }
  ]);
});

test('renders booking unit buttons and room lists with compact callback data', () => {
  const units = renderOutboundMessage({ type: 'button', content: { text: 'Loại hình', buttons: [
    { action: 'select_unit', unit: 'hourly', label: 'Theo giờ' },
    { action: 'select_unit', unit: 'nightly', label: 'Theo đêm' }
  ] } }, '10');
  assert.deepEqual(units.params.reply_markup.inline_keyboard[0].map((button) => button.callback_data),
    ['select_unit:hourly', 'select_unit:nightly']);
  const rooms = renderOutboundMessage({ type: 'list', content: { title: 'Phòng trống', items: [
    { roomId: 'R1', name: 'Box 1', pricePerHour: 50000, pricePerNight: 300000 }
  ] } }, '10');
  assert.equal(rooms.params.reply_markup.inline_keyboard[0][0].callback_data, 'select_room:R1');
  assert.match(rooms.params.reply_markup.inline_keyboard[0][0].text, /50\.000 ₫\/giờ/);
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
