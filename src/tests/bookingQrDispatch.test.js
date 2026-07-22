'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require.extensions['.gs'] = require.extensions['.js'];

function load(options = {}) {
  global.BookingService = { create: () => ({ sendPaymentQr: options.sendPaymentQr }) };
  global.SheetBookingRepository = () => ({}); global.SheetRoomRepository = () => ({});
  global.SheetCustomerRepository = () => ({}); global.SheetConversationStateRepository = () => ({});
  global.MemberRepository = () => ({});
  global.TelegramRuntime = { createPaymentQrUrl: () => '', createId: () => 'id' };
  global.SheetRepositorySupport = { withScriptLock: (fn) => fn() };
  global.NotificationDispatcher = { dispatchNotifications: options.dispatchNotifications || (() => []) };
  global.buildInteractivePushRegistry = () => ({ telegram: {} });
  delete require.cache[require.resolve('../admin/BookingQrDispatch.gs')];
  return require('../admin/BookingQrDispatch.gs');
}
test('dispatchBookingQr sends generated QR', () => {
  const customer = { customerId: 'C1' }; const outboundMessages = [{ type: 'image' }];
  const mod = load({ sendPaymentQr: () => ({ customer, outboundMessages }),
    dispatchNotifications: (value, messages) => { assert.equal(value, customer); assert.equal(messages, outboundMessages); return ['sent']; } });
  assert.deepEqual(mod.dispatchBookingQr('B1'), { ok: true, dispatchResults: ['sent'] });
});
test('booking QR builder uses bookingId as the VietQR payment reference', () => {
  let qrInput = null;
  global.BookingService = { create: (dependencies) => { qrInput = dependencies.createQrContent({ bookingId: 'B9', totalAmount: 1 }); return {}; } };
  global.SheetBookingRepository = () => ({}); global.SheetRoomRepository = () => ({});
  global.SheetCustomerRepository = () => ({}); global.SheetConversationStateRepository = () => ({}); global.MemberRepository = () => ({});
  global.TelegramRuntime = { createPaymentQrUrl: (value) => { assert.equal(value.orderId, 'B9'); return 'qr'; }, createId: () => 'id' };
  global.SheetRepositorySupport = { withScriptLock: (fn) => fn() };
  delete require.cache[require.resolve('../admin/BookingQrDispatch.gs')];
  require('../admin/BookingQrDispatch.gs').buildBookingQrBookingService();
  assert.equal(qrInput, 'qr');
});
test('dispatchBookingQr distinguishes not found and resolved bookings', () => {
  const missing = load({ sendPaymentQr: () => { const e = new Error('missing'); e.code = 'BOOKING_NOT_FOUND'; throw e; } });
  assert.deepEqual(missing.dispatchBookingQr('B1'), { ok: false, reason: 'not_found', message: 'missing' });
  const resolved = load({ sendPaymentQr: () => { const e = new Error('paid'); e.code = 'PAYMENT_ALREADY_RESOLVED'; e.status = 'PAID'; throw e; } });
  assert.deepEqual(resolved.dispatchBookingQr('B1'), { ok: false, reason: 'already_resolved', status: 'PAID' });
});
test('dispatchBookingQr reports delivery failure after QR creation', () => {
  const mod = load({ sendPaymentQr: () => ({ customer: {}, outboundMessages: [] }),
    dispatchNotifications: () => { throw new Error('delivery down'); } });
  assert.deepEqual(mod.dispatchBookingQr('B1'), { ok: false, reason: 'sent_but_delivery_failed', message: 'delivery down' });
});
