'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderZbsTemplateMessage } = require('../../adapters/zalo/renderZbsTemplateMessage');
const { dispatchNotifications } = require('../../adapters/notificationDispatcher');

test('payment confirmation and expiry select separate approved ZBS templates', () => {
  const ids = { paymentConfirmed: 'paid-template', expired: 'expired-template' };
  const paid = renderZbsTemplateMessage({
    type: 'text', content: { text: 'Đã xác nhận thanh toán cho đơn #o1. Cảm ơn bạn!', orderId: 'o1' }
  }, 'u1', ids);
  const expired = renderZbsTemplateMessage({
    type: 'text', content: { text: 'Đơn hàng #o2 đã hết hạn do quá thời gian chờ thanh toán.', orderId: 'o2' }
  }, 'u1', ids);
  assert.equal(paid.method, 'sendZbsTemplate');
  assert.equal(paid.params.template_id, 'paid-template');
  assert.equal(expired.params.template_id, 'expired-template');
  assert.deepEqual(expired.params.template_data, {
    order_id: 'o2', message: 'Đơn hàng #o2 đã hết hạn do quá thời gian chờ thanh toán.'
  });
});

test('notification registry dispatches Zalo links through ZBS, not the normal Send API', () => {
  const calls = [];
  global.PropertiesService = {
    getScriptProperties: () => ({
      getProperty(name) {
        return {
          ZALO_ZBS_PAYMENT_CONFIRMED_TEMPLATE_ID: 'paid-template',
          ZALO_ZBS_ORDER_EXPIRED_TEMPLATE_ID: 'expired-template'
        }[name] || null;
      }
    })
  };
  global.TelegramOutboundRenderer = { renderOutboundMessage: () => ({}) };
  global.TelegramClient = { create: () => ({ execute() {} }) };
  global.ZaloTokenManager = { createDefault: () => ({ getValidAccessToken: () => 'token' }) };
  global.ZbsTemplateRenderer = { renderZbsTemplateMessage };
  global.ZbsTemplateClient = {
    create: () => ({ execute(command) { calls.push(command); } })
  };
  delete require.cache[require.resolve('../../adapters/NotificationRegistry.gs')];
  require.extensions['.gs'] = require.extensions['.js'];
  const buildNotificationRegistry = require('../../adapters/NotificationRegistry.gs');
  const registry = buildNotificationRegistry();

  dispatchNotifications(
    { platformLinks: [{ platform: 'zalo', platformUserId: 'u1' }] },
    [{ type: 'text', content: { text: 'Đã xác nhận thanh toán cho đơn #o1. Cảm ơn bạn!', orderId: 'o1' } }],
    registry
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendZbsTemplate');
  assert.equal(calls[0].params.template_id, 'paid-template');
});
