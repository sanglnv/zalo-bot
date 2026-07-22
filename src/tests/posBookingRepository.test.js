'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require.extensions['.gs'] = require.extensions['.js'];

function loadRepository(mock, customerRepository) {
  global.SleepboxWebhookClient = mock;
  delete require.cache[require.resolve('../repositories/PosBookingRepository.gs')];
  return require('../repositories/PosBookingRepository.gs');
}

test('constructor requires a customerRepository with findById', () => {
  const PosBookingRepository = loadRepository({});
  assert.throws(() => PosBookingRepository(), /requires a customerRepository/);
  assert.throws(() => PosBookingRepository({}), /requires a customerRepository/);
});

test('save() on a fresh AWAITING_PAYMENT booking looks up the customer, sends customerName/customerPhone, and mutates the booking in place', () => {
  const calls = [];
  const PosBookingRepository = loadRepository({
    createBooking(input) {
      calls.push(input);
      return { bookingId: 'BOOKING_remote1', totalAmount: 150000, status: 'AWAITING_PAYMENT', createdAt: 'a', updatedAt: 'a' };
    }
  });
  const customerRepository = { findById: (id) => (id === 'c1' ? { customerId: 'c1', displayName: 'An', phone: '0909' } : null) };
  const repo = PosBookingRepository(customerRepository);
  const booking = {
    bookingId: 'local-1', customerId: 'c1', memberId: 'M1', roomId: 'R1', unit: 'hourly',
    startAt: 'a', endAt: 'b', status: 'AWAITING_PAYMENT', totalAmount: 999999, createdAt: 'x', updatedAt: 'x'
  };
  const result = repo.save(booking);
  assert.equal(booking.bookingId, 'BOOKING_remote1'); // mutated in place
  assert.equal(booking.totalAmount, 150000); // server-computed amount overwrites the local preview
  assert.equal(result, booking);
  assert.equal(calls[0].customerName, 'An');
  assert.equal(calls[0].customerPhone, '0909');
  assert.equal(calls[0].clawbotBookingId, 'local-1');
  assert.equal(calls[0].memberId, 'M1');
});

test('save() falls back to an empty customerName when the customer cannot be found, rather than throwing', () => {
  const calls = [];
  const PosBookingRepository = loadRepository({
    createBooking(input) { calls.push(input); return { bookingId: 'BOOKING_1', totalAmount: 1, status: 'AWAITING_PAYMENT', createdAt: 'a', updatedAt: 'a' }; }
  });
  const repo = PosBookingRepository({ findById: () => null });
  repo.save({ bookingId: 'local-1', customerId: 'missing', roomId: 'R1', unit: 'hourly', startAt: 'a', endAt: 'b', status: 'AWAITING_PAYMENT', totalAmount: 1, createdAt: 'x', updatedAt: 'x' });
  assert.equal(calls[0].customerName, '');
});

test('save() with status PAID calls completeBooking with the booking totalAmount', () => {
  const calls = [];
  const PosBookingRepository = loadRepository({
    completeBooking(bookingId, paymentMethod, amount) { calls.push({ bookingId, paymentMethod, amount }); return { bookingId, duplicate: false }; }
  });
  const repo = PosBookingRepository({ findById: () => null });
  repo.save({ bookingId: 'BOOKING_1', customerId: 'c1', status: 'PAID', totalAmount: 150000, confirmedAt: 'a', confirmedBy: 'staff', createdAt: 'x', updatedAt: 'x' });
  assert.deepEqual(calls, [{ bookingId: 'BOOKING_1', paymentMethod: 'bank_transfer', amount: 150000 }]);
});

test('save() rejects any status it does not know how to route', () => {
  const repo = loadRepository({})({ findById: () => null });
  assert.throws(() => repo.save({ bookingId: 'BOOKING_1', status: 'DONE' }), /does not support status: DONE/);
});

test('save() maps BOT_WEBHOOK_ROOM_OVERLAP to the internal ROOM_OVERLAP code', () => {
  const PosBookingRepository = loadRepository({
    createBooking() { const e = new Error('Room already booked'); e.code = 'BOT_WEBHOOK_ROOM_OVERLAP'; throw e; }
  });
  const repo = PosBookingRepository({ findById: () => ({ displayName: 'An', phone: '0909' }) });
  assert.throws(
    () => repo.save({ bookingId: 'local-1', customerId: 'c1', roomId: 'R1', unit: 'hourly', startAt: 'a', endAt: 'b', status: 'AWAITING_PAYMENT', totalAmount: 1, createdAt: 'x', updatedAt: 'x' }),
    (error) => error.code === 'ROOM_OVERLAP'
  );
});

test('findById delegates to getBooking, updateStatus only supports CANCELLED', () => {
  const calls = [];
  const repo = loadRepository({
    getBooking: (id) => (id === 'BOOKING_1' ? { bookingId: 'BOOKING_1' } : null),
    cancelBooking: (id, reason) => { calls.push({ id, reason }); return { bookingId: id, duplicate: false }; }
  })({ findById: () => null });
  assert.deepEqual(repo.findById('BOOKING_1'), { bookingId: 'BOOKING_1' });
  assert.equal(repo.findById('missing'), null);
  assert.equal(repo.updateStatus('BOOKING_1', 'CANCELLED'), true);
  assert.deepEqual(calls, [{ id: 'BOOKING_1', reason: 'customer_cancelled' }]);
  assert.throws(() => repo.updateStatus('BOOKING_1', 'PAID'), /only supports CANCELLED/);
});

test('findByCustomerId fails soft to [] (the POS contract has no such action) and findOverlapping throws clearly', () => {
  const repo = loadRepository({})({ findById: () => null });
  assert.deepEqual(repo.findByCustomerId('c1'), []);
  assert.throws(() => repo.findOverlapping('R1', 'a', 'b'), /PosRoomRepository.checkAvailability should be used instead/);
});
