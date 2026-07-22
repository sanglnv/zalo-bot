'use strict';

var BookingStates = Object.freeze({
  IDLE: 'IDLE', SELECTING_UNIT: 'SELECTING_UNIT', SELECTING_SLOT: 'SELECTING_SLOT',
  SELECTING_ROOM: 'SELECTING_ROOM', CONFIRMING: 'CONFIRMING',
  AWAITING_PAYMENT: 'AWAITING_PAYMENT', PAID: 'PAID', DONE: 'DONE',
  CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED'
});
var BookingEvents = Object.freeze({
  START_BOOKING: 'START_BOOKING', SELECT_UNIT: 'SELECT_UNIT', SELECT_SLOT: 'SELECT_SLOT',
  SELECT_ROOM: 'SELECT_ROOM', CONFIRM_BOOKING: 'CONFIRM_BOOKING',
  PAYMENT_CONFIRMED: 'PAYMENT_CONFIRMED', COMPLETE: 'COMPLETE', CANCEL: 'CANCEL',
  PAYMENT_EXPIRED: 'PAYMENT_EXPIRED', START_NEW_BOOKING: 'START_NEW_BOOKING'
});
var TRANSITIONS = Object.freeze({
  IDLE: Object.freeze({ START_BOOKING: 'SELECTING_UNIT' }),
  SELECTING_UNIT: Object.freeze({ SELECT_UNIT: 'SELECTING_SLOT', CANCEL: 'CANCELLED' }),
  SELECTING_SLOT: Object.freeze({ SELECT_SLOT: 'SELECTING_ROOM', CANCEL: 'CANCELLED' }),
  SELECTING_ROOM: Object.freeze({ SELECT_ROOM: 'CONFIRMING', CANCEL: 'CANCELLED' }),
  CONFIRMING: Object.freeze({ CONFIRM_BOOKING: 'AWAITING_PAYMENT', CANCEL: 'CANCELLED' }),
  AWAITING_PAYMENT: Object.freeze({ PAYMENT_CONFIRMED: 'PAID', CANCEL: 'CANCELLED', PAYMENT_EXPIRED: 'EXPIRED' }),
  PAID: Object.freeze({ COMPLETE: 'DONE' }),
  DONE: Object.freeze({ START_NEW_BOOKING: 'SELECTING_UNIT' }),
  CANCELLED: Object.freeze({ START_NEW_BOOKING: 'SELECTING_UNIT' }),
  EXPIRED: Object.freeze({ START_NEW_BOOKING: 'SELECTING_UNIT' })
});

function transition(currentState, event, contextData) {
  if (!Object.prototype.hasOwnProperty.call(TRANSITIONS, currentState)) {
    throw new Error('Unknown booking state: ' + currentState);
  }
  if (!event || typeof event !== 'string') throw new TypeError('event must be a non-empty string');
  if (!contextData || typeof contextData !== 'object' || Array.isArray(contextData)) {
    throw new TypeError('contextData must be an object');
  }
  var nextState = TRANSITIONS[currentState][event];
  if (!nextState) throw new Error('Invalid booking transition: ' + currentState + ' --' + event + '--> ?');
  return { nextState: nextState, newContextData: Object.assign({}, contextData) };
}

var BookingStateMachine = Object.freeze({ States: BookingStates, Events: BookingEvents, transition: transition });
if (typeof module !== 'undefined' && module.exports) module.exports = BookingStateMachine;
