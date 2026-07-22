'use strict';

function bookingServiceDependencies() {
  return typeof module !== 'undefined' && module.exports ? {
    Domain: require('./domain.js'), BookingStateMachine: require('./bookingStateMachine.js'),
    BookingBilling: require('./bookingBilling.js'), Repositories: require('./repositoryContracts.js')
  } : { Domain: Domain, BookingStateMachine: BookingStateMachine,
    BookingBilling: BookingBilling, Repositories: Repositories };
}
function outbound(type, content) { return { type: type, content: content }; }
function createBookingService(dependencies) {
  dependencies = dependencies || {};
  var d = dependencies.coreDependencies || bookingServiceDependencies();
  d.Repositories.assert(dependencies.bookingRepository, d.Repositories.contracts.booking, 'bookingRepository');
  d.Repositories.assert(dependencies.roomRepository, d.Repositories.contracts.room, 'roomRepository');
  d.Repositories.assert(dependencies.customerRepository, d.Repositories.contracts.customer, 'customerRepository');
  d.Repositories.assert(dependencies.conversationStateRepository, d.Repositories.contracts.conversationState,
    'conversationStateRepository');
  ['now', 'createId', 'withLock', 'createQrContent'].forEach(function (name) {
    if (typeof dependencies[name] !== 'function') throw new TypeError(name + ' must be a function');
  });
  var sm = d.BookingStateMachine;
  function getCustomer(message) {
    var customer = dependencies.customerRepository.findByPlatformUserId(message.platform, message.platformUserId);
    if (!customer) {
      customer = { customerId: dependencies.createId(), phone: null, displayName: '',
        platformLinks: [{ platform: message.platform, platformUserId: message.platformUserId }] };
      dependencies.customerRepository.save(customer);
    }
    // TODO(Phase 2): run the shared profile gate once in the webhook router.
    return customer;
  }
  function loadState(customerId) {
    var state = dependencies.conversationStateRepository.get(customerId);
    // ConversationState is shared with OrderService. Several terminal state
    // names overlap (PAID/DONE/CANCELLED/EXPIRED), so the state name alone
    // cannot identify its owner. activeFlow is the authoritative marker.
    if (state && state.contextData && state.contextData.activeFlow === 'booking' &&
        Object.prototype.hasOwnProperty.call(sm.States, state.currentState)) return state;
    return { customerId: customerId, currentState: sm.States.IDLE, contextData: {},
      updatedAt: dependencies.now().toISOString() };
  }
  function move(state, event, patch) {
    var result = sm.transition(state.currentState, event, state.contextData);
    var next = { customerId: state.customerId, currentState: result.nextState,
      contextData: Object.assign({}, result.newContextData, patch || {}),
      updatedAt: dependencies.now().toISOString() };
    dependencies.conversationStateRepository.set(next.customerId, next);
    return next;
  }
  function actionOf(message) {
    if (message.payload && typeof message.payload.action === 'string') return message.payload.action;
    var value = message.text.trim().toLowerCase().split(/\s+/)[0] || '';
    if (value.charAt(0) === '/') value = value.slice(1).split('@')[0];
    return value === 'phong' ? 'start_booking' : value;
  }
  function interval(unit, payload) {
    var start = new Date(payload.startAt);
    var quantity = unit === 'hourly' ? payload.durationHours : payload.nights;
    if (!Number.isFinite(start.getTime()) || !Number.isInteger(quantity) || quantity <= 0) {
      throw new TypeError('A valid startAt and positive duration are required');
    }
    return { startAt: start.toISOString(), endAt: new Date(start.getTime() + quantity *
      (unit === 'hourly' ? 3600000 : 86400000)).toISOString(), quantity: quantity };
  }
  function handleTransaction(message) {
    d.Domain.validateInboundMessage(message);
    var customer = getCustomer(message);
    var existingState = dependencies.conversationStateRepository.get(customer.customerId);
    var action = actionOf(message);
    var terminalOrderStates = { IDLE: true, PAID: true, DONE: true, CANCELLED: true, EXPIRED: true };
    if (action === 'start_booking' && existingState &&
        (!existingState.contextData || existingState.contextData.activeFlow !== 'booking') &&
        !terminalOrderStates[existingState.currentState]) {
      return [outbound('text', {
        text: 'Bạn đang đặt món dở, gõ /huydon để huỷ hoặc hoàn tất đơn trước khi đặt phòng.'
      })];
    }
    var state = loadState(customer.customerId);
    var orderActions = {
      catalog: true, danhmuc: true, browse: true, cart: true, giohang: true,
      checkout: true, dathang: true, add_item: true, confirm_order: true
    };
    if (state.contextData && state.contextData.activeFlow === 'booking' && orderActions[action]) {
      return [outbound('text', {
        text: 'Bạn đang đặt phòng dở, hãy hoàn tất hoặc huỷ đặt phòng trước khi đặt món.'
      })];
    }
    if (action === 'start_booking') {
      var startEvent = state.currentState === sm.States.IDLE ? sm.Events.START_BOOKING : sm.Events.START_NEW_BOOKING;
      state = move(state, startEvent, { activeFlow: 'booking' });
      return [outbound('button', { text: 'Bạn muốn đặt phòng theo giờ hay theo đêm?', buttons: [
        { action: 'select_unit', unit: 'hourly', label: 'Theo giờ' },
        { action: 'select_unit', unit: 'nightly', label: 'Theo đêm' }
      ] })];
    }
    if (action === 'select_unit') {
      var unit = message.payload && message.payload.unit;
      if (unit !== 'hourly' && unit !== 'nightly') throw new TypeError('unit must be hourly or nightly');
      state = move(state, sm.Events.SELECT_UNIT, { unit: unit });
      return [outbound('text', { text: unit === 'hourly'
        ? 'Hãy chọn giờ nhận phòng và số giờ thuê.' : 'Hãy chọn ngày nhận phòng và số đêm.' })];
    }
    if (action === 'select_slot') {
      var slot = interval(state.contextData.unit, message.payload || {});
      var rooms = dependencies.roomRepository.list();
      var bookings = [];
      rooms.forEach(function (room) {
        bookings = bookings.concat(dependencies.bookingRepository.findOverlapping(room.roomId, slot.startAt, slot.endAt));
      });
      var available = d.BookingBilling.findAvailableRooms(rooms, bookings, slot.startAt, slot.endAt);
      state = move(state, sm.Events.SELECT_SLOT, { startAt: slot.startAt, endAt: slot.endAt,
        durationHours: state.contextData.unit === 'hourly' ? slot.quantity : undefined,
        nights: state.contextData.unit === 'nightly' ? slot.quantity : undefined });
      return [outbound('list', { title: 'Phòng trống', items: available, buttons: available.map(function (room) {
        return { action: 'select_room', roomId: room.roomId, label: room.name };
      }) })];
    }
    if (action === 'select_room') {
      var room = dependencies.roomRepository.findById(message.payload && message.payload.roomId);
      if (!room || !room.isAvailable) throw new Error('Room is not available');
      var overlaps = dependencies.bookingRepository.findOverlapping(room.roomId,
        state.contextData.startAt, state.contextData.endAt);
      if (!d.BookingBilling.findAvailableRooms([room], overlaps, state.contextData.startAt,
        state.contextData.endAt).length) throw new Error('Room is no longer available');
      var quantity = state.contextData.unit === 'hourly' ? state.contextData.durationHours : state.contextData.nights;
      var bill = d.BookingBilling.calculateBookingBill(room, state.contextData.unit, quantity);
      state = move(state, sm.Events.SELECT_ROOM, {
        roomId: room.roomId, roomName: room.name, roomType: room.roomType, bill: bill
      });
      return [outbound('button', { text: 'Phòng: ' + room.name + '\nTổng tiền: ' + bill.totalAmount,
        summary: bill, buttons: [{ action: 'confirm_booking', label: 'Xác nhận' },
          { action: 'cancel_booking', label: 'Hủy' }] })];
    }
    if (action === 'confirm_booking') {
      var prepared = sm.transition(state.currentState, sm.Events.CONFIRM_BOOKING, state.contextData);
      var timestamp = dependencies.now().toISOString();
      var booking = { bookingId: dependencies.createId(), customerId: customer.customerId,
        memberId: customer.memberId || null, roomId: state.contextData.roomId, unit: state.contextData.unit,
        startAt: state.contextData.startAt, status: 'AWAITING_PAYMENT',
        totalAmount: state.contextData.bill.totalAmount, createdAt: timestamp, updatedAt: timestamp };
      if (booking.unit === 'hourly') booking.durationHours = state.contextData.durationHours;
      else booking.nights = state.contextData.nights;
      dependencies.bookingRepository.save(booking);
      dependencies.conversationStateRepository.set(customer.customerId, { customerId: customer.customerId,
        currentState: prepared.nextState, contextData: Object.assign({}, prepared.newContextData,
          { bookingId: booking.bookingId, activeFlow: null }), updatedAt: timestamp });
      return [outbound('text', { text: 'Đã giữ phòng #' + booking.bookingId +
        '. Nhân viên sẽ gửi mã QR thanh toán ngay khi xác nhận.', bookingId: booking.bookingId,
        amount: booking.totalAmount, roomName: state.contextData.roomName,
        roomType: state.contextData.roomType, unit: booking.unit, startAt: booking.startAt,
        durationHours: booking.durationHours, nights: booking.nights })];
    }
    if (action === 'cancel_booking') {
      var cancelled = move(state, sm.Events.CANCEL, { activeFlow: null });
      if (cancelled.contextData.bookingId) dependencies.bookingRepository.updateStatus(cancelled.contextData.bookingId, 'CANCELLED');
      return [outbound('text', { text: 'Đã hủy đặt phòng.' })];
    }
    return [outbound('text', { text: 'Gõ /phong để bắt đầu đặt phòng sleepbox.' })];
  }
  function sendPaymentQr(bookingId) {
    return dependencies.withLock(function () {
      if (typeof bookingId !== 'string' || bookingId.trim() === '') {
        throw new TypeError('bookingId must be a non-empty string');
      }
      var booking = dependencies.bookingRepository.findById(bookingId);
      if (!booking) {
        var missing = new Error('Booking not found: ' + bookingId);
        missing.code = 'BOOKING_NOT_FOUND';
        throw missing;
      }
      if (booking.status !== 'AWAITING_PAYMENT') {
        var resolved = new Error('Booking payment is already resolved: ' + bookingId);
        resolved.code = 'PAYMENT_ALREADY_RESOLVED';
        resolved.status = booking.status;
        throw resolved;
      }
      var customer = dependencies.customerRepository.findById(booking.customerId);
      if (!customer) throw new Error('Customer not found for booking: ' + bookingId);
      var qrContent = dependencies.createQrContent(booking);
      return { customer: customer, outboundMessages: [
        outbound('text', { text: 'Đặt phòng #' + booking.bookingId +
          '. Vui lòng thanh toán ' + booking.totalAmount + ' đ.', bookingId: booking.bookingId,
          amount: booking.totalAmount }),
        outbound('image', { purpose: 'payment_qr', data: qrContent, bookingId: booking.bookingId,
          caption: 'Đặt phòng #' + booking.bookingId + '\nSố tiền: ' + booking.totalAmount + ' đ' })
      ] };
    });
  }
  return Object.freeze({ handleMessage: function (message) {
    return dependencies.withLock(function () { return handleTransaction(message); });
  }, sendPaymentQr: sendPaymentQr });
}

var BookingService = Object.freeze({ create: createBookingService });
if (typeof module !== 'undefined' && module.exports) module.exports = BookingService;
