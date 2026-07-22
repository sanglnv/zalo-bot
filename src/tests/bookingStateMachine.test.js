'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { States, Events, transition } = require('../core/bookingStateMachine');

const valid = {
  IDLE: { START_BOOKING: 'SELECTING_UNIT' },
  SELECTING_UNIT: { SELECT_UNIT: 'SELECTING_SLOT', CANCEL: 'CANCELLED' },
  SELECTING_SLOT: { SELECT_SLOT: 'SELECTING_ROOM', CANCEL: 'CANCELLED' },
  SELECTING_ROOM: { SELECT_ROOM: 'CONFIRMING', CANCEL: 'CANCELLED' },
  CONFIRMING: { CONFIRM_BOOKING: 'AWAITING_PAYMENT', CANCEL: 'CANCELLED' },
  AWAITING_PAYMENT: { PAYMENT_CONFIRMED: 'PAID', CANCEL: 'CANCELLED', PAYMENT_EXPIRED: 'EXPIRED' },
  PAID: { COMPLETE: 'DONE' }, DONE: { START_NEW_BOOKING: 'SELECTING_UNIT' },
  CANCELLED: { START_NEW_BOOKING: 'SELECTING_UNIT' }, EXPIRED: { START_NEW_BOOKING: 'SELECTING_UNIT' }
};
test('all documented booking transitions are valid and immutable', () => {
  for (const [state, events] of Object.entries(valid)) for (const [event, expected] of Object.entries(events)) {
    const context = { roomId: 'R1' };
    const result = transition(state, event, context);
    assert.equal(result.nextState, expected);
    assert.deepEqual(result.newContextData, context);
    assert.notEqual(result.newContextData, context);
  }
});
test('all undocumented state/event pairs fail clearly', () => {
  for (const state of Object.values(States)) for (const event of Object.values(Events)) {
    if (!valid[state][event]) assert.throws(() => transition(state, event, {}),
      { message: `Invalid booking transition: ${state} --${event}--> ?` });
  }
});
test('rejects malformed transition inputs', () => {
  assert.throws(() => transition('UNKNOWN', Events.START_BOOKING, {}), /Unknown booking state/);
  assert.throws(() => transition(States.IDLE, '', {}), /event must be a non-empty string/);
  assert.throws(() => transition(States.IDLE, Events.START_BOOKING, null), /contextData must be an object/);
});
