'use strict';

/**
 * Client for the external POS "Bot Order Webhook" (a separate Apps Script
 * web app). One POST endpoint handles menu reads, the full order lifecycle
 * (getMenuCatalog, getOrder, findOrdersByCustomerId, listOpenOrders,
 * createOrder, completeOrder, cancelOrder), and member/loyalty actions
 * (getMemberProfile, listMembers, createMember, updateMember).
 *
 * Auth: `secret` travels in the JSON body (not a header, not a query param —
 * this endpoint's own doc specifies body auth, unlike the GET+query-param
 * design used for the old CATALOG_JSON-replacement draft). Every request
 * carries a fresh `requestId` (UUID-based) since none of Clawbot's call
 * sites ever intentionally resend the same logical operation twice --
 * each action is invoked exactly once behind Clawbot's own script lock /
 * "already resolved" guards, so the webhook's requestId-idempotency feature
 * is not something this client relies on for correctness.
 *
 * ASSUMPTION (unconfirmed against a live response): the webhook's own doc
 * defines `Order`/`OrderItem` shapes precisely, but does not define
 * `Product`/`Category`. Per product decision, Product is assumed to follow
 * the same convention as OrderItem (productId/productName), with a
 * productId/name fallback and isActive/isAvailable fallback. If the real
 * response uses different field names, fix `normalizeProduct` below --
 * it is the single place that assumption lives.
 */
var BotOrderWebhookClient = (function () {
  function properties() {
    return PropertiesService.getScriptProperties();
  }

  function requiredProperty(name) {
    var value = properties().getProperty(name);
    if (!value) throw new Error('Missing required script property: ' + name);
    return value;
  }

  function optionalProperty(name) {
    return properties().getProperty(name) || null;
  }

  function createRequestId(action) {
    return 'clawbot-' + action + '-' + Utilities.getUuid();
  }

  // Mutations must reuse the SAME requestId across retries of the same
  // logical operation, or a timed-out response whose request actually
  // succeeded server-side gets retried with a fresh id and the POS creates
  // a second order / applies the action twice. Callers pass a stable,
  // business-derived key (e.g. "createOrder:<clawbotOrderId>"); reads keep
  // a random id since they have no side effect to deduplicate.
  function sanitizeIdempotencyKey(key) {
    var cleaned = String(key).replace(/[^A-Za-z0-9._:-]/g, '-');
    return ('clawbot-' + cleaned).slice(0, 128);
  }

  function BotOrderWebhookError(code, message, requestId) {
    this.name = 'BotOrderWebhookError';
    this.code = code || 'BOT_WEBHOOK_ERROR';
    this.requestId = requestId || null;
    this.message = message;
    if (Error.captureStackTrace) Error.captureStackTrace(this, BotOrderWebhookError);
  }
  BotOrderWebhookError.prototype = Object.create(Error.prototype);
  BotOrderWebhookError.prototype.constructor = BotOrderWebhookError;

  /**
   * Low-level envelope call. Returns the parsed response body as-is
   * (caller inspects status/duplicate/patch/orderId per action). Throws
   * BotOrderWebhookError for both infrastructure failures and `ok:false`
   * business errors -- there is no cached/static fallback by design.
   */
  function call(action, payload, idempotencyKey) {
    var url = requiredProperty('BOT_ORDER_WEBHOOK_URL');
    var secret = requiredProperty('BOT_ORDER_WEBHOOK_SECRET');
    var requestId = idempotencyKey ? sanitizeIdempotencyKey(idempotencyKey) : createRequestId(action);
    var response;
    try {
      response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          secret: secret,
          requestId: requestId,
          action: action,
          payload: payload || {}
        }),
        muteHttpExceptions: true
      });
    } catch (error) {
      throw new BotOrderWebhookError(
        'BOT_WEBHOOK_INFRA_ERROR',
        'Bot order webhook request failed: ' + (error && error.message ? error.message : String(error)),
        requestId
      );
    }
    var status = response.getResponseCode();
    var body;
    try {
      body = JSON.parse(response.getContentText());
    } catch (error) {
      throw new BotOrderWebhookError(
        'BOT_WEBHOOK_INFRA_ERROR',
        'Bot order webhook returned invalid JSON (HTTP ' + status + ')',
        requestId
      );
    }
    if (status !== 200 || !body || typeof body !== 'object') {
      throw new BotOrderWebhookError(
        'BOT_WEBHOOK_INFRA_ERROR',
        'Bot order webhook returned HTTP ' + status,
        requestId
      );
    }
    if (body.ok !== true) {
      throw new BotOrderWebhookError(
        body.code || 'BOT_WEBHOOK_INFRA_ERROR',
        body.message || ('Bot order webhook response is missing ok:true (got: ' + JSON.stringify(body) + ')'),
        body.requestId
      );
    }
    return body;
  }

  // CONFIRMED against a live getMenuCatalog response (2026-07-18) -- Product
  // uses `id`/`basePrice`/`active`+`soldOut`, not `productId`/`price`/`isActive`.
  // Fallbacks are kept for forward-compatibility, not because they're needed
  // today. `categoryName` does NOT live on the product -- it only has
  // `categoryId`; the display name comes from the separate `categories`
  // array and is joined in via `categoryNameById` (see fetchMenuCatalog).
  //
  // KNOWN LIMITATION: products with multiple sizes carry a `sizeOptionsJson`
  // array (e.g. M/L with different prices) that this bot does not read --
  // only `basePrice` (the base/first size) is used. Size selection is not
  // supported by the current cart UI.
  function normalizeProduct(raw, index, categoryNameById) {
    var productId = raw.productId != null ? raw.productId : raw.id;
    var name = raw.productName != null ? raw.productName : raw.name;
    var price = raw.price != null ? raw.price : raw.basePrice;
    var isAvailable = typeof raw.isActive === 'boolean' ? raw.isActive
      : typeof raw.isAvailable === 'boolean' ? raw.isAvailable
      : typeof raw.active === 'boolean' ? (raw.active && raw.soldOut !== true)
      : undefined;
    if (typeof productId !== 'string' || !productId) {
      throw new BotOrderWebhookError('BOT_WEBHOOK_INFRA_ERROR', 'Menu product at index ' + index + ' is missing a valid id');
    }
    if (typeof name !== 'string' || !name) {
      throw new BotOrderWebhookError('BOT_WEBHOOK_INFRA_ERROR', 'Menu product ' + productId + ' is missing a valid name');
    }
    if (typeof price !== 'number' || !Number.isFinite(price)) {
      // Deliberately does not coerce a bad/missing price to 0 -- that would
      // silently let a product be added to a cart for free.
      throw new BotOrderWebhookError('BOT_WEBHOOK_INFRA_ERROR', 'Menu product ' + productId + ' has an invalid price: ' + JSON.stringify(price));
    }
    if (typeof isAvailable !== 'boolean') {
      throw new BotOrderWebhookError('BOT_WEBHOOK_INFRA_ERROR', 'Menu product ' + productId + ' is missing a boolean active/isActive/isAvailable');
    }
    var categoryId = raw.categoryId || null;
    var categoryName = raw.categoryName ||
      (categoryId && categoryNameById ? categoryNameById[categoryId] : null) || null;
    return {
      productId: productId,
      name: name,
      price: price,
      isAvailable: isAvailable,
      categoryId: categoryId,
      categoryName: categoryName
    };
  }

  function internalStatusFromRemote(remote) {
    var status = remote && remote.status;
    if (status === 'open') return 'AWAITING_PAYMENT';
    if (status === 'completed' || status === 'paid') return 'PAID';
    // The webhook conflates customer-cancel and payment-timeout-expire into
    // one "cancelled" status. Clawbot's own EXPIRED vs CANCELLED distinction
    // cannot be reliably reconstructed on read-back from this API alone, so
    // it collapses to CANCELLED here. This only affects re-reads (e.g. a
    // later /status check) -- the customer-facing message at the moment of
    // expiry/cancellation is still generated by Clawbot itself and is correct.
    if (status === 'cancelled') return 'CANCELLED';
    return status || 'UNKNOWN';
  }

  function normalizeOrder(remote) {
    return {
      orderId: remote.id,
      customerId: remote.customerId || null,
      items: [],
      status: internalStatusFromRemote(remote),
      totalAmount: typeof remote.total === 'number' ? remote.total : Number(remote.total) || 0,
      createdAt: remote.createdAt,
      updatedAt: remote.updatedAt,
      confirmedAt: remote.completedAt || null,
      // Not exposed per-order by this API (POS attributes all bot actions to
      // a single BOT_ORDER_WEBHOOK_ACTOR_EMAIL on its side); Clawbot's own
      // ErrorLogs/audit trail still records which staff member triggered it.
      confirmedBy: null
    };
  }

  function normalizeOrderItem(remote) {
    return {
      productId: remote.productId,
      name: remote.productName,
      unitPrice: typeof remote.unitPrice === 'number' ? remote.unitPrice : Number(remote.unitPrice) || 0,
      quantity: remote.quantity
    };
  }

  function categoryNameLookup(categories) {
    var lookup = {};
    (Array.isArray(categories) ? categories : []).forEach(function (category) {
      if (!category) return;
      var id = category.categoryId != null ? category.categoryId : category.id;
      var name = category.categoryName != null ? category.categoryName : category.name;
      if (id != null) lookup[id] = name;
    });
    return lookup;
  }

  function fetchMenuCatalog() {
    var body = call('getMenuCatalog', {});
    if (!body.patch || !Array.isArray(body.patch.products)) {
      throw new BotOrderWebhookError(
        'BOT_WEBHOOK_INFRA_ERROR',
        'getMenuCatalog response is missing patch.products (array)',
        body.requestId
      );
    }
    var categoryNameById = categoryNameLookup(body.patch.categories);
    return body.patch.products.map(function (product, index) {
      return normalizeProduct(product, index, categoryNameById);
    });
  }

  function getOrder(orderId) {
    var body = call('getOrder', { orderId: orderId });
    var orders = (body.patch && Array.isArray(body.patch.orders)) ? body.patch.orders : [];
    if (!orders.length) return null;
    var order = normalizeOrder(orders[0]);
    var items = (body.patch && Array.isArray(body.patch.orderItems)) ? body.patch.orderItems : [];
    order.items = items.map(normalizeOrderItem);
    return order;
  }

  function findOrdersByCustomerId(customerId) {
    var body = call('findOrdersByCustomerId', { customerId: customerId });
    var orders = (body.patch && Array.isArray(body.patch.orders)) ? body.patch.orders : [];
    return orders.map(normalizeOrder);
  }

  function listOpenOrders() {
    var body = call('listOpenOrders', {});
    var orders = (body.patch && Array.isArray(body.patch.orders)) ? body.patch.orders : [];
    return orders.map(normalizeOrder);
  }

  function orderPayloadDefaults() {
    var defaults = {
      channel: optionalProperty('BOT_ORDER_WEBHOOK_CHANNEL') || 'online_bot',
      source: optionalProperty('BOT_ORDER_WEBHOOK_SOURCE') || 'clawbot'
    };
    var tableId = optionalProperty('BOT_ORDER_WEBHOOK_TABLE_ID');
    if (tableId) defaults.tableId = tableId;
    return defaults;
  }

  function createOrder(input) {
    if (!input.clawbotOrderId) {
      throw new TypeError('createOrder requires input.clawbotOrderId as a stable idempotency key');
    }
    var orderPayload = Object.assign({
      customerId: input.customerId,
      raw: { clawbotOrderId: input.clawbotOrderId }
    }, orderPayloadDefaults());
    // Attach the resolved POS member (if any) so the POS's own loyalty
    // pipeline can accrue points on completeOrder -- points are never
    // written by Clawbot directly (id/points/totalSpend are server-owned).
    if (input.memberId) orderPayload.memberId = input.memberId;
    var body = call('createOrder', {
      order: orderPayload,
      items: (input.items || []).map(function (item) {
        return { productId: item.productId, quantity: item.quantity };
      })
    }, 'createOrder:' + input.clawbotOrderId);
    if (body.duplicate) {
      // A retry (e.g. our own UrlFetchApp call timed out but the POS had
      // already committed the first attempt) landed on the same
      // requestId. The POS still returns `orderId` in this envelope (just
      // no `patch`) -- recover the real order instead of creating a second
      // one or throwing away a perfectly good result.
      if (!body.orderId) {
        throw new BotOrderWebhookError(
          'BOT_WEBHOOK_INFRA_ERROR',
          'createOrder reported duplicate/processing with no orderId to recover',
          body.requestId
        );
      }
      var recovered = getOrder(body.orderId);
      if (!recovered) {
        throw new BotOrderWebhookError(
          'BOT_WEBHOOK_INFRA_ERROR',
          'createOrder duplicate pointed at orderId ' + body.orderId + ' but getOrder found nothing',
          body.requestId
        );
      }
      return recovered;
    }
    var remoteOrder = body.patch && Array.isArray(body.patch.orders) ? body.patch.orders[0] : null;
    if (!remoteOrder) {
      throw new BotOrderWebhookError('BOT_WEBHOOK_INFRA_ERROR', 'createOrder response is missing patch.orders[0]', body.requestId);
    }
    var normalized = normalizeOrder(remoteOrder);
    var items = body.patch && Array.isArray(body.patch.orderItems) ? body.patch.orderItems : [];
    normalized.items = items.map(normalizeOrderItem);
    return normalized;
  }

  function completeOrder(orderId, paymentMethod) {
    var body = call(
      'completeOrder',
      { orderId: orderId, paymentMethod: paymentMethod },
      'completeOrder:' + orderId
    );
    // duplicate/processing means this exact operation was already applied --
    // treated as a successful no-op since callers here don't use the return value.
    return { orderId: body.orderId || orderId, duplicate: !!body.duplicate };
  }

  function cancelOrder(orderId, reason) {
    var body = call(
      'cancelOrder',
      { orderId: orderId, reason: reason },
      'cancelOrder:' + orderId + ':' + reason
    );
    return { orderId: body.orderId || orderId, duplicate: !!body.duplicate };
  }

  // CONFIRMED against the POS webhook doc (2026-07-18, "Bot Order Webhook" v2
  // with member actions). id/points/totalSpend are always server-owned --
  // createMember/updateMember silently ignore them if sent.
  function normalizeMember(remote) {
    return {
      memberId: remote.id,
      code: remote.code || null,
      name: remote.name || '',
      phone: remote.phone || null,
      email: remote.email || null,
      points: typeof remote.points === 'number' ? remote.points : Number(remote.points) || 0,
      totalSpend: typeof remote.totalSpend === 'number' ? remote.totalSpend : Number(remote.totalSpend) || 0
    };
  }

  // Unknown memberId is a real error for this action (unlike getOrder, which
  // treats a missing order as a normal empty read) -- see BOT_WEBHOOK_MEMBER_NOT_FOUND.
  function getMemberProfile(memberId) {
    var body = call('getMemberProfile', { memberId: memberId });
    var members = (body.patch && Array.isArray(body.patch.members)) ? body.patch.members : [];
    if (!members.length) {
      throw new BotOrderWebhookError('BOT_WEBHOOK_MEMBER_NOT_FOUND', 'Member not found: ' + memberId, body.requestId);
    }
    return normalizeMember(members[0]);
  }

  // `query` is optional; omit to list every non-deleted member. Matches
  // name/phone/member code (case-insensitive substring), per the POS doc.
  function listMembers(query) {
    var body = call('listMembers', query ? { query: query } : {});
    var members = (body.patch && Array.isArray(body.patch.members)) ? body.patch.members : [];
    return members.map(normalizeMember);
  }

  // No stable idempotency key is used for createMember: unlike createOrder,
  // Clawbot has no local "clawbotMemberId" to key on ahead of time, and a
  // member is looked up (listMembers by phone) before ever creating one --
  // see MemberRepository.gs. A random requestId per call is acceptable here
  // because that lookup-before-create already prevents duplicate members in
  // the common case; a true double-submit race is a rare, low-stakes edge
  // case (worst case: two member rows for one phone number, fixable by staff).
  function createMember(member) {
    var body = call('createMember', {
      member: { name: member.name, phone: member.phone || undefined, email: member.email || undefined }
    });
    if (body.duplicate) {
      if (!body.memberId) {
        // Per the doc: a still-"processing" retry may have no memberId yet
        // (not assigned until the mutation persists). Caller should retry or
        // fall back to listMembers -- surface this distinctly so
        // MemberRepository.gs can decide rather than silently look wrong.
        throw new BotOrderWebhookError(
          'BOT_WEBHOOK_INFRA_ERROR',
          'createMember reported duplicate/processing with no memberId yet',
          body.requestId
        );
      }
      return getMemberProfile(body.memberId);
    }
    var remoteMember = body.patch && Array.isArray(body.patch.members) ? body.patch.members[0] : null;
    if (!remoteMember) {
      throw new BotOrderWebhookError('BOT_WEBHOOK_INFRA_ERROR', 'createMember response is missing patch.members[0]', body.requestId);
    }
    return normalizeMember(remoteMember);
  }

  function updateMember(memberId, member) {
    var body = call(
      'updateMember',
      { memberId: memberId, member: { name: member.name, phone: member.phone || undefined, email: member.email || undefined } },
      'updateMember:' + memberId
    );
    if (body.duplicate) return getMemberProfile(memberId);
    var remoteMember = body.patch && Array.isArray(body.patch.members) ? body.patch.members[0] : null;
    if (!remoteMember) {
      throw new BotOrderWebhookError('BOT_WEBHOOK_INFRA_ERROR', 'updateMember response is missing patch.members[0]', body.requestId);
    }
    return normalizeMember(remoteMember);
  }

  // Debug-only: dumps the raw, unnormalized getMenuCatalog response so the
  // real Product/Category field names can be confirmed against Clawbot's
  // ASSUMPTION above. Safe to call from the Apps Script editor; not used by
  // any live code path.
  function debugFetchRawMenuCatalog() {
    var body = call('getMenuCatalog', {});
    var output = JSON.stringify(body, null, 2);
    if (typeof console !== 'undefined' && console.log) console.log(output);
    else if (typeof Logger !== 'undefined' && Logger.log) Logger.log(output);
    return body;
  }

  return Object.freeze({
    fetchMenuCatalog: fetchMenuCatalog,
    debugFetchRawMenuCatalog: debugFetchRawMenuCatalog,
    getOrder: getOrder,
    findOrdersByCustomerId: findOrdersByCustomerId,
    listOpenOrders: listOpenOrders,
    createOrder: createOrder,
    completeOrder: completeOrder,
    cancelOrder: cancelOrder,
    getMemberProfile: getMemberProfile,
    listMembers: listMembers,
    createMember: createMember,
    updateMember: updateMember,
    Errors: Object.freeze({ BotOrderWebhookError: BotOrderWebhookError })
  });
})();

// Global wrapper so this shows up in the Apps Script editor's function
// dropdown (only top-level functions do). Run this once, then check the
// execution log for the real Product/Category field names.
function debugFetchRawMenuCatalog() {
  return BotOrderWebhookClient.debugFetchRawMenuCatalog();
}

if (typeof module !== 'undefined' && module.exports) module.exports = BotOrderWebhookClient;
