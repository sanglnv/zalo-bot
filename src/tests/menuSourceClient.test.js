'use strict';

// MenuSourceClient.gs is a deprecated one-line alias now that the menu and
// order webhooks turned out to be the same endpoint. See botOrderWebhookClient.test.js
// for the real coverage of BotOrderWebhookClient.fetchMenuCatalog().
const test = require('node:test');
const assert = require('node:assert/strict');

require.extensions['.gs'] = require.extensions['.js'];

test('MenuSourceClient delegates to BotOrderWebhookClient.fetchMenuCatalog', () => {
  global.BotOrderWebhookClient = {
    fetchMenuCatalog: () => [{ productId: 'p1', name: 'Coffee', price: 35000, isAvailable: true }]
  };
  delete require.cache[require.resolve('../adapters/menu/MenuSourceClient.gs')];
  const MenuSourceClient = require('../adapters/menu/MenuSourceClient.gs');
  assert.deepEqual(MenuSourceClient.fetchCatalog(), [
    { productId: 'p1', name: 'Coffee', price: 35000, isAvailable: true }
  ]);
});
