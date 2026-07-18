'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require.extensions['.gs'] = require.extensions['.js'];

function loadModule(options = {}) {
  global.OrderService = { create: () => ({ sendPaymentQr: options.sendPaymentQr }) };
  global.BotOrderRepository = () => ({});
  global.SheetCustomerRepository = () => ({});
  global.SheetConversationStateRepository = () => ({});
  global.TelegramRuntime = { loadCatalog: () => [], createPaymentQrUrl: () => '', createId: () => 'id' };
  global.SheetRepositorySupport = { withScriptLock: (operation) => operation() };
  global.TelegramOutboundRenderer = { renderOutboundMessage: () => ({}) };
  global.TelegramClient = { create: () => ({ execute() {} }) };
  global.ZaloOutboundRenderer = { renderOutboundMessage: () => ({}) };
  global.ZaloClient = { create: () => ({ execute() {} }) };
  global.ZaloTokenManager = { createDefault: () => ({}) };
  global.NotificationDispatcher = {
    dispatchNotifications: options.dispatchNotifications || (() => [{ platform: 'telegram', skipped: false }])
  };
  delete require.cache[require.resolve('../admin/PaymentQrDispatch.gs')];
  return require('../admin/PaymentQrDispatch.gs');
}

test('parseThanhToanCommand extracts the orderId, tolerates @BotName and stray whitespace', () => {
  const { parseThanhToanCommand } = loadModule();
  assert.equal(parseThanhToanCommand('/thanhtoan HD123'), 'HD123');
  assert.equal(parseThanhToanCommand('  /thanhtoan   HD123  '), 'HD123');
  assert.equal(parseThanhToanCommand('/thanhtoan@SunkaBot HD123'), 'HD123');
});

test('parseThanhToanCommand returns null (command present, missing orderId) vs false (not the command)', () => {
  const { parseThanhToanCommand } = loadModule();
  assert.equal(parseThanhToanCommand('/thanhtoan'), null);
  assert.equal(parseThanhToanCommand('/start'), false);
  assert.equal(parseThanhToanCommand(''), false);
  assert.equal(parseThanhToanCommand(undefined), false);
});

test('dispatchPaymentQr sends the QR and reports dispatch results on success', () => {
  const customer = { customerId: 'c1', platformLinks: [{ platform: 'telegram', platformUserId: 'chat-1' }] };
  const outboundMessages = [{ type: 'text', content: {} }, { type: 'image', content: {} }];
  const calls = [];
  const { dispatchPaymentQr } = loadModule({
    sendPaymentQr: (orderId) => { calls.push(orderId); return { customer, outboundMessages }; },
    dispatchNotifications: (c, messages) => {
      assert.deepEqual(c, customer);
      assert.deepEqual(messages, outboundMessages);
      return [{ platform: 'telegram', skipped: false }];
    }
  });
  const result = dispatchPaymentQr('HD1');
  assert.deepEqual(calls, ['HD1']);
  assert.deepEqual(result, { ok: true, dispatchResults: [{ platform: 'telegram', skipped: false }] });
});

test('dispatchPaymentQr distinguishes not_found and already_resolved without throwing', () => {
  const notFound = loadModule({
    sendPaymentQr: () => { const error = new Error('missing'); error.code = 'ORDER_NOT_FOUND'; throw error; }
  });
  assert.deepEqual(notFound.dispatchPaymentQr('HD1'), { ok: false, reason: 'not_found', message: 'missing' });

  const resolved = loadModule({
    sendPaymentQr: () => {
      const error = new Error('already paid');
      error.code = 'PAYMENT_ALREADY_RESOLVED';
      error.status = 'PAID';
      throw error;
    }
  });
  assert.deepEqual(resolved.dispatchPaymentQr('HD1'), { ok: false, reason: 'already_resolved', status: 'PAID' });
});

test('dispatchPaymentQr reports sent_but_delivery_failed when the QR was generated but delivery throws', () => {
  const customer = { customerId: 'c1', platformLinks: [] };
  const { dispatchPaymentQr } = loadModule({
    sendPaymentQr: () => ({ customer, outboundMessages: [] }),
    dispatchNotifications: () => { throw new Error('Zalo API down'); }
  });
  assert.deepEqual(dispatchPaymentQr('HD1'), {
    ok: false, reason: 'sent_but_delivery_failed', message: 'Zalo API down'
  });
});

test('dispatchPaymentQr surfaces unexpected errors as a generic error reason', () => {
  const { dispatchPaymentQr } = loadModule({
    sendPaymentQr: () => { throw new Error('storage exploded'); }
  });
  assert.deepEqual(dispatchPaymentQr('HD1'), { ok: false, reason: 'error', message: 'storage exploded' });
});
