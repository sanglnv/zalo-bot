'use strict';

var TelegramWebhook = (function () {
  function successResponse() {
    return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
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
    if (!dependencies.bookingService || typeof dependencies.bookingService.handleMessage !== 'function') {
      throw new TypeError('bookingService.handleMessage is required');
    }
    if (!dependencies.customerRepository ||
        typeof dependencies.customerRepository.findByPlatformUserId !== 'function') {
      throw new TypeError('customerRepository.findByPlatformUserId is required');
    }
    if (!dependencies.conversationStateRepository ||
        typeof dependencies.conversationStateRepository.get !== 'function') {
      throw new TypeError('conversationStateRepository.get is required');
    }
    if (typeof dependencies.routeToService !== 'function') {
      throw new TypeError('routeToService must be a function');
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
    var telemetry = typeof dependencies.telemetry === 'function'
      ? dependencies.telemetry
      : function () {};

    function emitTelemetry(event, updateId, startedAtMs, details) {
      var nowMs = Date.now();
      try {
        telemetry(event, Object.assign({
          updateId: updateId,
          timestampMs: nowMs,
          durationMs: startedAtMs == null ? null : Math.max(0, nowMs - startedAtMs)
        }, details || {}));
      } catch (ignore) {}
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

    // QR is no longer attached to confirm_order's outbound (see
    // core/orderService.js) -- only a text confirmation carrying `items` is
    // emitted, which is enough to build the ops-chat notification.
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
    function confirmedBookingSummary(outbound, inbound) {
      if (!inbound || !inbound.payload || inbound.payload.action !== 'confirm_booking') return null;
      var confirmation = outbound.find(function (message) {
        return message.type === 'text' && message.content && message.content.bookingId != null;
      });
      if (!confirmation) return null;
      return Object.assign({}, confirmation.content, {
        bookingId: String(confirmation.content.bookingId), amount: Number(confirmation.content.amount || 0)
      });
    }

    // Staff message in the ops chat, e.g. "/thanhtoan HD123". Handled
    // entirely outside orderService.handleMessage -- it's not a customer
    // order action, and staff aren't Clawbot "customers". Returns true when
    // the update was an ops command (handled, whether successfully or not)
    // so the caller skips the normal customer pipeline for it.
    function handleOpsThanhToanCommand(update, updateId) {
      var message = update && update.message;
      if (!message || typeof message.text !== 'string' || !message.chat) return false;
      var opsChatId = null;
      try { opsChatId = OperationsNotifier.operationsChatId(); } catch (ignore) {}
      if (!opsChatId || String(message.chat.id) !== String(opsChatId)) return false;
      var parsed = PaymentQrDispatch.parseThanhToanCommand(message.text);
      if (parsed === false) return false;

      function reply(text) {
        try {
          dependencies.client.execute({ method: 'sendMessage', params: { chat_id: opsChatId, text: text } });
        } catch (error) {
          logError(error, { updateId: updateId, stage: 'ops_command_reply' });
        }
      }

      var alreadyClaimed = dependencies.withLock(function () {
        if (dependencies.processedUpdateRepository.has(updateId)) return true;
        dependencies.processedUpdateRepository.markProcessed(updateId, dependencies.now().toISOString());
        return false;
      });
      if (alreadyClaimed) return true;

      var senderId = message.from && message.from.id;
      if (!OperationsNotifier.isAuthorizedOpsAdmin(senderId)) {
        reply('Bạn không có quyền thực hiện lệnh này.');
        updateDeliveryStatus(updateId, 'delivered');
        return true;
      }
      if (parsed === null) {
        reply('Cú pháp: /thanhtoan <mã đơn>');
        updateDeliveryStatus(updateId, 'delivered');
        return true;
      }

      // The POS assigns distinct id prefixes per contract (orders "HD...",
      // bookings "BOOKING_..."), so the id itself says which store to hit --
      // no more try-order-then-booking fallback (Phase 1-4's Sheet-backed
      // ids came from the same createId() source and were not
      // distinguishable this way).
      var isBookingId = /^BOOKING_/.test(parsed);
      var result;
      var kind = isBookingId ? 'đặt phòng' : 'đơn';
      try {
        result = isBookingId ? BookingQrDispatch.dispatchBookingQr(parsed) : PaymentQrDispatch.dispatchPaymentQr(parsed);
      } catch (error) {
        logError(error, { updateId: updateId, stage: 'ops_command_dispatch', orderId: parsed });
        reply('Có lỗi xảy ra khi gửi QR cho đơn ' + parsed + '.');
        updateDeliveryStatus(updateId, 'failed');
        return true;
      }
      if (result.ok) {
        reply('Đã gửi QR thanh toán cho ' + kind + ' ' + parsed + '.');
      } else if (result.reason === 'not_found') {
        reply('Không tìm thấy đơn hoặc đặt phòng ' + parsed + '.');
      } else if (result.reason === 'already_resolved') {
        reply(kind + ' ' + parsed + ' không còn chờ thanh toán (trạng thái: ' + (result.status || '?') + ').');
      } else {
        reply('Gửi QR cho đơn ' + parsed + ' thất bại: ' + (result.message || 'không xác định'));
      }
      updateDeliveryStatus(updateId, result.ok ? 'delivered' : 'failed');
      return true;
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
      if (!message || message.message_id == null ||
          (action !== 'confirm_order' && action !== 'cancel' &&
           action !== 'confirm_booking' && action !== 'cancel_booking')) return;
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
      var gasReceivedAtMs = Date.now();
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
        emitTelemetry('gas_received', updateId, null, {
          gasReceivedAtMs: gasReceivedAtMs,
          edgeToGasMs: update._gateway_trace && update._gateway_trace.receivedAtMs
            ? Math.max(0, gasReceivedAtMs - update._gateway_trace.receivedAtMs)
            : null
        });
        chatId = rawChatId(update);
        if (handleOpsThanhToanCommand(update, updateId)) return successResponse();
        answerCallback(update, updateId);
        var transactionStartedAtMs = Date.now();
        transaction = dependencies.withLock(function () {
          if (dependencies.processedUpdateRepository.has(updateId)) {
            return { duplicate: true, commands: [] };
          }
          dependencies.processedUpdateRepository.markProcessed(updateId, dependencies.now().toISOString());
          claimed = true;
          var inbound = dependencies.mapInboundMessage(update);
          if (!inbound) return { ignored: true, commands: [] };
          inbound.traceId = updateId;
          var domainStartedAtMs = Date.now();
          emitTelemetry('domain_started', updateId, null, { timestampMs: domainStartedAtMs });
          var selectedService = dependencies.routeToService({
            orderService: dependencies.orderService,
            bookingService: dependencies.bookingService,
            customerRepository: dependencies.customerRepository,
            conversationStateRepository: dependencies.conversationStateRepository
          }, inbound);
          var outbound = selectedService.handleMessage(inbound);
          emitTelemetry('domain_completed', updateId, domainStartedAtMs, {
            outboundCount: outbound.length
          });
          return {
            recovery: recoveryFrom(outbound, inbound.platformUserId),
            confirmedOrderSummary: confirmedOrderSummary(outbound, inbound),
            confirmedBookingSummary: confirmedBookingSummary(outbound, inbound),
            commands: outbound.map(function (message) {
              return dependencies.renderOutboundMessage(message, inbound.platformUserId);
            })
          };
        });
        emitTelemetry('transaction_completed', updateId, transactionStartedAtMs, {
          duplicate: transaction.duplicate === true,
          commandCount: transaction.commands.length
        });

        if (!transaction.duplicate && transaction.confirmedOrderSummary) {
          OperationsNotifier.notifyStaffOfNewOrder({
            orderId: transaction.confirmedOrderSummary.orderId,
            totalAmount: transaction.confirmedOrderSummary.amount,
            items: transaction.confirmedOrderSummary.items,
            customerName: transaction.confirmedOrderSummary.customerName
          }, 'telegram', dependencies.errorLogRepository);
        }
        if (!transaction.duplicate && transaction.confirmedBookingSummary) {
          OperationsNotifier.notifyStaffOfNewBooking({
            bookingId: transaction.confirmedBookingSummary.bookingId,
            totalAmount: transaction.confirmedBookingSummary.amount,
            customerName: transaction.confirmedBookingSummary.customerName || '',
            roomName: transaction.confirmedBookingSummary.roomName || '',
            roomType: transaction.confirmedBookingSummary.roomType || '',
            unit: transaction.confirmedBookingSummary.unit,
            startAt: transaction.confirmedBookingSummary.startAt,
            durationHours: transaction.confirmedBookingSummary.durationHours,
            nights: transaction.confirmedBookingSummary.nights
          }, 'telegram', dependencies.errorLogRepository);
        }

        if (transaction.duplicate) {
          return successResponse();
        }
        for (var index = 0; index < transaction.commands.length; index += 1) {
          var command = transaction.commands[index];
          try {
            var deliveryStartedAtMs = Date.now();
            emitTelemetry('telegram_send_started', updateId, null, {
              commandIndex: index,
              method: command.method
            });
            dependencies.client.execute(command);
            emitTelemetry('telegram_send_completed', updateId, deliveryStartedAtMs, {
              commandIndex: index,
              method: command.method
            });
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
        emitTelemetry('telegram_request_completed', updateId, gasReceivedAtMs, {
          commandCount: transaction.commands.length
        });
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
  function structuredTelemetry(event, details) {
    if (typeof console !== 'undefined' && console.log) {
      console.log(JSON.stringify(Object.assign({
        event: event,
        platform: 'telegram',
        timestampMs: Date.now()
      }, details || {})));
    }
  }
  var customerRepository = SheetCustomerRepository();
  var conversationStateRepository = SheetConversationStateRepository();
  var memberRepository = MemberRepository();
  var orderService = OrderService.create({
    orderRepository: BotOrderRepository(),
    customerRepository: customerRepository,
    conversationStateRepository: conversationStateRepository,
    memberRepository: memberRepository,
    getCatalog: TelegramRuntime.loadCatalog,
    createQrContent: TelegramRuntime.createPaymentQrUrl,
    createId: TelegramRuntime.createId,
    now: function () { return new Date(); },
    withLock: SheetRepositorySupport.withScriptLock,
    telemetry: structuredTelemetry
  });
  var bookingService = BookingService.create({
    bookingRepository: PosBookingRepository(customerRepository),
    roomRepository: PosRoomRepository(),
    customerRepository: customerRepository,
    conversationStateRepository: conversationStateRepository,
    memberRepository: memberRepository,
    createQrContent: function (booking) {
      return TelegramRuntime.createPaymentQrUrl(Object.assign({}, booking, { orderId: booking.bookingId }));
    },
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
    bookingService: bookingService,
    customerRepository: customerRepository,
    conversationStateRepository: conversationStateRepository,
    routeToService: ServiceRouter.routeToService,
    processedUpdateRepository: SheetProcessedUpdateRepository(),
    errorLogRepository: SheetErrorLogRepository(),
    client: TelegramClient.create(),
    fallbackMessage: TelegramRuntime.fallbackMessage,
    telemetry: structuredTelemetry
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
    return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
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
  var client = TelegramClient.create();
  var webhookResult = client.execute({
    method: 'setWebhook',
    params: params
  });
  var vietnameseCommands = [
    { command: 'batdau', description: 'Bắt đầu đặt món' },
    { command: 'danhmuc', description: 'Xem danh mục món đang bán' },
    { command: 'phong', description: 'Đặt phòng sleepbox' },
    { command: 'giohang', description: 'Xem giỏ hàng hiện tại' },
    { command: 'dathang', description: 'Kiểm tra và xác nhận giỏ hàng' },
    { command: 'xemdon', description: 'Xem trạng thái đơn gần nhất' },
    { command: 'huydon', description: 'Hủy giỏ hoặc đơn hiện tại' },
    { command: 'thanhtoan', description: 'Nhận mã QR thanh toán' },
    { command: 'trogiup', description: 'Xem hướng dẫn sử dụng bot' }
  ];
  client.execute({
    method: 'setMyCommands',
    params: { commands: vietnameseCommands }
  });
  client.execute({
    method: 'setMyCommands',
    params: {
      commands: vietnameseCommands,
      language_code: 'vi'
    }
  });
  return webhookResult;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TelegramWebhook: TelegramWebhook,
    createDefaultTelegramWebhook: createDefaultTelegramWebhook,
    doPost: doTelegramPostWithoutMetrics,
    registerWebhook: registerWebhook
  };
}
