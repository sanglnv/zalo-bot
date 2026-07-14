'use strict';

function buildPaymentConfirmationOrderService() {
  return OrderService.create({
    orderRepository: SheetOrderRepository(),
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
    .addItem('Xác nhận thanh toán đơn đang chọn', 'confirmSelectedOrderPayment')
    .addToUi();
}

function selectedOrder() {
  var sheet = SpreadsheetApp.getActiveSheet();
  var range = sheet && sheet.getActiveRange();
  if (!sheet || sheet.getName() !== 'Orders' || !range || range.getNumRows() !== 1 || range.getRow() < 2) {
    return null;
  }
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var orderIdColumn = headers.indexOf('orderId') + 1;
  var amountColumn = headers.indexOf('totalAmount') + 1;
  if (!orderIdColumn || !amountColumn) return null;
  var orderId = String(sheet.getRange(range.getRow(), orderIdColumn).getValue() || '').trim();
  if (!orderId) return null;
  return { orderId: orderId, totalAmount: sheet.getRange(range.getRow(), amountColumn).getValue() };
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
  var selected = selectedOrder();
  if (!selected) {
    ui.alert('Hãy chọn đúng một dòng có orderId trên sheet Orders.');
    return;
  }
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
    confirmSelectedOrderPayment: confirmSelectedOrderPayment
  };
}
