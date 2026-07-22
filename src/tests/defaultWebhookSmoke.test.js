'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require.extensions['.gs'] = require.extensions['.js'];

function repository(methods) {
  const value = {};
  methods.forEach((method) => { value[method] = () => null; });
  return value;
}
function installCommon() {
  global.OrderService = { create(dependencies) {
    assert.equal(typeof dependencies.createQrContent, 'function', 'orderService requires createQrContent');
    return { handleMessage() { return []; } };
  } };
  global.BookingService = { create(dependencies) {
    assert.equal(typeof dependencies.createQrContent, 'function', 'bookingService requires createQrContent');
    return { handleMessage() { return []; } };
  } };
  global.BotOrderRepository = () => repository(['save', 'findById', 'findByCustomerId', 'updateStatus']);
  global.SheetBookingRepository = () => repository(['save', 'findById', 'findByCustomerId', 'updateStatus', 'findOverlapping']);
  global.SheetRoomRepository = () => repository(['list', 'findById']);
  global.SheetCustomerRepository = () => repository(['save', 'findById', 'findByPlatformUserId']);
  global.SheetConversationStateRepository = () => repository(['get', 'set']);
  global.MemberRepository = () => ({});
  global.SheetRepositorySupport = { withScriptLock: (fn) => fn() };
  global.SheetProcessedUpdateRepository = () => repository(['has', 'markProcessed', 'updateDeliveryStatus']);
  global.SheetZaloProcessedUpdateRepository = () => repository(['has', 'markProcessed', 'updateDeliveryStatus']);
  global.SheetErrorLogRepository = () => ({ log() {} });
  global.ServiceRouter = { routeToService: () => ({ handleMessage: () => [] }) };
}

test('default Telegram webhook constructs with all mandatory service dependencies', () => {
  installCommon();
  global.TelegramRuntime = { loadCatalog: () => [], createPaymentQrUrl: () => 'https://qr.test', createId: () => 'id', fallbackMessage: () => 'fallback' };
  global.TelegramInboundMapper = { mapInboundMessage: () => null };
  global.TelegramOutboundRenderer = { renderOutboundMessage: () => ({}) };
  global.TelegramClient = { create: () => ({ execute() {} }) };
  const module = require('../adapters/telegram/webhook.gs');
  assert.equal(typeof module.createDefaultTelegramWebhook(), 'object');
});

test('default Zalo webhook constructs with all mandatory service dependencies', () => {
  installCommon();
  global.ZaloRuntime = { loadCatalog: () => [], createPaymentQrUrl: () => 'https://qr.test', createId: () => 'id', fallbackMessage: () => 'fallback', requiredProperty: () => 'secret' };
  global.ZaloInboundMapper = { mapInboundMessage: () => null };
  global.ZaloOutboundRenderer = { renderOutboundMessage: () => ({}) };
  global.ZaloTokenManager = { createDefault: () => ({}) };
  global.ZaloClient = { create: () => ({ execute() {} }) };
  global.ZaloWebhookSignature = { verifyWebhookSignature: () => true };
  global.Utilities = { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest: () => [] };
  const module = require('../adapters/zalo/webhook.gs');
  assert.equal(typeof module.createDefaultZaloWebhook(), 'object');
});
