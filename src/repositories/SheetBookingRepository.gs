'use strict';

function SheetBookingRepository() {
  var SHEET = 'Bookings';
  var HEADERS = ['bookingId', 'customerId', 'memberId', 'roomId', 'unit', 'startAt',
    'durationHours', 'nights', 'status', 'totalAmount', 'createdAt', 'updatedAt'];

  function fromRow(row) {
    return { bookingId: String(row[0]), customerId: String(row[1]), memberId: row[2] ? String(row[2]) : null,
      roomId: String(row[3]), unit: String(row[4]), startAt: String(row[5]),
      durationHours: row[6] === '' || row[6] == null ? undefined : Number(row[6]),
      nights: row[7] === '' || row[7] == null ? undefined : Number(row[7]), status: String(row[8]),
      totalAmount: Number(row[9]), createdAt: String(row[10]), updatedAt: String(row[11]) };
  }
  function values(booking) {
    return [booking.bookingId, booking.customerId, booking.memberId || '', booking.roomId, booking.unit,
      booking.startAt, booking.durationHours == null ? '' : booking.durationHours,
      booking.nights == null ? '' : booking.nights, booking.status, booking.totalAmount,
      booking.createdAt, booking.updatedAt];
  }
  function save(booking) {
    return SheetRepositorySupport.withScriptLock(function () {
      var sheet = SheetRepositorySupport.writableSheet(SHEET, HEADERS);
      var all = SheetRepositorySupport.rows(sheet);
      var index = all.findIndex(function (row) { return String(row[0]) === booking.bookingId; });
      if (index < 0) sheet.appendRow(values(booking));
      else sheet.getRange(index + 2, 1, 1, HEADERS.length).setValues([values(booking)]);
      return booking;
    });
  }
  function allBookings() { return SheetRepositorySupport.rows(SheetRepositorySupport.readSheet(SHEET)).map(fromRow); }
  function findById(bookingId) {
    return allBookings().find(function (booking) { return booking.bookingId === String(bookingId); }) || null;
  }
  function findByCustomerId(customerId) {
    return allBookings().filter(function (booking) { return booking.customerId === String(customerId); });
  }
  function updateStatus(bookingId, status) {
    return SheetRepositorySupport.withScriptLock(function () {
      var sheet = SheetRepositorySupport.readSheet(SHEET);
      var all = SheetRepositorySupport.rows(sheet);
      var index = all.findIndex(function (row) { return String(row[0]) === String(bookingId); });
      if (index < 0) throw new Error('Booking not found: ' + bookingId);
      sheet.getRange(index + 2, 9).setValue(status);
      sheet.getRange(index + 2, 12).setValue(new Date().toISOString());
      return true;
    });
  }
  function findOverlapping(roomId, startAt, endAt) {
    var start = new Date(startAt).getTime();
    var end = new Date(endAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      throw new TypeError('startAt and endAt must define a valid increasing interval');
    }
    return allBookings().filter(function (booking) {
      var bookingStart = new Date(booking.startAt).getTime();
      var quantity = booking.unit === 'hourly' ? booking.durationHours : booking.nights * 24;
      var bookingEnd = bookingStart + quantity * 3600000;
      return booking.roomId === String(roomId) && bookingStart < end && bookingEnd > start;
    });
  }
  return Object.freeze({ save: save, findById: findById, findByCustomerId: findByCustomerId,
    updateStatus: updateStatus, findOverlapping: findOverlapping });
}

if (typeof module !== 'undefined' && module.exports) module.exports = SheetBookingRepository;
