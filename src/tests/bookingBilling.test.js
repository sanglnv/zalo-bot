'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateBookingBill, findAvailableRooms } = require('../core/bookingBilling');
const room = { roomId: 'R1', hourlyRate: 100.25, overnightRate: 500.4, isAvailable: true };
test('calculates hourly/nightly bills and rounds total immediately', () => {
  assert.deepEqual(calculateBookingBill(room, 'hourly', 3), { subtotal: 300.75, totalAmount: 301 });
  assert.deepEqual(calculateBookingBill(room, 'nightly', 2), { subtotal: 1000.8, totalAmount: 1001 });
});
test('rejects invalid billing inputs', () => {
  assert.throws(() => calculateBookingBill(null, 'hourly', 1), /room must be an object/);
  assert.throws(() => calculateBookingBill(room, 'daily', 1), /unit must be hourly or nightly/);
  assert.throws(() => calculateBookingBill(room, 'hourly', 0), /positive integer/);
});
test('availability handles touching boundaries, containment, and non-blocking statuses', () => {
  const rooms = ['R1', 'R2', 'R3', 'R4', 'R5'].map((roomId) => ({ roomId, isAvailable: true }));
  const bookings = [
    { roomId: 'R1', unit: 'hourly', startAt: '2026-08-01T09:00:00Z', durationHours: 1, status: 'PAID' },
    { roomId: 'R2', unit: 'hourly', startAt: '2026-08-01T12:00:00Z', durationHours: 1, status: 'PAID' },
    { roomId: 'R3', unit: 'hourly', startAt: '2026-08-01T09:00:00Z', durationHours: 5, status: 'AWAITING_PAYMENT' },
    { roomId: 'R4', unit: 'hourly', startAt: '2026-08-01T10:30:00Z', durationHours: 1, status: 'PAID' },
    { roomId: 'R5', unit: 'hourly', startAt: '2026-08-01T10:30:00Z', durationHours: 1, status: 'CANCELLED' }
  ];
  assert.deepEqual(findAvailableRooms(rooms, bookings, '2026-08-01T10:00:00Z', '2026-08-01T12:00:00Z')
    .map((item) => item.roomId), ['R1', 'R2', 'R5']);
});
test('availability rejects malformed intervals', () => {
  assert.throws(() => findAvailableRooms([], [], 'bad', '2026-01-01T00:00:00Z'), /valid increasing interval/);
});
