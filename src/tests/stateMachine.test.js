'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { States, Events, transition } = require('../core/stateMachine');

const valid = {
  IDLE: { START_BROWSING: 'BROWSING' },
  BROWSING: { ADD_TO_CART: 'CART', CANCEL: 'CANCELLED' },
  CART: { ADD_TO_CART: 'CART', REVIEW_CART: 'CONFIRMING', CANCEL: 'CANCELLED' },
  CONFIRMING: { CONFIRM_ORDER: 'AWAITING_PAYMENT', CANCEL: 'CANCELLED' },
  AWAITING_PAYMENT: {
    PAYMENT_CONFIRMED: 'PAID', CANCEL: 'CANCELLED', PAYMENT_EXPIRED: 'EXPIRED'
  },
  PAID: { COMPLETE: 'DONE' },
  DONE: {},
  CANCELLED: {},
  EXPIRED: {}
};

test('all documented valid transitions reach the expected state and preserve immutability', () => {
  for (const [from, events] of Object.entries(valid)) {
    for (const [event, expected] of Object.entries(events)) {
      const context = { cart: [{ productId: 'p1' }] };
      const result = transition(from, event, context);
      assert.equal(result.nextState, expected);
      assert.deepEqual(result.newContextData, context);
      assert.notEqual(result.newContextData, context);
    }
  }
});

test('every state/event pair outside the transition table throws a clear error', () => {
  for (const state of Object.values(States)) {
    for (const event of Object.values(Events)) {
      if (valid[state][event]) continue;
      assert.throws(() => transition(state, event, {}), {
        message: `Invalid transition: ${state} --${event}--> ?`
      });
    }
  }
});

test('rejects unknown states and malformed context', () => {
  assert.throws(() => transition('MISSING', Events.START_BROWSING, {}), /Unknown conversation state/);
  assert.throws(() => transition(States.IDLE, Events.START_BROWSING, null), /contextData must be an object/);
  assert.throws(() => transition(States.IDLE, '', {}), /event must be a non-empty string/);
});
