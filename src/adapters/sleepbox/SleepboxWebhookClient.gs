'use strict';

/**
 * Client for the SleepBox booking actions exposed on the same POS "Bot Order
 * Webhook" endpoint used for menu/order/member actions (see
 * src/adapters/menu/BotOrderWebhookClient.gs for the sibling client and the
 * shared envelope/idempotency conventions -- this file intentionally mirrors
 * that one's structure so both are easy to read side by side).
 *
 * Same endpoint, same `BOT_ORDER_WEBHOOK_URL`/`BOT_ORDER_WEBHOOK_SECRET`
 * script properties -- confirmed by the POS contract doc (2026-07-22), no
 * separate booking endpoint/secret to configure.
 *
 * ASSUMPTION (unconfirmed against a live response, same caveat as
 * normalizeProduct in BotOrderWebhookClient.gs): the contract doc describes
 * Room/Booking field names in prose and TypeScript-style type definitions,
 * but this client was written without a literal sample JSON payload in hand.
 * `normalizeRoom`/`normalizeBooking` below are the single place those
 * assumptions live -- if a live response uses different field names, fix
 * them here only.
 */
var SleepboxWebhookClient = (function () {
  function properties() {
    return PropertiesService.getScriptProperties();
  }

  function requiredProperty(name) {
    var value = properties().getProperty(name);
    if (!value) throw new Error('Missing required script property: ' + name);
    return value;
  }

  function createRequestId(action) {
    return 'clawbot-' + action + '-' + Utilities.getUuid();
  }

  // Same rule as BotOrderWebhookClient: mutations reuse a stable,
  // business-derived requestId across retries; reads use a random one.
  function sanitizeIdempotencyKey(key) {
    var cleaned = String(key).replace(/[^A-Za-z0-9._:-]/g, '-');
    return ('clawbot-' + cleaned).slice(0, 128);
  }

  function SleepboxWebhookError(code, message, requestId) {
    this.name = 'SleepboxWebhookError';
    this.code = code || 'BOT_WEBHOOK_ERROR';
    this.requestId = requestId || null;
    this.message = message;
    if (Error.captureStackTrace) Error.captureStackTrace(this, SleepboxWebhookError);
  }
  SleepboxWebhookError.prototype = Object.create(Error.prototype);
  SleepboxWebhookError.prototype.constructor = SleepboxWebhookError;

  function call(action, payload, idempotencyKey) {
    var url = requiredProperty('BOT_ORDER_WEBHOOK_URL');
    var secret = requiredProperty('BOT_ORDER_WEBHOOK_SECRET');
    var requestId = idempotencyKey ? sanitizeIdempotencyKey(idempotencyKey) : createRequestId(action);
    var response;
    try {
      response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ secret: secret, requestId: requestId, action: action, payload: payload || {} }),
        muteHttpExceptions: true
      });
    } catch (error) {
      throw new SleepboxWebhookError('BOT_WEBHOOK_INFRA_ERROR',
        'Sleepbox webhook request failed: ' + (error && error.message ? error.message : String(error)), requestId);
    }
    var status = response.getResponseCode();
    var body;
    try {
      body = JSON.parse(response.getContentText());
    } catch (error) {
      throw new SleepboxWebhookError('BOT_WEBHOOK_INFRA_ERROR',
        'Sleepbox webhook returned invalid JSON (HTTP ' + status + ')', requestId);
    }
    if (status !== 200 || !body || typeof body !== 'object') {
      throw new SleepboxWebhookError('BOT_WEBHOOK_INFRA_ERROR', 'Sleepbox webhook returned HTTP ' + status, requestId);
    }
    if (body.ok !== true) {
      throw new SleepboxWebhookError(body.code || 'BOT_WEBHOOK_INFRA_ERROR',
        body.message || ('Sleepbox webhook response is missing ok:true (got: ' + JSON.stringify(body) + ')'), body.requestId);
    }
    return body;
  }

  function normalizeRoom(remote) {
    var roomId = remote.roomId != null ? remote.roomId : remote.id;
    return {
      roomId: roomId,
      name: remote.name,
      roomType: remote.roomType || null,
      hourlyRate: typeof remote.hourlyRate === 'number' ? remote.hourlyRate : Number(remote.hourlyRate) || 0,
      overnightRate: typeof remote.overnightRate === 'number' ? remote.overnightRate : Number(remote.overnightRate) || 0,
      dailyRate: typeof remote.dailyRate === 'number' ? remote.dailyRate : Number(remote.dailyRate) || 0,
      // checkAvailability only ever returns rooms that are free for the
      // requested window and not inactive/under maintenance -- every room in
      // its response is available by construction.
      isAvailable: true
    };
  }

  function internalBookingStatusFromRemote(remote) {
    var status = remote && remote.status;
    if (status === 'awaiting_payment') return 'AWAITING_PAYMENT';
    if (status === 'paid' || status === 'completed') return 'PAID';
    if (status === 'cancelled') return 'CANCELLED';
    if (status === 'done') return 'DONE';
    return status ? String(status).toUpperCase() : 'UNKNOWN';
  }

  function normalizeBooking(remote) {
    return {
      bookingId: remote.id,
      customerId: remote.customerId || null,
      memberId: remote.memberId || null,
      roomId: remote.roomId,
      unit: remote.unit,
      startAt: remote.startAt,
      endAt: remote.endAt,
      status: internalBookingStatusFromRemote(remote),
      totalAmount: typeof remote.total === 'number' ? remote.total : Number(remote.total) || 0,
      createdAt: remote.createdAt,
      updatedAt: remote.updatedAt
    };
  }

  function checkAvailability(startAt, endAt) {
    var body = call('checkAvailability', { startAt: startAt, endAt: endAt });
    var rooms = (body.patch && Array.isArray(body.patch.rooms)) ? body.patch.rooms : [];
    return rooms.map(normalizeRoom);
  }

  function createBooking(input) {
    if (!input.clawbotBookingId) {
      throw new TypeError('createBooking requires input.clawbotBookingId as a stable idempotency key');
    }
    if (!input.customerName) {
      // Required by the POS contract -- reject locally with a clear message
      // instead of letting the POS reject it with a generic validation error.
      throw new TypeError('createBooking requires input.customerName');
    }
    var bookingPayload = {
      customerId: input.customerId,
      customerName: input.customerName,
      roomId: input.roomId,
      unit: input.unit,
      startAt: input.startAt,
      endAt: input.endAt,
      notes: 'clawbotBookingId:' + input.clawbotBookingId
    };
    if (input.customerPhone) bookingPayload.customerPhone = input.customerPhone;
    if (input.memberId) bookingPayload.memberId = input.memberId;
    var body = call('createBooking', { booking: bookingPayload }, 'createBooking:' + input.clawbotBookingId);
    if (body.duplicate) {
      if (!body.bookingId) {
        throw new SleepboxWebhookError('BOT_WEBHOOK_INFRA_ERROR',
          'createBooking reported duplicate/processing with no bookingId to recover', body.requestId);
      }
      var recovered = getBooking(body.bookingId);
      if (!recovered) {
        throw new SleepboxWebhookError('BOT_WEBHOOK_INFRA_ERROR',
          'createBooking duplicate pointed at bookingId ' + body.bookingId + ' but getBooking found nothing', body.requestId);
      }
      return recovered;
    }
    var remoteBooking = body.patch && Array.isArray(body.patch.bookings) ? body.patch.bookings[0] : null;
    if (!remoteBooking) {
      throw new SleepboxWebhookError('BOT_WEBHOOK_INFRA_ERROR', 'createBooking response is missing patch.bookings[0]', body.requestId);
    }
    return normalizeBooking(remoteBooking);
  }

  function getBooking(bookingId) {
    var body = call('getBooking', { bookingId: bookingId });
    var bookings = (body.patch && Array.isArray(body.patch.bookings)) ? body.patch.bookings : [];
    if (!bookings.length) return null;
    return normalizeBooking(bookings[0]);
  }

  function cancelBooking(bookingId, reason) {
    // Idempotent per the contract: cancelling an already-cancelled booking
    // returns ok:true unchanged (unlike cancelOrder, which errors) -- no
    // special-case handling needed here, `call` already treats ok:true as success.
    var body = call('cancelBooking', { bookingId: bookingId, reason: reason },
      'cancelBooking:' + bookingId + ':' + reason);
    return { bookingId: body.bookingId || bookingId, duplicate: !!body.duplicate };
  }

  function completeBooking(bookingId, paymentMethod, amount) {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      throw new TypeError('completeBooking requires a numeric amount (validated against the booking total server-side)');
    }
    var body = call('completeBooking', { bookingId: bookingId, paymentMethod: paymentMethod, amount: amount },
      'completeBooking:' + bookingId);
    return { bookingId: body.bookingId || bookingId, duplicate: !!body.duplicate };
  }

  return Object.freeze({
    checkAvailability: checkAvailability,
    createBooking: createBooking,
    getBooking: getBooking,
    cancelBooking: cancelBooking,
    completeBooking: completeBooking,
    Errors: Object.freeze({ SleepboxWebhookError: SleepboxWebhookError })
  });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SleepboxWebhookClient;
