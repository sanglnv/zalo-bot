'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { dispatchNotifications } = require('../adapters/notificationDispatcher');

function registryEntry(platform, calls) {
  return {
    renderOutboundMessage(message, userId) {
      return { method: platform + 'Send', params: { userId, text: message.content.text } };
    },
    client: { execute(command) { calls.push(command); } }
  };
}

test('dispatches all messages to a customer with one platform link', () => {
  const calls = [];
  const results = dispatchNotifications(
    { platformLinks: [{ platform: 'alpha', platformUserId: 'user-1' }] },
    [{ type: 'text', content: { text: 'Paid' } }],
    { alpha: registryEntry('alpha', calls) }
  );
  assert.deepEqual(results, [{ platform: 'alpha', skipped: false }]);
  assert.deepEqual(calls, [{ method: 'alphaSend', params: { userId: 'user-1', text: 'Paid' } }]);
});

test('safely skips a platform absent from the registry', () => {
  assert.deepEqual(dispatchNotifications(
    { platformLinks: [{ platform: 'future', platformUserId: 'user-2' }] },
    [{ type: 'text', content: { text: 'Paid' } }],
    {}
  ), [{ platform: 'future', skipped: true }]);
});

test('dispatches independently across multiple platform links', () => {
  const calls = [];
  const results = dispatchNotifications(
    { platformLinks: [
      { platform: 'alpha', platformUserId: 'a-1' },
      { platform: 'beta', platformUserId: 'b-1' }
    ] },
    [
      { type: 'text', content: { text: 'Paid' } },
      { type: 'text', content: { text: 'Thanks' } }
    ],
    { alpha: registryEntry('alpha', calls), beta: registryEntry('beta', calls) }
  );
  assert.deepEqual(results, [
    { platform: 'alpha', skipped: false },
    { platform: 'beta', skipped: false }
  ]);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((call) => call.params.userId), ['a-1', 'a-1', 'b-1', 'b-1']);
});
