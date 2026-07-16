'use strict';

// Token-gated JSON API for operator tools (e.g. an OpenClaw skill) to read
// pending orders and confirm payments without opening the Sheet UI.
// Separate secret from GAS_GATEWAY_TOKEN (Telegram) and Zalo's signature
// verification: a leaked admin token must not grant access to the customer
// messaging channels, and vice versa.

function adminApiToken() {
  return PropertiesService.getScriptProperties().getProperty('ADMIN_API_TOKEN');
}

function validAdminToken(e) {
  var expected = adminApiToken();
  var actual = e && e.parameter ? e.parameter.admin_token : '';
  return secureGatewayTokenEquals(actual, expected);
}

function parseAdminBody(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  try {
    var parsed = JSON.parse(e.postData.contents);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (ignore) {
    return {};
  }
}

function adminRequestParams(e) {
  var params = parseAdminBody(e);
  var query = e && e.parameter ? e.parameter : {};
  if (query.orderId && !params.orderId) params.orderId = query.orderId;
  if (query.confirmedBy && !params.confirmedBy) params.confirmedBy = query.confirmedBy;
  if (query.limit && params.limit == null) params.limit = Number(query.limit);
  return params;
}

function adminJsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function adminOrderSummary(order) {
  if (!order) return null;
  return {
    orderId: order.orderId,
    customerId: order.customerId,
    status: order.status,
    totalAmount: order.totalAmount,
    items: order.items,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    confirmedAt: order.confirmedAt || null,
    confirmedBy: order.confirmedBy || null
  };
}

function adminListPending(rawLimit) {
  var limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 20;
  var orders = SheetOrderRepository().findAwaitingPaymentOlderThan(new Date().toISOString(), limit);
  return { ok: true, orders: orders.map(adminOrderSummary) };
}

function adminGetOrder(orderId) {
  if (typeof orderId !== 'string' || orderId.trim() === '') {
    return { ok: false, error: 'MISSING_ORDER_ID' };
  }
  var order = SheetOrderRepository().findById(orderId);
  if (!order) return { ok: false, error: 'ORDER_NOT_FOUND' };
  var customer = SheetCustomerRepository().findById(order.customerId);
  return {
    ok: true,
    order: adminOrderSummary(order),
    customer: customer
      ? { customerId: customer.customerId, phone: customer.phone, displayName: customer.displayName }
      : null
  };
}

function adminConfirmPayment(orderId, confirmedBy) {
  if (typeof orderId !== 'string' || orderId.trim() === '') {
    return { ok: false, error: 'MISSING_ORDER_ID' };
  }
  if (typeof confirmedBy !== 'string' || confirmedBy.trim() === '') {
    return { ok: false, error: 'MISSING_CONFIRMED_BY' };
  }
  // Reuses the same processOrderPayment as the Sheet menu action (fast-path
  // resolution, notification dispatch, error logging) — one code path for
  // "payment confirmed", not a second copy for the admin API.
  return processOrderPayment(orderId, confirmedBy);
}

function adminGetCatalog() {
  return { ok: true, catalog: TelegramRuntime.loadCatalog() };
}

function adminDispatchAction(action, params) {
  if (action === 'list_pending') return adminListPending(params.limit);
  if (action === 'get_order') return adminGetOrder(params.orderId);
  if (action === 'confirm_payment') return adminConfirmPayment(params.orderId, params.confirmedBy);
  if (action === 'get_catalog') return adminGetCatalog();
  return { ok: false, error: 'UNKNOWN_ACTION' };
}

function logAdminApiError(action, error) {
  try {
    SheetErrorLogRepository().log({
      timestamp: new Date().toISOString(),
      context: { stage: 'admin_api', action: action || null },
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack ? error.stack : ''
    });
  } catch (ignore) {}
}

function doAdminPostWithoutMetrics(e) {
  if (!validAdminToken(e)) return adminJsonResponse({ ok: false, error: 'UNAUTHORIZED' });
  var action = e && e.parameter ? e.parameter.action : '';
  var params = adminRequestParams(e);
  try {
    return adminJsonResponse(adminDispatchAction(action, params));
  } catch (error) {
    logAdminApiError(action, error);
    return adminJsonResponse({
      ok: false,
      error: error && error.code ? error.code : 'INTERNAL_ERROR',
      message: error && error.message ? error.message : String(error)
    });
  }
}

function doAdminPost(e) {
  return recordDuration('doAdminPost', function () { return doAdminPostWithoutMetrics(e); });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    doAdminPost: doAdminPost,
    doAdminPostWithoutMetrics: doAdminPostWithoutMetrics,
    validAdminToken: validAdminToken,
    adminRequestParams: adminRequestParams,
    adminDispatchAction: adminDispatchAction,
    adminOrderSummary: adminOrderSummary
  };
}
