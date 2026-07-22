'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const BookingService = require('../core/bookingService');

test('orchestrates unit, slot, available room, confirmation, and persisted booking', () => {
  const customer = { customerId: 'C1', displayName: 'An', phone: '0909', memberId: 'M1' };
  let state = null;
  const saved = [];
  let id = 0;
  const service = BookingService.create({
    bookingRepository: { save: (value) => { saved.push(value); return value; }, findById: () => null,
      findByCustomerId: () => [], updateStatus: () => true, findOverlapping: () => [] },
    roomRepository: { list: () => [{ roomId: 'R1', name: 'Box 1', roomType: 'single',
      hourlyRate: 50000, overnightRate: 300000, isAvailable: true }],
      findById: () => ({ roomId: 'R1', name: 'Box 1', roomType: 'single', hourlyRate: 50000,
        overnightRate: 300000, isAvailable: true }) },
    customerRepository: { save: () => {}, findById: () => customer, findByPlatformUserId: () => customer },
    conversationStateRepository: { get: () => state, set: (_key, value) => { state = value; } },
    memberRepository: { resolve: () => ({ memberId: 'M1' }) },
    now: () => new Date('2026-07-22T00:00:00Z'), createId: () => `B${++id}`,
    createQrContent: () => 'https://example.test/qr.png',
    withLock: (operation) => operation()
  });
  const send = (payload, text = '') => service.handleMessage({ platform: 'test', platformUserId: 'U1', text, payload });
  assert.equal(send(null, '/phong')[0].type, 'button');
  assert.equal(send({ action: 'select_unit', unit: 'hourly' })[0].type, 'text');
  const rooms = send({ action: 'select_slot', startAt: '2026-08-01T10:00:00Z', durationHours: 3 });
  assert.equal(rooms[0].content.items[0].roomId, 'R1');
  assert.equal(send({ action: 'select_room', roomId: 'R1' })[0].content.summary.totalAmount, 150000);
  const confirmed = send({ action: 'confirm_booking' });
  assert.equal(confirmed[0].content.bookingId, 'B1');
  assert.equal(saved[0].status, 'AWAITING_PAYMENT');
  assert.equal(saved[0].memberId, 'M1');
  assert.equal(saved[0].durationHours, 3);
  assert.equal(state.currentState, 'AWAITING_PAYMENT');
  assert.equal(state.contextData.activeFlow, null);
});

test('does not enter booking while an order is in progress', () => {
  const customer = { customerId: 'C1', displayName: 'An', platformLinks: [] };
  const state = { customerId: 'C1', currentState: 'CART', contextData: { cart: [], activeFlow: 'order' } };
  let bookingWrites = 0;
  const service = BookingService.create({
    bookingRepository: { save: () => { bookingWrites++; }, findById: () => null,
      findByCustomerId: () => [], updateStatus: () => true, findOverlapping: () => [] },
    roomRepository: { list: () => [], findById: () => null },
    customerRepository: { save: () => {}, findById: () => customer, findByPlatformUserId: () => customer },
    conversationStateRepository: { get: () => state, set: () => { throw new Error('must not change state'); } },
    now: () => new Date('2026-07-22T00:00:00Z'), createId: () => 'B1',
    createQrContent: () => 'https://example.test/qr.png', withLock: (fn) => fn()
  });
  const response = service.handleMessage({ platform: 'test', platformUserId: 'U1', text: '/phong', payload: null });
  assert.equal(response[0].content.text,
    'Bạn đang đặt món dở, gõ /huydon để huỷ hoặc hoàn tất đơn trước khi đặt phòng.');
  assert.equal(bookingWrites, 0);
});

test('starts a fresh booking after every terminal order state', () => {
  ['PAID', 'DONE', 'CANCELLED', 'EXPIRED'].forEach((currentState) => {
    const customer = { customerId: 'C1', platformLinks: [] };
    let stored = { customerId: 'C1', currentState, contextData: { orderId: 'HD1', activeFlow: 'order' } };
    const service = BookingService.create({
      bookingRepository: { save() {}, findById: () => null, findByCustomerId: () => [], updateStatus: () => true, findOverlapping: () => [] },
      roomRepository: { list: () => [], findById: () => null },
      customerRepository: { save() {}, findById: () => customer, findByPlatformUserId: () => customer },
      conversationStateRepository: { get: () => stored, set: (_id, value) => { stored = value; } },
      now: () => new Date('2026-07-22T00:00:00Z'), createId: () => 'B1',
      createQrContent: () => 'https://example.test/qr.png', withLock: (fn) => fn()
    });
    const response = service.handleMessage({ platform: 'test', platformUserId: 'U1', text: '/phong', payload: null });
    assert.equal(response[0].type, 'button', currentState);
    assert.equal(stored.currentState, 'SELECTING_UNIT', currentState);
    assert.equal(stored.contextData.activeFlow, 'booking', currentState);
  });
});

test('blocks order commands while booking flow is active', () => {
  const customer = { customerId: 'C1', displayName: 'An', platformLinks: [] };
  const state = { customerId: 'C1', currentState: 'SELECTING_SLOT',
    contextData: { unit: 'hourly', activeFlow: 'booking' } };
  const service = BookingService.create({
    bookingRepository: { save: () => {}, findById: () => null, findByCustomerId: () => [],
      updateStatus: () => true, findOverlapping: () => [] },
    roomRepository: { list: () => [], findById: () => null },
    customerRepository: { save: () => {}, findById: () => customer, findByPlatformUserId: () => customer },
    conversationStateRepository: { get: () => state, set: () => {} },
    now: () => new Date('2026-07-22T00:00:00Z'), createId: () => 'B1',
    createQrContent: () => 'https://example.test/qr.png', withLock: (fn) => fn()
  });
  const response = service.handleMessage({ platform: 'test', platformUserId: 'U1', text: '/danhmuc', payload: null });
  assert.equal(response[0].content.text,
    'Bạn đang đặt phòng dở, hãy hoàn tất hoặc huỷ đặt phòng trước khi đặt món.');
});

test('sendPaymentQr returns booking QR only while payment is awaiting', () => {
  const booking = { bookingId: 'B1', customerId: 'C1', status: 'AWAITING_PAYMENT', totalAmount: 150000 };
  const service = BookingService.create({
    bookingRepository: { save: () => {}, findById: () => booking, findByCustomerId: () => [],
      updateStatus: () => true, findOverlapping: () => [] },
    roomRepository: { list: () => [], findById: () => null },
    customerRepository: { save: () => {}, findById: () => ({ customerId: 'C1', platformLinks: [] }),
      findByPlatformUserId: () => null },
    conversationStateRepository: { get: () => null, set: () => {} },
    now: () => new Date(), createId: () => 'B2', createQrContent: (value) => 'https://qr.test/' + value.bookingId,
    withLock: (fn) => fn()
  });
  const result = service.sendPaymentQr('B1');
  assert.equal(result.outboundMessages[1].content.data, 'https://qr.test/B1');
  booking.status = 'PAID';
  assert.throws(() => service.sendPaymentQr('B1'), (error) => error.code === 'PAYMENT_ALREADY_RESOLVED');
});

test('confirmPayment marks the booking PAID, saves through the repository, and advances a matching conversation state', () => {
  const booking = { bookingId: 'B1', customerId: 'C1', status: 'AWAITING_PAYMENT', totalAmount: 150000 };
  const saved = [];
  let state = { customerId: 'C1', currentState: 'AWAITING_PAYMENT', contextData: { bookingId: 'B1', activeFlow: null } };
  const service = BookingService.create({
    bookingRepository: { save: (value) => saved.push(value), findById: () => booking, findByCustomerId: () => [],
      updateStatus: () => true, findOverlapping: () => [] },
    roomRepository: { list: () => [], findById: () => null },
    customerRepository: { save: () => {}, findById: () => ({ customerId: 'C1', platformLinks: [] }),
      findByPlatformUserId: () => null },
    conversationStateRepository: { get: () => state, set: (_id, value) => { state = value; } },
    now: () => new Date('2026-07-22T00:00:00Z'), createId: () => 'B2', createQrContent: () => 'qr',
    withLock: (fn) => fn()
  });
  const result = service.confirmPayment('B1', 'staff@example.com');
  assert.equal(saved[0].status, 'PAID');
  assert.equal(saved[0].confirmedBy, 'staff@example.com');
  assert.equal(state.currentState, 'PAID');
  assert.match(result.outboundMessages[0].content.text, /đã được xác nhận thanh toán/);
});

test('confirmPayment rejects a booking that is not AWAITING_PAYMENT or does not exist', () => {
  const service = BookingService.create({
    bookingRepository: { save: () => {}, findById: () => null, findByCustomerId: () => [],
      updateStatus: () => true, findOverlapping: () => [] },
    roomRepository: { list: () => [], findById: () => null },
    customerRepository: { save: () => {}, findById: () => null, findByPlatformUserId: () => null },
    conversationStateRepository: { get: () => null, set: () => {} },
    now: () => new Date(), createId: () => 'B2', createQrContent: () => 'qr', withLock: (fn) => fn()
  });
  assert.throws(() => service.confirmPayment('missing', 'staff'), (error) => error.code === 'BOOKING_NOT_FOUND');
});

test('select_slot and select_room prefer roomRepository.checkAvailability when the repository is POS-backed', () => {
  const customer = { customerId: 'C1', displayName: 'An', phone: '0909', memberId: 'M1' };
  let state = null;
  const room = { roomId: 'R1', name: 'Box 1', roomType: 'single', hourlyRate: 50000, overnightRate: 300000, isAvailable: true };
  let checkAvailabilityCalls = 0;
  const saved = [];
  const service = BookingService.create({
    bookingRepository: { save: (value) => saved.push(value), findById: () => null, findByCustomerId: () => [],
      updateStatus: () => true,
      findOverlapping: () => { throw new Error('must not be called when checkAvailability is used'); } },
    roomRepository: {
      list: () => { throw new Error('must not be called when checkAvailability is used'); },
      findById: () => { throw new Error('must not be called when checkAvailability is used'); },
      checkAvailability: () => { checkAvailabilityCalls++; return [room]; }
    },
    customerRepository: { save: () => {}, findById: () => customer, findByPlatformUserId: () => customer },
    conversationStateRepository: { get: () => state, set: (_key, value) => { state = value; } },
    memberRepository: { resolve: () => ({ memberId: 'M1' }) },
    now: () => new Date('2026-07-22T00:00:00Z'), createId: () => 'B1',
    createQrContent: () => 'https://example.test/qr.png', withLock: (fn) => fn()
  });
  const send = (payload, text = '') => service.handleMessage({ platform: 'test', platformUserId: 'U1', text, payload });
  send(null, '/phong');
  send({ action: 'select_unit', unit: 'hourly' });
  send({ action: 'select_slot', startAt: '2026-08-01T10:00:00Z', durationHours: 3 });
  send({ action: 'select_room', roomId: 'R1' });
  const confirmed = send({ action: 'confirm_booking' });
  assert.equal(checkAvailabilityCalls, 2, 'called once for select_slot and once for select_room re-validation');
  assert.equal(confirmed[0].content.bookingId, 'B1');
  assert.equal(saved[0].endAt, '2026-08-01T13:00:00.000Z', 'endAt is now persisted on the booking');
});

test('confirm_booking surfaces a friendly message and cancels the local state when the POS reports a lost overlap race', () => {
  const customer = { customerId: 'C1', displayName: 'An', phone: '0909', memberId: 'M1' };
  let state = null;
  const room = { roomId: 'R1', name: 'Box 1', roomType: 'single', hourlyRate: 50000, overnightRate: 300000, isAvailable: true };
  const service = BookingService.create({
    bookingRepository: { save: () => { const e = new Error('Room already booked'); e.code = 'ROOM_OVERLAP'; throw e; },
      findById: () => null, findByCustomerId: () => [], updateStatus: () => true, findOverlapping: () => [] },
    roomRepository: { list: () => [], findById: () => null, checkAvailability: () => [room] },
    customerRepository: { save: () => {}, findById: () => customer, findByPlatformUserId: () => customer },
    conversationStateRepository: { get: () => state, set: (_key, value) => { state = value; } },
    memberRepository: { resolve: () => ({ memberId: 'M1' }) },
    now: () => new Date('2026-07-22T00:00:00Z'), createId: () => 'B1',
    createQrContent: () => 'https://example.test/qr.png', withLock: (fn) => fn()
  });
  const send = (payload, text = '') => service.handleMessage({ platform: 'test', platformUserId: 'U1', text, payload });
  send(null, '/phong');
  send({ action: 'select_unit', unit: 'hourly' });
  send({ action: 'select_slot', startAt: '2026-08-01T10:00:00Z', durationHours: 3 });
  send({ action: 'select_room', roomId: 'R1' });
  const response = send({ action: 'confirm_booking' });
  assert.match(response[0].content.text, /vừa có người đặt mất/);
});
