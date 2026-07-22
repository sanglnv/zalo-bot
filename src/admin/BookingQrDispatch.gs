'use strict';

function buildBookingQrBookingService() {
  var customerRepository = SheetCustomerRepository();
  return BookingService.create({
    bookingRepository: PosBookingRepository(customerRepository), roomRepository: PosRoomRepository(),
    customerRepository: customerRepository, conversationStateRepository: SheetConversationStateRepository(),
    memberRepository: MemberRepository(),
    // BotRuntime's legacy QR formatter reads orderId for the transfer note.
    // Preserve its format while using the booking ID as the payment reference.
    createQrContent: function (booking) {
      return TelegramRuntime.createPaymentQrUrl(Object.assign({}, booking, { orderId: booking.bookingId }));
    },
    createId: TelegramRuntime.createId, now: function () { return new Date(); },
    withLock: SheetRepositorySupport.withScriptLock
  });
}

function dispatchBookingQr(bookingId) {
  var result;
  try {
    result = buildBookingQrBookingService().sendPaymentQr(bookingId);
  } catch (error) {
    if (error && error.code === 'BOOKING_NOT_FOUND') return { ok: false, reason: 'not_found', message: error.message };
    if (error && error.code === 'PAYMENT_ALREADY_RESOLVED') {
      return { ok: false, reason: 'already_resolved', status: error.status };
    }
    return { ok: false, reason: 'error', message: error && error.message ? error.message : String(error) };
  }
  try {
    return { ok: true, dispatchResults: NotificationDispatcher.dispatchNotifications(
      result.customer, result.outboundMessages, buildInteractivePushRegistry()
    ) };
  } catch (error) {
    return { ok: false, reason: 'sent_but_delivery_failed', message: error && error.message ? error.message : String(error) };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildBookingQrBookingService: buildBookingQrBookingService, dispatchBookingQr: dispatchBookingQr };
}
