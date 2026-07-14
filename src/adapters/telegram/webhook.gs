'use strict';

var TelegramWebhook = (function () {
  function successResponse() {
    return HtmlService.createHtmlOutput('OK');
  }

  function requireUpdateId(update) {
    if (update.update_id == null ||
        (typeof update.update_id !== 'number' && typeof update.update_id !== 'string')) {
      throw new TypeError('Telegram update is missing update_id');
    }
    return String(update.update_id);
  }

  function create(dependencies) {
    dependencies = dependencies || {};
    ['mapInboundMessage', 'renderOutboundMessage', 'withLock', 'now'].forEach(function (name) {
      if (typeof dependencies[name] !== 'function') throw new TypeError(name + ' must be a function');
    });
    if (!dependencies.orderService || typeof dependencies.orderService.handleMessage !== 'function') {
      throw new TypeError('orderService.handleMessage is required');
    }
    if (!dependencies.processedUpdateRepository ||
        typeof dependencies.processedUpdateRepository.has !== 'function' ||
        typeof dependencies.processedUpdateRepository.markProcessed !== 'function' ||
        typeof dependencies.processedUpdateRepository.updateDeliveryStatus !== 'function') {
      throw new TypeError(
        'processedUpdateRepository must implement has(), markProcessed(), and updateDeliveryStatus()'
      );
    }
    if (!dependencies.errorLogRepository || typeof dependencies.errorLogRepository.log !== 'function') {
      throw new TypeError('errorLogRepository.log is required');
    }
    if (!dependencies.client || typeof dependencies.client.execute !== 'function') {
      throw new TypeError('client.execute is required');
    }
    if (typeof dependencies.fallbackMessage !== 'function') {
      throw new TypeError('fallbackMessage must be a function');
    }

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

    function rawChatId(update) {
      var chat = update && update.callback_query && update.callback_query.message
        ? update.callback_query.message.chat
        : update && update.message ? update.message.chat : null;
      return chat && chat.id != null ? String(chat.id) : null;
    }

    function answerCallback(update, updateId) {
      if (update && update._gateway_callback_answered === true) return;
      if (!update || !update.callback_query || !update.callback_query.id) return;
      try {
        dependencies.client.execute({
          method: 'answerCallbackQuery',
          params: { callback_query_id: String(update.callback_query.id) }
        });
      } catch (error) {
        logError(error, { updateId: updateId, stage: 'answer_callback' });
      }
    }

    function updateDeliveryStatus(updateId, status) {
      try {
        dependencies.processedUpdateRepository.updateDeliveryStatus(updateId, status);
      } catch (error) {
        logError(error, { updateId: updateId, stage: 'delivery_status', requestedStatus: status });
      }
    }

    function recoveryFrom(outbound, chatId) {
      var paymentImage = outbound.find(function (message) {
        return message.type === 'image' && message.content && message.content.purpose === 'payment_qr';
      });
      return paymentImage ? {
        orderId: paymentImage.content.orderId || null,
        chatId: chatId,
        qrUrl: paymentImage.content.data || null
      } : { chatId: chatId };
    }

    function handleProcessingFailure(error, details) {
      if (details.claimed && details.updateId != null) {
        updateDeliveryStatus(details.updateId, 'failed');
      }
      var fallbackDelivered = false;
      var fallbackError = null;
      if (details.chatId) {
        try {
          dependencies.client.execute({
            method: 'sendMessage',
            params: { chat_id: details.chatId, text: dependencies.fallbackMessage() }
          });
          fallbackDelivered = true;
        } catch (sendError) {
          fallbackError = sendError && sendError.message ? sendError.message : String(sendError);
        }
      }
      var context = Object.assign({}, details.recovery || {}, {
        updateId: details.updateId,
        chatId: details.chatId,
        stage: details.stage || 'processing',
        failedMethod: details.failedCommand ? details.failedCommand.method : null,
        fallbackDelivered: fallbackDelivered,
        fallbackError: fallbackError
      });
      logError(error, context);
    }

    function handleUserActionFailure(error, details) {
      var delivered = false;
      var deliveryError = null;
      if (details.chatId) {
        try {
          dependencies.client.execute({
            method: 'sendMessage',
            params: { chat_id: details.chatId, text: error.customerMessage }
          });
          delivered = true;
        } catch (sendError) {
          deliveryError = sendError && sendError.message ? sendError.message : String(sendError);
        }
      }
      if (details.claimed && details.updateId != null) {
        updateDeliveryStatus(details.updateId, delivered ? 'delivered' : 'failed');
      }
      logError(error, {
        updateId: details.updateId,
        chatId: details.chatId,
        stage: 'user_action',
        action: error.action || null,
        currentState: error.currentState || null,
        customerMessageDelivered: delivered,
        deliveryError: deliveryError
      });
    }

    function clearCompletedCallbackKeyboard(update, updateId) {
      var callback = update && update.callback_query;
      var message = callback && callback.message;
      var action = null;
      try {
        action = callback ? dependencies.mapInboundMessage(update).payload.action : null;
      } catch (ignore) {}
      if (!message || message.message_id == null || (action !== 'confirm_order' && action !== 'cancel')) return;
      try {
        dependencies.client.execute({
          method: 'editMessageReplyMarkup',
          params: {
            chat_id: String(message.chat.id),
            message_id: message.message_id,
            reply_markup: { inline_keyboard: [] }
          }
        });
      } catch (error) {
        logError(error, { updateId: updateId, stage: 'clear_callback_keyboard', action: action });
      }
    }

    function doPost(event) {
      var update = null;
      var updateId = null;
      var chatId = null;
      var claimed = false;
      var transaction = null;
      try {
        if (!event || !event.postData || typeof event.postData.contents !== 'string') {
          throw new TypeError('Webhook event is missing JSON postData.contents');
        }
        update = JSON.parse(event.postData.contents);
        updateId = requireUpdateId(update);
        chatId = rawChatId(update);
        answerCallback(update, updateId);
        transaction = dependencies.withLock(function () {
          if (dependencies.processedUpdateRepository.has(updateId)) {
            return { duplicate: true, commands: [] };
          }
          dependencies.processedUpdateRepository.markProcessed(updateId, dependencies.now().toISOString());
          claimed = true;
          var inbound = dependencies.mapInboundMessage(update);
          if (!inbound) return { ignored: true, commands: [] };
          var outbound = dependencies.orderService.handleMessage(inbound);
          return {
            recovery: recoveryFrom(outbound, inbound.platformUserId),
            commands: outbound.map(function (message) {
              return dependencies.renderOutboundMessage(message, inbound.platformUserId);
            })
          };
        });

        if (transaction.duplicate) {
          return successResponse();
        }
        for (var index = 0; index < transaction.commands.length; index += 1) {
          var command = transaction.commands[index];
          try {
            dependencies.client.execute(command);
          } catch (error) {
            handleProcessingFailure(error, {
              claimed: claimed,
              updateId: updateId,
              chatId: chatId,
              stage: 'delivery',
              failedCommand: command,
              recovery: transaction.recovery
            });
            return successResponse();
          }
        }
        updateDeliveryStatus(updateId, 'delivered');
        clearCompletedCallbackKeyboard(update, updateId);
      } catch (error) {
        if (error && error.customerMessage) {
          handleUserActionFailure(error, {
            claimed: claimed,
            updateId: updateId,
            chatId: chatId
          });
        } else {
          handleProcessingFailure(error, {
            claimed: claimed,
            updateId: updateId,
            chatId: chatId,
            stage: 'processing',
            recovery: transaction && transaction.recovery
          });
        }
      }
      return successResponse();
    }

    return Object.freeze({ doPost: doPost });
  }

  return Object.freeze({ create: create });
})();

var telegramWebhookInstance = null;

function createDefaultTelegramWebhook() {
  var orderService = OrderService.create({
    orderRepository: SheetOrderRepository(),
    customerRepository: SheetCustomerRepository(),
    conversationStateRepository: SheetConversationStateRepository(),
    getCatalog: TelegramRuntime.loadCatalog,
    createQrContent: TelegramRuntime.createPaymentQrUrl,
    createId: TelegramRuntime.createId,
    now: function () { return new Date(); },
    withLock: SheetRepositorySupport.withScriptLock
  });
  return TelegramWebhook.create({
    mapInboundMessage: TelegramInboundMapper.mapInboundMessage,
    renderOutboundMessage: TelegramOutboundRenderer.renderOutboundMessage,
    withLock: SheetRepositorySupport.withScriptLock,
    now: function () { return new Date(); },
    orderService: orderService,
    processedUpdateRepository: SheetProcessedUpdateRepository(),
    errorLogRepository: SheetErrorLogRepository(),
    client: TelegramClient.create(),
    fallbackMessage: TelegramRuntime.fallbackMessage
  });
}

function doTelegramPostWithoutMetrics(e) {
  try {
    if (!telegramWebhookInstance) telegramWebhookInstance = createDefaultTelegramWebhook();
    return telegramWebhookInstance.doPost(e);
  } catch (error) {
    try {
      SheetErrorLogRepository().log({
        timestamp: new Date().toISOString(),
        context: { stage: 'webhook_initialization' },
        message: error && error.message ? error.message : String(error),
        stack: error && error.stack ? error.stack : ''
      });
    } catch (loggingError) {
      if (typeof console !== 'undefined' && console.error) console.error(loggingError);
    }
    return HtmlService.createHtmlOutput('OK');
  }
}

function registerWebhook(dropPendingUpdates) {
  var properties = PropertiesService.getScriptProperties();
  var gatewayUrl = properties.getProperty('TELEGRAM_WEBHOOK_URL');
  var webhookSecret = properties.getProperty('TELEGRAM_WEBHOOK_SECRET');
  if (!gatewayUrl) throw new Error('Missing required script property: TELEGRAM_WEBHOOK_URL');
  if (!webhookSecret) throw new Error('Missing required script property: TELEGRAM_WEBHOOK_SECRET');
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET must use 1-256 characters from A-Z, a-z, 0-9, _ and -');
  }
  var params = {
    url: gatewayUrl,
    allowed_updates: ['message', 'callback_query'],
    max_connections: 1,
    drop_pending_updates: dropPendingUpdates === true
  };
  params.secret_token = webhookSecret;
  return TelegramClient.create().execute({
    method: 'setWebhook',
    params: params
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TelegramWebhook: TelegramWebhook,
    createDefaultTelegramWebhook: createDefaultTelegramWebhook,
    doPost: doTelegramPostWithoutMetrics,
    registerWebhook: registerWebhook
  };
}
