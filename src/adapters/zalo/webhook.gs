'use strict';

var ZaloWebhook = (function () {
  function successResponse() {
    return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
  }

  function create(dependencies) {
    dependencies = dependencies || {};
    ['mapInboundMessage', 'renderOutboundMessage', 'verifySignature', 'withLock', 'now'].forEach(function (name) {
      if (typeof dependencies[name] !== 'function') throw new TypeError(name + ' must be a function');
    });
    if (!dependencies.orderService || typeof dependencies.orderService.handleMessage !== 'function') {
      throw new TypeError('orderService.handleMessage is required');
    }
    if (!dependencies.processedUpdateRepository ||
        typeof dependencies.processedUpdateRepository.has !== 'function' ||
        typeof dependencies.processedUpdateRepository.markProcessed !== 'function' ||
        typeof dependencies.processedUpdateRepository.updateDeliveryStatus !== 'function') {
      throw new TypeError('processedUpdateRepository contract is required');
    }
    if (!dependencies.errorLogRepository || typeof dependencies.errorLogRepository.log !== 'function') {
      throw new TypeError('errorLogRepository.log is required');
    }
    if (!dependencies.client || typeof dependencies.client.execute !== 'function') {
      throw new TypeError('client.execute is required');
    }
    if (typeof dependencies.fallbackMessage !== 'function') throw new TypeError('fallbackMessage is required');

    function logError(error, context) {
      try {
        dependencies.errorLogRepository.log({
          timestamp: dependencies.now().toISOString(),
          context: context || {},
          message: error && error.message ? error.message : String(error),
          stack: error && error.stack ? error.stack : ''
        });
      } catch (loggingError) {
        if (typeof console !== 'undefined' && console.error) console.error(loggingError);
      }
    }

    function signatureFrom(event) {
      var headers = event && event.headers ? event.headers : {};
      return headers['X-ZEvent-Signature'] || headers['x-zevent-signature'] ||
        (event && event.parameter && (event.parameter.signature || event.parameter.mac)) || '';
    }

    function setStatus(messageId, status) {
      try { dependencies.processedUpdateRepository.updateDeliveryStatus(messageId, status); }
      catch (error) { logError(error, { stage: 'delivery_status', messageId: messageId, requestedStatus: status }); }
    }

    function sendFallback(userId) {
      if (!userId) return { delivered: false, error: null };
      try {
        dependencies.client.execute(dependencies.renderOutboundMessage(
          { type: 'text', content: { text: dependencies.fallbackMessage() } }, userId
        ));
        return { delivered: true, error: null };
      } catch (error) {
        return { delivered: false, error: error && error.message ? error.message : String(error) };
      }
    }

    function sendUserMessage(userId, text) {
      if (!userId) return { delivered: false, error: null };
      try {
        dependencies.client.execute(dependencies.renderOutboundMessage(
          { type: 'text', content: { text: text } }, userId
        ));
        return { delivered: true, error: null };
      } catch (error) {
        return { delivered: false, error: error && error.message ? error.message : String(error) };
      }
    }

    // Zalo has no ops channel of its own -- confirmations from Zalo
    // customers are notified in the same Telegram ops chat as Telegram
    // customers (see OperationsNotifier.gs). QR is deferred to staff's
    // /thanhtoan reply there, same as the Telegram flow.
    function confirmedOrderSummary(outbound, inbound) {
      if (!inbound || !inbound.payload || inbound.payload.action !== 'confirm_order') return null;
      var confirmation = outbound.find(function (message) {
        return message.type === 'text' && message.content && message.content.orderId != null;
      });
      if (!confirmation) return null;
      return {
        orderId: String(confirmation.content.orderId),
        amount: Number(confirmation.content.amount || 0),
        items: Array.isArray(confirmation.content.items) ? confirmation.content.items : [],
        customerName: confirmation.content.customerName || ''
      };
    }

    function doPost(event) {
      var rawBody = event && event.postData && event.postData.contents;
      var parsed = null;
      var inbound = null;
      var messageId = null;
      var claimed = false;
      var transaction = null;
      try {
        if (typeof rawBody !== 'string') throw new TypeError('Webhook event is missing JSON postData.contents');
        var signature = signatureFrom(event);
        if (!dependencies.verifySignature(signature, rawBody)) {
          logError(new Error('Invalid or missing Zalo webhook signature'), {
            stage: 'signature_verification',
            signaturePresent: Boolean(signature)
          });
          return successResponse();
        }
        parsed = JSON.parse(rawBody);
        inbound = dependencies.mapInboundMessage(parsed);
        if (!inbound) return successResponse();
        if (!parsed.message || parsed.message.msg_id == null) {
          throw new TypeError('Zalo user message event is missing message.msg_id');
        }
        messageId = String(parsed.message.msg_id);
        transaction = dependencies.withLock(function () {
          if (dependencies.processedUpdateRepository.has(messageId)) return { duplicate: true, commands: [] };
          dependencies.processedUpdateRepository.markProcessed(messageId, dependencies.now().toISOString());
          claimed = true;
          var outbound = dependencies.orderService.handleMessage(inbound);
          return {
            commands: outbound.map(function (message) {
              return dependencies.renderOutboundMessage(message, inbound.platformUserId);
            }),
            confirmedOrderSummary: confirmedOrderSummary(outbound, inbound),
            recovery: outbound.reduce(function (result, message) {
              if (message.type === 'image' && message.content && message.content.purpose === 'payment_qr') {
                result.orderId = message.content.orderId || null;
                result.qrUrl = message.content.data || null;
              }
              return result;
            }, { platformUserId: inbound.platformUserId })
          };
        });
        if (!transaction.duplicate && transaction.confirmedOrderSummary) {
          OperationsNotifier.notifyStaffOfNewOrder({
            orderId: transaction.confirmedOrderSummary.orderId,
            totalAmount: transaction.confirmedOrderSummary.amount,
            items: transaction.confirmedOrderSummary.items,
            customerName: transaction.confirmedOrderSummary.customerName
          }, 'zalo', dependencies.errorLogRepository);
        }
        if (transaction.duplicate) return successResponse();
        for (var index = 0; index < transaction.commands.length; index += 1) {
          try {
            dependencies.client.execute(transaction.commands[index]);
          } catch (deliveryError) {
            setStatus(messageId, 'failed');
            var fallback = sendFallback(inbound.platformUserId);
            logError(deliveryError, Object.assign({}, transaction.recovery, {
              stage: 'delivery',
              messageId: messageId,
              failedMethod: transaction.commands[index].method,
              fallbackDelivered: fallback.delivered,
              fallbackError: fallback.error
            }));
            return successResponse();
          }
        }
        setStatus(messageId, 'delivered');
      } catch (error) {
        var userId = inbound && inbound.platformUserId;
        if (error && error.customerMessage) {
          var guidance = sendUserMessage(userId, error.customerMessage);
          if (claimed && messageId) setStatus(messageId, guidance.delivered ? 'delivered' : 'failed');
          logError(error, {
            stage: 'user_action',
            messageId: messageId,
            platformUserId: userId || null,
            action: error.action || null,
            currentState: error.currentState || null,
            customerMessageDelivered: guidance.delivered,
            deliveryError: guidance.error
          });
        } else {
          if (claimed && messageId) setStatus(messageId, 'failed');
          var fallback = sendFallback(userId);
          logError(error, {
            stage: 'processing',
            messageId: messageId,
            platformUserId: userId || null,
            fallbackDelivered: fallback.delivered,
            fallbackError: fallback.error
          });
        }
      }
      return successResponse();
    }

    return Object.freeze({ doPost: doPost });
  }
  return Object.freeze({ create: create });
})();

var zaloWebhookInstance = null;

function zaloSha256Hex(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
    .map(function (byte) { return ('0' + ((byte + 256) % 256).toString(16)).slice(-2); })
    .join('');
}

function createDefaultZaloWebhook() {
  var tokenManager = ZaloTokenManager.createDefault();
  var orderService = OrderService.create({
    orderRepository: BotOrderRepository(),
    customerRepository: SheetCustomerRepository(),
    conversationStateRepository: SheetConversationStateRepository(),
    getCatalog: ZaloRuntime.loadCatalog,
    createQrContent: ZaloRuntime.createPaymentQrUrl,
    createId: ZaloRuntime.createId,
    now: function () { return new Date(); },
    withLock: SheetRepositorySupport.withScriptLock
  });
  return ZaloWebhook.create({
    mapInboundMessage: ZaloInboundMapper.mapInboundMessage,
    renderOutboundMessage: ZaloOutboundRenderer.renderOutboundMessage,
    verifySignature: function (signature, rawBody) {
      return ZaloWebhookSignature.verifyWebhookSignature(
        signature, rawBody, ZaloRuntime.requiredProperty('ZALO_OA_SECRET_KEY'), zaloSha256Hex
      );
    },
    withLock: SheetRepositorySupport.withScriptLock,
    now: function () { return new Date(); },
    orderService: orderService,
    processedUpdateRepository: SheetZaloProcessedUpdateRepository(),
    errorLogRepository: SheetErrorLogRepository(),
    client: ZaloClient.create(tokenManager),
    fallbackMessage: ZaloRuntime.fallbackMessage
  });
}

function doZaloPost(e) {
  try {
    if (!zaloWebhookInstance) zaloWebhookInstance = createDefaultZaloWebhook();
    return zaloWebhookInstance.doPost(e);
  } catch (error) {
    try {
      SheetErrorLogRepository().log({
        timestamp: new Date().toISOString(),
        context: { stage: 'zalo_webhook_initialization' },
        message: error && error.message ? error.message : String(error),
        stack: error && error.stack ? error.stack : ''
      });
    } catch (ignore) {}
    return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ZaloWebhook: ZaloWebhook, createDefaultZaloWebhook: createDefaultZaloWebhook };
}
