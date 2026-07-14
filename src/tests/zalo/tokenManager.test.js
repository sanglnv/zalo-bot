'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
require.extensions['.gs'] = require.extensions['.js'];
const ZaloTokenManager = require('../../adapters/zalo/ZaloTokenManager.gs');

test('rotates a single-use refresh token once and reuses the new access token', () => {
  const values = {
    ZALO_ACCESS_TOKEN: 'expired-access',
    ZALO_REFRESH_TOKEN: 'single-use-refresh',
    ZALO_ACCESS_TOKEN_EXPIRES_AT: '1'
  };
  let refreshCalls = 0;
  let lockCalls = 0;
  const manager = ZaloTokenManager.create({
    properties: {
      getProperty: (name) => values[name] || null,
      setProperties(next) { Object.assign(values, next); }
    },
    withLock(operation) { lockCalls += 1; return operation(); },
    refresh(token) {
      refreshCalls += 1;
      assert.equal(token, 'single-use-refresh');
      return { access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: '90000' };
    },
    nowMs: () => 1000
  });

  assert.equal(manager.getValidAccessToken(), 'new-access');
  assert.equal(manager.getValidAccessToken(), 'new-access');
  assert.equal(refreshCalls, 1);
  assert.equal(lockCalls, 2);
  assert.equal(values.ZALO_REFRESH_TOKEN, 'rotated-refresh');
});

test('bootstraps secrets atomically under the shared lock', () => {
  const values = {};
  const manager = ZaloTokenManager.create({
    properties: { getProperty: (name) => values[name], setProperties: (next) => Object.assign(values, next) },
    withLock: (operation) => operation(),
    refresh: () => { throw new Error('not expected'); },
    nowMs: () => 5000
  });
  manager.bootstrap('access', 'refresh', 100);
  assert.equal(values.ZALO_ACCESS_TOKEN, 'access');
  assert.equal(values.ZALO_REFRESH_TOKEN, 'refresh');
  assert.equal(values.ZALO_ACCESS_TOKEN_EXPIRES_AT, '105000');
});
