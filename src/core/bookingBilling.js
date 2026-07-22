'use strict';

function calculateBookingBill(room, unit, durationHoursOrNights) {
  if (!room || typeof room !== 'object') throw new TypeError('room must be an object');
  if (unit !== 'hourly' && unit !== 'nightly') throw new TypeError('unit must be hourly or nightly');
  if (!Number.isInteger(durationHoursOrNights) || durationHoursOrNights <= 0) {
    throw new TypeError('durationHoursOrNights must be a positive integer');
  }
  var field = unit === 'hourly' ? 'hourlyRate' : 'overnightRate';
  if (!Number.isFinite(room[field]) || room[field] < 0) {
    throw new TypeError('room.' + field + ' must be a non-negative number');
  }
  var subtotal = room[field] * durationHoursOrNights;
  return { subtotal: subtotal, totalAmount: Math.round(subtotal) };
}

function findAvailableRooms(rooms, bookings, startAt, endAt) {
  if (!Array.isArray(rooms)) throw new TypeError('rooms must be an array');
  if (!Array.isArray(bookings)) throw new TypeError('bookings must be an array');
  var start = new Date(startAt).getTime();
  var end = new Date(endAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new TypeError('startAt and endAt must define a valid increasing interval');
  }
  var blocking = { AWAITING_PAYMENT: true, PAID: true };
  var occupied = Object.create(null);
  bookings.forEach(function (booking) {
    if (!booking || !blocking[booking.status]) return;
    var bookingStart = new Date(booking.startAt).getTime();
    // endAt is authoritative when present (always the case for bookings
    // created since this field was added). The quantity-based recompute is
    // kept only as a fallback for older rows that predate it.
    var quantity = booking.unit === 'hourly' ? booking.durationHours : booking.nights * 24;
    var bookingEnd = booking.endAt ? new Date(booking.endAt).getTime() : bookingStart + quantity * 3600000;
    if (Number.isFinite(bookingStart) && Number.isFinite(bookingEnd) && bookingStart < end && bookingEnd > start) {
      occupied[String(booking.roomId)] = true;
    }
  });
  return rooms.filter(function (room) { return room && room.isAvailable && !occupied[String(room.roomId)]; });
}

var BookingBilling = Object.freeze({
  calculateBookingBill: calculateBookingBill,
  findAvailableRooms: findAvailableRooms
});
if (typeof module !== 'undefined' && module.exports) module.exports = BookingBilling;
