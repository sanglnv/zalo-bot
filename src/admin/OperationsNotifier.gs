'use strict';

/**
 * Notifies staff in the Telegram ops chat whenever a customer confirms an
 * order, regardless of whether that customer came in through Telegram or
 * Zalo -- there is only one staff channel today (TELEGRAM_OPERATIONS_CHAT_ID),
 * so both webhook adapters call into this same file.
 *
 * This is the GAS-side counterpart to the Telegram Fast Path's
 * `operationsOrderText`/`/thanhtoan` flow (see telegram-gateway/src/index.ts).
 * QR is intentionally NOT sent to the customer at order-confirm time anymore
 * (see core/orderService.js's confirm_order handler); staff sends it manually
 * once the order is ready by replying `/thanhtoan <orderId>` in this chat,
 * which `PaymentQrDispatch.gs` handles.
 */
function operationsChatId() {
  return PropertiesService.getScriptProperties().getProperty('TELEGRAM_OPERATIONS_CHAT_ID');
}

function formatVndForOps(amount) {
  return String(Math.round(Number(amount) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' đ';
}

function operationsOrderText(order, sourcePlatform) {
  var lines = (order.items || []).map(function (item) {
    return '• ' + item.name + ' × ' + item.quantity + ' — ' + formatVndForOps(item.unitPrice * item.quantity);
  });
  return [
    '🔔 ĐƠN MỚI #' + order.orderId,
    'Kênh: ' + sourcePlatform,
    order.customerName ? 'Khách: ' + order.customerName : null,
    '',
    lines.join('\n'),
    '',
    'Tổng: ' + formatVndForOps(order.totalAmount),
    'Trạng thái: Đang chuẩn bị',
    '',
    'Khi món sẵn sàng, gõ: /thanhtoan ' + order.orderId
  ].filter(function (line) { return line !== null; }).join('\n');
}

function operationsBookingText(booking, sourcePlatform) {
  var timing = booking.unit === 'hourly'
    ? 'Khung giờ: ' + booking.startAt + ' — ' + booking.durationHours + 'h'
    : 'Nhận phòng: ' + booking.startAt + ' — ' + booking.nights + ' đêm';
  return [
    '🔔 ĐẶT PHÒNG MỚI #' + booking.bookingId,
    'Kênh: ' + sourcePlatform,
    booking.customerName ? 'Khách: ' + booking.customerName : null,
    '',
    'Phòng: ' + booking.roomName + (booking.roomType ? ' (' + booking.roomType + ')' : ''),
    timing,
    'Tổng: ' + formatVndForOps(booking.totalAmount),
    'Trạng thái: Chờ thanh toán',
    '',
    'Khi xác nhận, gõ: /thanhtoan ' + booking.bookingId
  ].filter(function (line) { return line !== null; }).join('\n');
}

// Best-effort: a missing TELEGRAM_OPERATIONS_CHAT_ID or a failed Telegram
// send must never fail the customer-facing order confirmation. Errors are
// logged, not thrown.
function notifyStaffOfNewOrder(order, sourcePlatform, errorLogRepository) {
  var chatId = operationsChatId();
  if (!chatId) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(JSON.stringify({
        event: 'operations_notify_skipped', reason: 'not_configured', orderId: order.orderId
      }));
    }
    return false;
  }
  try {
    TelegramClient.create().execute({
      method: 'sendMessage',
      params: { chat_id: chatId, text: operationsOrderText(order, sourcePlatform) }
    });
    return true;
  } catch (error) {
    try {
      (errorLogRepository || SheetErrorLogRepository()).log({
        timestamp: new Date().toISOString(),
        context: { stage: 'operations_notify', orderId: order.orderId, sourcePlatform: sourcePlatform },
        message: error && error.message ? error.message : String(error),
        stack: error && error.stack ? error.stack : ''
      });
    } catch (ignore) {}
    return false;
  }
}

function notifyStaffOfNewBooking(booking, sourcePlatform, errorLogRepository) {
  var chatId = operationsChatId();
  if (!chatId) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(JSON.stringify({ event: 'operations_notify_skipped', reason: 'not_configured', bookingId: booking.bookingId }));
    }
    return false;
  }
  try {
    TelegramClient.create().execute({
      method: 'sendMessage', params: { chat_id: chatId, text: operationsBookingText(booking, sourcePlatform) }
    });
    return true;
  } catch (error) {
    try {
      (errorLogRepository || SheetErrorLogRepository()).log({
        timestamp: new Date().toISOString(),
        context: { stage: 'operations_booking_notify', bookingId: booking.bookingId, sourcePlatform: sourcePlatform },
        message: error && error.message ? error.message : String(error),
        stack: error && error.stack ? error.stack : ''
      });
    } catch (ignore) {}
    return false;
  }
}

function isAuthorizedOpsAdmin(userId) {
  var raw = PropertiesService.getScriptProperties().getProperty('TELEGRAM_ADMIN_USER_IDS');
  if (!raw) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(JSON.stringify({ event: 'ops_admin_allowlist_not_configured' }));
    }
    return false;
  }
  return raw.split(',').map(function (id) { return id.trim(); }).filter(Boolean)
    .indexOf(String(userId)) !== -1;
}

var OperationsNotifier = Object.freeze({
  operationsChatId: operationsChatId,
  operationsOrderText: operationsOrderText,
  operationsBookingText: operationsBookingText,
  notifyStaffOfNewOrder: notifyStaffOfNewOrder,
  notifyStaffOfNewBooking: notifyStaffOfNewBooking,
  isAuthorizedOpsAdmin: isAuthorizedOpsAdmin
});

if (typeof module !== 'undefined' && module.exports) module.exports = OperationsNotifier;
