'use strict';

/**
 * Booking repository backed by the external POS SleepBox contract, instead
 * of the Bookings Sheet. Implements the same contract as
 * SheetBookingRepository (save/findById/findByCustomerId/updateStatus/
 * findOverlapping) so it drops into bookingService.js's existing dependency
 * shape.
 *
 * Needs a customerRepository (unlike BotOrderRepository) because
 * createBooking requires `customerName` -- bookingService.js's Booking
 * object only carries customerId, so this repository looks the customer up
 * itself at save() time.
 *
 * bookingId reassignment on create mirrors BotOrderRepository's orderId
 * reassignment: bookingService.js generates booking.bookingId locally
 * before calling save(), the POS generates its own id server-side, save()
 * mutates the passed-in booking object in place (id, totalAmount --
 * server-computed and never sent up -- createdAt/updatedAt) before
 * returning. The original Clawbot-generated id is still sent as
 * `clawbotBookingId` (folded into `notes`, since this contract has no
 * dedicated `raw` field like Order does) for traceability, and is always
 * the idempotency key.
 */
function PosBookingRepository(customerRepository) {
  if (!customerRepository || typeof customerRepository.findById !== 'function') {
    throw new TypeError('PosBookingRepository requires a customerRepository with findById()');
  }

  function isNewBooking(booking) {
    return booking.status === 'AWAITING_PAYMENT' && !booking.confirmedAt && !booking.confirmedBy;
  }

  // Maps the POS's BOT_WEBHOOK_* error codes to the internal codes
  // bookingService.js / BookingQrDispatch.gs already check for (mirrors the
  // codes SheetBookingRepository-era code used, so callers don't need to
  // know which backend is in play).
  function rethrowMapped(error) {
    if (error && error.code === 'BOT_WEBHOOK_BOOKING_NOT_FOUND') {
      var notFound = new Error(error.message);
      notFound.code = 'BOOKING_NOT_FOUND';
      throw notFound;
    }
    if (error && error.code === 'BOT_WEBHOOK_ROOM_OVERLAP') {
      var overlap = new Error(error.message);
      overlap.code = 'ROOM_OVERLAP';
      throw overlap;
    }
    if (error && error.code === 'BOT_WEBHOOK_BOOKING_ALREADY_CANCELLED') {
      // Contract says cancelBooking itself is idempotent on this (ok:true,
      // not an error) -- this branch is a defensive fallback in case a
      // future POS revision changes that. Treat it as success, not a crash.
      return;
    }
    throw error;
  }

  function save(booking) {
    if (isNewBooking(booking)) {
      var customer = customerRepository.findById(booking.customerId);
      var created;
      try {
        created = SleepboxWebhookClient.createBooking({
          customerId: booking.customerId,
          customerName: (customer && customer.displayName) || '',
          customerPhone: (customer && customer.phone) || null,
          memberId: booking.memberId || null,
          roomId: booking.roomId,
          unit: booking.unit,
          startAt: booking.startAt,
          endAt: booking.endAt,
          clawbotBookingId: booking.bookingId
        });
      } catch (error) {
        rethrowMapped(error);
      }
      booking.bookingId = created.bookingId;
      booking.totalAmount = created.totalAmount;
      booking.status = created.status;
      booking.createdAt = created.createdAt || booking.createdAt;
      booking.updatedAt = created.updatedAt || booking.updatedAt;
      return booking;
    }
    if (booking.status === 'PAID') {
      try {
        SleepboxWebhookClient.completeBooking(booking.bookingId, 'bank_transfer', booking.totalAmount);
      } catch (error) {
        rethrowMapped(error);
      }
      return booking;
    }
    throw new Error('PosBookingRepository.save does not support status: ' + booking.status);
  }

  function findById(bookingId) {
    return SleepboxWebhookClient.getBooking(bookingId);
  }

  function findByCustomerId() {
    // The POS contract has no "list bookings by customer" action. Nothing
    // in bookingService.js currently calls this (only the room/booking
    // repository contract requires it to exist); fail soft rather than
    // throw so an unexpected future caller degrades gracefully instead of
    // hard-crashing the whole flow, matching BotOrderRepository's
    // fail-soft precedent for actions the POS doesn't expose to Clawbot.
    return [];
  }

  function updateStatus(bookingId, status) {
    if (status !== 'CANCELLED') {
      throw new Error('PosBookingRepository.updateStatus only supports CANCELLED, got: ' + status);
    }
    try {
      SleepboxWebhookClient.cancelBooking(bookingId, 'customer_cancelled');
    } catch (error) {
      rethrowMapped(error);
    }
    return true;
  }

  function findOverlapping() {
    // Only used by bookingService.js's local-computation fallback path,
    // which is never taken once roomRepository.checkAvailability is present
    // (see PosRoomRepository.gs). Throwing here makes it obvious if that
    // assumption ever breaks, instead of silently returning wrong data.
    throw new Error('PosBookingRepository.findOverlapping is not supported; ' +
      'PosRoomRepository.checkAvailability should be used instead');
  }

  return Object.freeze({
    save: save, findById: findById, findByCustomerId: findByCustomerId,
    updateStatus: updateStatus, findOverlapping: findOverlapping
  });
}

if (typeof module !== 'undefined' && module.exports) module.exports = PosBookingRepository;
