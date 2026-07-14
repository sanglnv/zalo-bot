'use strict';

var ConversationStates = Object.freeze({
  IDLE: 'IDLE',
  BROWSING: 'BROWSING',
  CART: 'CART',
  CONFIRMING: 'CONFIRMING',
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  PAID: 'PAID',
  DONE: 'DONE',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED'
});

var ConversationEvents = Object.freeze({
  START_BROWSING: 'START_BROWSING',
  ADD_TO_CART: 'ADD_TO_CART',
  UPDATE_CART: 'UPDATE_CART',
  REVIEW_CART: 'REVIEW_CART',
  CONFIRM_ORDER: 'CONFIRM_ORDER',
  PAYMENT_CONFIRMED: 'PAYMENT_CONFIRMED',
  COMPLETE: 'COMPLETE',
  CANCEL: 'CANCEL',
  PAYMENT_EXPIRED: 'PAYMENT_EXPIRED',
  START_NEW_ORDER: 'START_NEW_ORDER'
});

var TRANSITIONS = Object.freeze({
  IDLE: Object.freeze({ START_BROWSING: 'BROWSING' }),
  BROWSING: Object.freeze({ START_BROWSING: 'BROWSING', ADD_TO_CART: 'CART', CANCEL: 'CANCELLED' }),
  CART: Object.freeze({
    ADD_TO_CART: 'CART', UPDATE_CART: 'CART', REVIEW_CART: 'CONFIRMING', CANCEL: 'CANCELLED'
  }),
  CONFIRMING: Object.freeze({
    ADD_TO_CART: 'CART', UPDATE_CART: 'CART', CONFIRM_ORDER: 'AWAITING_PAYMENT', CANCEL: 'CANCELLED'
  }),
  AWAITING_PAYMENT: Object.freeze({
    PAYMENT_CONFIRMED: 'PAID',
    CANCEL: 'CANCELLED',
    PAYMENT_EXPIRED: 'EXPIRED'
  }),
  PAID: Object.freeze({ COMPLETE: 'DONE', START_NEW_ORDER: 'BROWSING' }),
  DONE: Object.freeze({ START_NEW_ORDER: 'BROWSING' }),
  CANCELLED: Object.freeze({ START_NEW_ORDER: 'BROWSING' }),
  EXPIRED: Object.freeze({ START_NEW_ORDER: 'BROWSING' })
});

/**
 * Pure conversation transition.
 * @param {string} currentState
 * @param {string} event
 * @param {Object} contextData
 * @returns {{nextState: string, newContextData: Object}}
 */
function transition(currentState, event, contextData) {
  if (!Object.prototype.hasOwnProperty.call(TRANSITIONS, currentState)) {
    throw new Error('Unknown conversation state: ' + currentState);
  }
  if (!event || typeof event !== 'string') throw new TypeError('event must be a non-empty string');
  if (!contextData || typeof contextData !== 'object' || Array.isArray(contextData)) {
    throw new TypeError('contextData must be an object');
  }
  var nextState = TRANSITIONS[currentState][event];
  if (!nextState) {
    throw new Error('Invalid transition: ' + currentState + ' --' + event + '--> ?');
  }
  return { nextState: nextState, newContextData: Object.assign({}, contextData) };
}

var StateMachine = Object.freeze({
  States: ConversationStates,
  Events: ConversationEvents,
  transition: transition
});

if (typeof module !== 'undefined' && module.exports) module.exports = StateMachine;
