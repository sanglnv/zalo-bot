'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require.extensions['.gs'] = require.extensions['.js'];

function loadClient(options = {}) {
  options.requests = [];
  global.PropertiesService = {
    getScriptProperties: () => ({
      getProperty(name) {
        if (name === 'BOT_ORDER_WEBHOOK_URL') return 'https://pos.example/exec';
        if (name === 'BOT_ORDER_WEBHOOK_SECRET') return 'pos-secret';
        return null;
      }
    })
  };
  global.Utilities = { getUuid: () => 'uuid-1234' };
  global.UrlFetchApp = {
    fetch(url, params) {
      if (options.fetchError) throw new Error('network unavailable');
      const body = JSON.parse(params.payload);
      options.requests.push({ url, params, body });
      options.capturedRequest = options.requests[options.requests.length - 1];
      const responseBody = options.bodyByAction ? options.bodyByAction[body.action] : options.body;
      return {
        getResponseCode: () => options.status || 200,
        getContentText: () => options.invalidJson ? '{bad' : JSON.stringify(responseBody)
      };
    }
  };
  delete require.cache[require.resolve('../adapters/sleepbox/SleepboxWebhookClient.gs')];
  return require('../adapters/sleepbox/SleepboxWebhookClient.gs');
}

test('checkAvailability sends the window and normalizes rooms as always-available', () => {
  const options = {
    body: {
      ok: true, action: 'checkAvailability', requestId: 'x',
      patch: { rooms: [
        { id: 'R1', name: 'Box 1', roomType: 'single', hourlyRate: 50000, overnightRate: 300000, dailyRate: 500000 }
      ] }
    }
  };
  const rooms = loadClient(options).checkAvailability('2026-08-01T10:00:00+07:00', '2026-08-01T13:00:00+07:00');
  assert.deepEqual(rooms, [{ roomId: 'R1', name: 'Box 1', roomType: 'single',
    hourlyRate: 50000, overnightRate: 300000, dailyRate: 500000, isAvailable: true }]);
  assert.deepEqual(options.capturedRequest.body.payload, {
    startAt: '2026-08-01T10:00:00+07:00', endAt: '2026-08-01T13:00:00+07:00'
  });
});

test('createBooking requires a stable clawbotBookingId and a customerName', () => {
  assert.throws(
    () => loadClient({}).createBooking({ customerId: 'c1', customerName: 'An', roomId: 'R1' }),
    /requires input.clawbotBookingId/
  );
  assert.throws(
    () => loadClient({}).createBooking({ customerId: 'c1', roomId: 'R1', clawbotBookingId: 'b1' }),
    /requires input.customerName/
  );
});

test('createBooking never sends totalAmount, folds clawbotBookingId into notes, and returns the server-computed total', () => {
  const options = {
    body: {
      ok: true, action: 'createBooking', requestId: 'x', duplicate: false,
      patch: { bookings: [{
        id: 'BOOKING_abc123', customerId: 'c1', roomId: 'R1', unit: 'hourly',
        startAt: '2026-08-01T10:00:00+07:00', endAt: '2026-08-01T13:00:00+07:00',
        status: 'awaiting_payment', total: 150000, createdAt: 'a', updatedAt: 'a'
      }] }
    }
  };
  const created = loadClient(options).createBooking({
    customerId: 'c1', customerName: 'An', customerPhone: '0909', memberId: 'M1', roomId: 'R1',
    unit: 'hourly', startAt: '2026-08-01T10:00:00+07:00', endAt: '2026-08-01T13:00:00+07:00',
    clawbotBookingId: 'local-1'
  });
  assert.equal(created.bookingId, 'BOOKING_abc123');
  assert.equal(created.status, 'AWAITING_PAYMENT');
  assert.equal(created.totalAmount, 150000);
  assert.equal('totalAmount' in options.capturedRequest.body.payload.booking, false,
    'totalAmount must never be sent -- the POS computes it server-side');
  assert.equal(options.capturedRequest.body.payload.booking.notes, 'clawbotBookingId:local-1');
  assert.equal(options.capturedRequest.body.requestId, 'clawbot-createBooking:local-1');
});

test('createBooking recovers via getBooking on a resolved duplicate retry instead of creating twice', () => {
  const options = {
    bodyByAction: {
      createBooking: { ok: true, action: 'createBooking', requestId: 'x', bookingId: 'BOOKING_1', duplicate: true },
      getBooking: {
        ok: true, action: 'getBooking', requestId: 'y',
        patch: { bookings: [{ id: 'BOOKING_1', roomId: 'R1', unit: 'hourly', status: 'awaiting_payment',
          total: 150000, createdAt: 'a', updatedAt: 'a' }] }
      }
    }
  };
  const recovered = loadClient(options).createBooking({
    customerId: 'c1', customerName: 'An', roomId: 'R1', unit: 'hourly',
    startAt: 'a', endAt: 'b', clawbotBookingId: 'local-1'
  });
  assert.equal(recovered.bookingId, 'BOOKING_1');
  assert.equal(options.requests.filter((r) => r.body.action === 'createBooking').length, 1);
});

test('getBooking returns null for an unknown booking id (not an error)', () => {
  const booking = loadClient({
    body: { ok: true, action: 'getBooking', requestId: 'x', patch: { bookings: [] } }
  }).getBooking('missing');
  assert.equal(booking, null);
});

test('cancelBooking uses a stable per-booking-and-reason requestId', () => {
  const options = { body: { ok: true, action: 'cancelBooking', requestId: 'x', bookingId: 'BOOKING_1', duplicate: false } };
  loadClient(options).cancelBooking('BOOKING_1', 'customer_cancelled');
  assert.equal(options.capturedRequest.body.requestId, 'clawbot-cancelBooking:BOOKING_1:customer_cancelled');
});

test('completeBooking requires a numeric amount and sends it alongside paymentMethod', () => {
  assert.throws(
    () => loadClient({}).completeBooking('BOOKING_1', 'bank_transfer'),
    /requires a numeric amount/
  );
  const options = { body: { ok: true, action: 'completeBooking', requestId: 'x', bookingId: 'BOOKING_1', duplicate: false } };
  loadClient(options).completeBooking('BOOKING_1', 'bank_transfer', 150000);
  assert.deepEqual(options.capturedRequest.body.payload, {
    bookingId: 'BOOKING_1', paymentMethod: 'bank_transfer', amount: 150000
  });
});

test('a BOT_WEBHOOK_ROOM_OVERLAP business error surfaces its code so callers can react distinctly', () => {
  const options = {
    body: { ok: false, code: 'BOT_WEBHOOK_ROOM_OVERLAP', requestId: 'x', message: 'Room already booked for this window' }
  };
  assert.throws(
    () => loadClient(options).createBooking({
      customerId: 'c1', customerName: 'An', roomId: 'R1', unit: 'hourly',
      startAt: 'a', endAt: 'b', clawbotBookingId: 'local-1'
    }),
    (error) => error.code === 'BOT_WEBHOOK_ROOM_OVERLAP'
  );
});

test('every infrastructure failure throws with no fallback', () => {
  const cases = [
    { fetchError: true, pattern: /Sleepbox webhook request failed: network unavailable/ },
    { status: 500, body: {}, pattern: /HTTP 500/ },
    { invalidJson: true, pattern: /invalid JSON/ }
  ];
  cases.forEach((options) => {
    assert.throws(() => loadClient(options).checkAvailability('a', 'b'), options.pattern);
  });
});
