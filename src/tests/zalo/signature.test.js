'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const signature = require('../../adapters/zalo/verifyWebhookSignature');

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

test('verifies official sha256(appId + raw data + timestamp + OA secret) MAC', () => {
  const raw = '{"app_id":"app-1","sender":{"id":"u1"},"event_name":"user_send_text","message":{"text":"catalog","msg_id":"m1"},"timestamp":"123"}';
  const mac = sha256('app-1' + raw + '123' + 'oa-secret');
  assert.equal(signature.verifyWebhookSignature('mac=' + mac, raw, 'oa-secret', sha256), true);
  assert.equal(signature.verifyWebhookSignature('mac=' + '0'.repeat(64), raw, 'oa-secret', sha256), false);
});
