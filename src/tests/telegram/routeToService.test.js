'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { routeToService } = require('../../adapters/routeToService');

function fixture(activeFlow) {
  const orderService = { name: 'order' };
  const bookingService = { name: 'booking' };
  return { orderService, bookingService,
    customerRepository: { findByPlatformUserId: () => ({ customerId: 'C1' }) },
    conversationStateRepository: { get: () => activeFlow == null ? null
      : ({ contextData: { activeFlow } }) } };
}
const inbound = (text, payload = null) => ({ platform: 'telegram', platformUserId: 'U1', text, payload });
test('/phong always routes to booking service', () => {
  const deps = fixture('order');
  assert.equal(routeToService(deps, inbound('/phong')), deps.bookingService);
});
test('ordinary messages during active booking route to booking service', () => {
  const deps = fixture('booking');
  assert.equal(routeToService(deps, inbound('anything')), deps.bookingService);
});
test('default and explicit order flow route to order service', () => {
  const defaults = fixture(null);
  assert.equal(routeToService(defaults, inbound('/danhmuc')), defaults.orderService);
  const order = fixture('order');
  assert.equal(routeToService(order, inbound('/danhmuc')), order.orderService);
});
