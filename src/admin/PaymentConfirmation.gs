'use strict';

function buildPaymentConfirmationOrderService() {
  return OrderService.create({
    orderRepository: BotOrderRepository(),
    customerRepository: SheetCustomerRepository(),
    conversationStateRepository: SheetConversationStateRepository(),
    getCatalog: TelegramRuntime.loadCatalog,
    createQrContent: TelegramRuntime.createPaymentQrUrl,
    createId: TelegramRuntime.createId,
    now: function () { return new Date(); },
    withLock: SheetRepositorySupport.withScriptLock
  });
}

function processOrderPayment(orderId, confirmedBy) {
  var fastPath = typeof FastPathPaymentClient !== 'undefined'
    ? FastPathPaymentClient.resolve(orderId, 'confirm', confirmedBy)
    : { handled: false };
  if (fastPath.outcome === 'infra_error') {
    try {
      SheetErrorLogRepository().log({
        timestamp: new Date().toISOString(),
        context: {
          stage: 'fast_path_gateway',
          orderId: orderId,
          confirmedBy: confirmedBy
        },
        message: fastPath.message || 'Fast-path gateway unavailable',
        stack: ''
      });
    } catch (ignore) {}
    return {
      ok: false,
      reason: 'fast_path_gateway_unavailable',
      message: fastPath.message || 'Fast-path gateway unavailable'
    };
  }
  if (fastPath.handled) {
    if (fastPath.outcome === 'resolved' && fastPath.deliveryStatus === 'pending') {
      try {
        SheetErrorLogRepository().log({
          timestamp: new Date().toISOString(),
          context: {
            stage: 'notification_dispatch',
            orderId: orderId,
            confirmedBy: confirmedBy,
            platformLinks: fastPath.platformLinks || [],
            fastPath: true
          },
          message: fastPath.notificationError || 'Fast-path notification is pending',
          stack: ''
        });
      } catch (ignore) {}
      return {
        ok: false,
        reason: 'confirmed_but_notification_failed',
        orderId: orderId,
        platformLinks: fastPath.platformLinks || [],
        message: fastPath.notificationError || 'Thông báo đang chờ gửi lại',
        fastPath: true
      };
    }
    return fastPath.outcome === 'resolved'
      ? { ok: true, fastPath: true }
      : { ok: false, reason: 'already_resolved', fastPath: true };
  }
  return PaymentConfirmationHandler.create({
    orderService: buildPaymentConfirmationOrderService(),
    dispatchNotifications: NotificationDispatcher.dispatchNotifications,
    registry: buildNotificationRegistry(),
    errorLogRepository: SheetErrorLogRepository(),
    now: function () { return new Date(); }
  }).process(orderId, confirmedBy);
}

function registerSheetMenuTrigger() {
  var spreadsheetId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!spreadsheetId) throw new Error('Missing required script property: SPREADSHEET_ID');
  var existing = ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getHandlerFunction() === 'onOpenBuildMenu' &&
      trigger.getTriggerSourceId() === spreadsheetId;
  });
  if (existing) return { created: false, spreadsheetId: spreadsheetId };
  ScriptApp.newTrigger('onOpenBuildMenu').forSpreadsheet(spreadsheetId).onOpen().create();
  return { created: true, spreadsheetId: spreadsheetId };
}

function onOpenBuildMenu() {
  SpreadsheetApp.getUi()
    .createMenu('Zalo Clawbot')
    .addItem('Xem đơn chờ thanh toán', 'listPendingOrdersForStaff')
    .addItem('Xác nhận thanh toán theo mã đơn', 'confirmSelectedOrderPayment')
    .addToUi();
}

// Orders no longer live in a local Sheet -- they are created/read through
// the POS Bot Order Webhook (BotOrderRepository). There is no Sheet row for
// staff to click on anymore, so this reads live pending orders from the
// webhook and lets staff pick the order id from that list.
function listPendingOrdersForStaff() {
  var ui = SpreadsheetApp.getUi();
  var cutoff = new Date().toISOString();
  var pending;
  try {
    pending = BotOrderRepository().findAwaitingPaymentOlderThan(cutoff, 20);
  } catch (error) {
    ui.alert('Không lấy được danh sách đơn đang chờ: ' + (error && error.message ? error.message : String(error)));
    return;
  }
  if (!pending.length) {
    ui.alert('Hiện không có đơn nào đang chờ thanh toán.');
    return;
  }
  var lines = pending.map(function (order) {
    return order.orderId + ' — ' + order.totalAmount + ' — tạo lúc ' + order.createdAt;
  });
  ui.alert('Đơn đang chờ thanh toán (' + pending.length + ')', lines.join('\n'), ui.ButtonSet.OK);
}

function promptOrderId(ui) {
  var response = ui.prompt(
    'Xác nhận thanh toán',
    'Nhập mã đơn hàng (orderId) cần xác nhận:',
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() !== ui.Button.OK) return null;
  var orderId = String(response.getResponseText() || '').trim();
  return orderId || null;
}

function selectedOrder(ui) {
  var orderId = promptOrderId(ui);
  if (!orderId) return null;
  var order;
  try {
    order = BotOrderRepository().findById(orderId);
  } catch (error) {
    ui.alert('Không đọc được đơn hàng: ' + (error && error.message ? error.message : String(error)));
    return null;
  }
  if (!order) {
    ui.alert('Không tìm thấy đơn hàng ' + orderId + '.');
    return null;
  }
  return { orderId: order.orderId, totalAmount: order.totalAmount };
}

function activeConfirmer(ui) {
  var email = Session.getActiveUser().getEmail();
  if (email) return email;
  var response = ui.prompt(
    'Người xác nhận',
    'Không đọc được email. Hãy nhập tên hoặc email người xác nhận:',
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() !== ui.Button.OK) return null;
  return String(response.getResponseText() || '').trim() || null;
}

function confirmSelectedOrderPaymentWithoutMetrics() {
  var ui = SpreadsheetApp.getUi();
  var selected = selectedOrder(ui);
  if (!selected) return;
  var decision = ui.alert(
    'Xác nhận thanh toán',
    'Xác nhận đã nhận thanh toán cho đơn ' + selected.orderId +
      ' với tổng tiền ' + selected.totalAmount + '? Hành động này không thể hoàn tác.',
    ui.ButtonSet.YES_NO
  );
  if (decision !== ui.Button.YES) return;
  var confirmedBy = activeConfirmer(ui);
  if (!confirmedBy) {
    ui.alert('Chưa có thông tin người xác nhận. Không có thay đổi nào được thực hiện.');
    return;
  }
  var result = processOrderPayment(selected.orderId, confirmedBy);
  if (result.ok) {
    ui.alert('Đã xác nhận và gửi thông báo cho khách.');
  } else if (result.reason === 'confirmed_but_notification_failed') {
    ui.alert(
      'Đã xác nhận thanh toán thành công nhưng gửi thông báo cho khách thất bại — ' +
      'vui lòng tự nhắn tin xác nhận cho khách.'
    );
  } else if (result.reason === 'already_resolved') {
    ui.alert('Đơn này đã được xác nhận hoặc không còn chờ thanh toán.');
  } else if (result.reason === 'fast_path_gateway_unavailable') {
    ui.alert(
      'Không kết nối được hệ thống Fast Path lúc này. Vui lòng thử lại sau ít phút, ' +
      'hoặc báo kỹ thuật nếu lặp lại nhiều lần.'
    );
  } else {
    ui.alert('Có lỗi xảy ra: ' + (result.message || 'Không xác định'));
  }
}

function confirmSelectedOrderPayment() {
  return recordDuration(
    'confirmSelectedOrderPayment',
    function () { return confirmSelectedOrderPaymentWithoutMetrics(); }
  );
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    processOrderPayment: processOrderPayment,
    registerSheetMenuTrigger: registerSheetMenuTrigger,
    onOpenBuildMenu: onOpenBuildMenu,
    listPendingOrdersForStaff: listPendingOrdersForStaff,
    confirmSelectedOrderPayment: confirmSelectedOrderPayment
  };
}
