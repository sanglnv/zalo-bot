'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require.extensions['.gs'] = require.extensions['.js'];

// options.body: single fixed response for every call.
// options.bodyByAction: { actionName: responseBody } -- routes by the
// request's `action` field, for tests that need a create-then-recover
// sequence (two different actions called in the same flow).
function loadClient(options = {}) {
  options.requests = [];
  global.PropertiesService = {
    getScriptProperties: () => ({
      getProperty(name) {
        if (options.missingUrl && name === 'BOT_ORDER_WEBHOOK_URL') return null;
        if (options.missingSecret && name === 'BOT_ORDER_WEBHOOK_SECRET') return null;
        if (name === 'BOT_ORDER_WEBHOOK_URL') return 'https://pos.example/exec';
        if (name === 'BOT_ORDER_WEBHOOK_SECRET') return 'pos-secret';
        return (options.properties && options.properties[name]) || null;
      }
    })
  };
  global.Utilities = { getUuid: () => 'uuid-1234' };
  global.UrlFetchApp = {
    fetch(url, params) {
      if (options.fetchError) throw new Error('network unavailable');
      const body = JSON.parse(params.payload);
      options.requests.push({ url, params, body });
      options.capturedRequest = options.requests[options.requests.length - 1];
      const responseBody = options.bodyByAction ? options.bodyByAction[body.action] : options.body;
      return {
        getResponseCode: () => options.status || 200,
        getContentText: () => options.invalidJson ? '{bad' : JSON.stringify(responseBody)
      };
    }
  };
  delete require.cache[require.resolve('../adapters/menu/BotOrderWebhookClient.gs')];
  return require('../adapters/menu/BotOrderWebhookClient.gs');
}

test('call() sends secret + requestId + action in the POST body, not headers or query params', () => {
  const options = {
    body: { ok: true, action: 'getMenuCatalog', requestId: 'x', status: 'completed', patch: { products: [] } }
  };
  loadClient(options).fetchMenuCatalog();
  assert.equal(options.capturedRequest.url, 'https://pos.example/exec');
  assert.equal(options.capturedRequest.params.method, 'post');
  assert.equal(options.capturedRequest.params.contentType, 'application/json');
  assert.equal(options.capturedRequest.body.secret, 'pos-secret');
  assert.equal(options.capturedRequest.body.action, 'getMenuCatalog');
  assert.match(options.capturedRequest.body.requestId, /^clawbot-getMenuCatalog-/);
  assert.equal(options.capturedRequest.params.headers, undefined);
});

test('mutations reuse a stable, business-derived requestId instead of a fresh UUID every call', () => {
  const options = {
    bodyByAction: {
      createOrder: {
        ok: true, action: 'createOrder', requestId: 'x', orderId: 'HD-NEW', status: 'completed', duplicate: false,
        patch: {
          orders: [{ id: 'HD-NEW', status: 'open', customerId: 'c1', total: 70000, createdAt: 'a', updatedAt: 'a' }],
          orderItems: []
        }
      }
    }
  };
  const client = loadClient(options);
  client.createOrder({ customerId: 'c1', clawbotOrderId: 'local-1', items: [] });
  const firstRequestId = options.requests[0].body.requestId;
  client.createOrder({ customerId: 'c1', clawbotOrderId: 'local-1', items: [] });
  const secondRequestId = options.requests[1].body.requestId;
  assert.equal(firstRequestId, secondRequestId);
  assert.equal(firstRequestId, 'clawbot-createOrder:local-1');
});

test('createOrder recovers the real order instead of double-creating when the POS reports a retry duplicate', () => {
  const options = {
    bodyByAction: {
      createOrder: { ok: true, action: 'createOrder', requestId: 'x', orderId: 'HD-NEW', status: 'duplicate', duplicate: true },
      getOrder: {
        ok: true, action: 'getOrder', requestId: 'y', status: 'completed',
        patch: {
          orders: [{ id: 'HD-NEW', status: 'open', customerId: 'c1', total: 70000, createdAt: 'a', updatedAt: 'a' }],
          orderItems: [{ productId: 'p1', productName: 'Coffee', unitPrice: 35000, quantity: 2 }]
        }
      }
    }
  };
  const created = loadClient(options).createOrder({
    customerId: 'c1', clawbotOrderId: 'local-1', items: [{ productId: 'p1', quantity: 2 }]
  });
  assert.equal(created.orderId, 'HD-NEW');
  assert.equal(created.items[0].productId, 'p1');
  // No second order was created -- the duplicate response was recovered via getOrder, not retried.
  assert.equal(options.requests.filter((r) => r.body.action === 'createOrder').length, 1);
});

test('createOrder requires a clawbotOrderId to derive the idempotency key', () => {
  assert.throws(
    () => loadClient({}).createOrder({ customerId: 'c1', items: [] }),
    /requires input.clawbotOrderId/
  );
});

test('fetchMenuCatalog normalizes products with productId/productName/isActive fallbacks', () => {
  const products = loadClient({
    body: {
      ok: true, action: 'getMenuCatalog', requestId: 'x', status: 'completed',
      patch: {
        products: [
          { productId: 'p1', productName: 'Coffee', price: 35000, isActive: true, categoryId: 'CAT1', categoryName: 'Drinks' },
          { id: 'p2', name: 'Tea', price: 30000, isAvailable: false }
        ]
      }
    }
  }).fetchMenuCatalog();
  assert.deepEqual(products, [
    { productId: 'p1', name: 'Coffee', price: 35000, isAvailable: true, categoryId: 'CAT1', categoryName: 'Drinks' },
    { productId: 'p2', name: 'Tea', price: 30000, isAvailable: false, categoryId: null, categoryName: null }
  ]);
});

test('fetchMenuCatalog matches the real POS shape: id/basePrice/active+soldOut, categoryName joined from patch.categories', () => {
  const products = loadClient({
    body: {
      ok: true, action: 'getMenuCatalog', requestId: 'x', status: 'completed',
      patch: {
        categories: [
          { id: 'CAT_CAFE', name: 'CAFE', sortOrder: 1, active: true },
          { id: 'CAT_TEA', name: 'TRÀ', sortOrder: 3, active: true }
        ],
        products: [
          {
            id: 'M627869', categoryId: 'CAT_CAFE', sku: 'M627869', name: 'ESPRESSO',
            basePrice: 20000, sizeOptionsJson: '[{"name":"M","price":20000}]',
            active: true, soldOut: false, sortOrder: 0
          },
          {
            id: 'M999999', categoryId: 'CAT_TEA', sku: 'M999999', name: 'TRÀ ĐÀO',
            basePrice: 30000, active: true, soldOut: true, sortOrder: 0
          }
        ]
      }
    }
  }).fetchMenuCatalog();
  assert.deepEqual(products, [
    { productId: 'M627869', name: 'ESPRESSO', price: 20000, isAvailable: true, categoryId: 'CAT_CAFE', categoryName: 'CAFE' },
    { productId: 'M999999', name: 'TRÀ ĐÀO', price: 30000, isAvailable: false, categoryId: 'CAT_TEA', categoryName: 'TRÀ' }
  ]);
});

test('fetchMenuCatalog rejects a malformed response instead of returning an empty/wrong menu', () => {
  const cases = [
    { body: { ok: true, action: 'getMenuCatalog', requestId: 'x', status: 'completed', patch: {} }, pattern: /missing patch.products/ },
    { body: {}, pattern: /missing ok:true/ },
    {
      body: { ok: true, patch: { products: [{ productName: 'Coffee', price: 35000, isActive: true }] } },
      pattern: /missing a valid id/
    },
    {
      body: { ok: true, patch: { products: [{ productId: 'p1', price: 35000, isActive: true }] } },
      pattern: /missing a valid name/
    },
    {
      // A bad/missing price must throw, not silently become 0.
      body: { ok: true, patch: { products: [{ productId: 'p1', productName: 'Coffee', price: 'not-a-number', isActive: true }] } },
      pattern: /invalid price/
    },
    {
      body: { ok: true, patch: { products: [{ productId: 'p1', productName: 'Coffee', price: 35000 }] } },
      pattern: /missing a boolean active\/isActive\/isAvailable/
    }
  ];
  cases.forEach((options) => {
    assert.throws(() => loadClient(options).fetchMenuCatalog(), options.pattern);
  });
});

test('getOrder normalizes an existing order with items and maps status open -> AWAITING_PAYMENT', () => {
  const order = loadClient({
    body: {
      ok: true, action: 'getOrder', requestId: 'x', status: 'completed',
      patch: {
        orders: [{
          id: 'HD1', status: 'open', customerId: 'c1', total: 75000,
          createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z', completedAt: ''
        }],
        orderItems: [{ productId: 'p1', productName: 'Coffee', unitPrice: 35000, quantity: 2 }]
      }
    }
  }).getOrder('HD1');
  assert.deepEqual(order, {
    orderId: 'HD1', customerId: 'c1', status: 'AWAITING_PAYMENT', totalAmount: 75000,
    createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z', confirmedAt: null,
    confirmedBy: null,
    items: [{ productId: 'p1', name: 'Coffee', unitPrice: 35000, quantity: 2 }]
  });
});

test('getOrder returns null for an unknown order id (empty patch.orders is not an error)', () => {
  const order = loadClient({
    body: { ok: true, action: 'getOrder', requestId: 'x', status: 'completed', patch: { orders: [], orderItems: [] } }
  }).getOrder('missing');
  assert.equal(order, null);
});

test('status mapping: completed/paid -> PAID, cancelled -> CANCELLED', () => {
  const client = loadClient({
    body: {
      ok: true, action: 'getOrder', requestId: 'x', status: 'completed',
      patch: { orders: [{ id: 'HD1', status: 'completed', total: 1, createdAt: 'a', updatedAt: 'b', completedAt: 'c' }], orderItems: [] }
    }
  });
  assert.equal(client.getOrder('HD1').status, 'PAID');
  assert.equal(client.getOrder('HD1').confirmedAt, 'c');
});

test('createOrder returns the POS-assigned order with items on success', () => {
  const options = {
    body: {
      ok: true, action: 'createOrder', requestId: 'x', orderId: 'HD-NEW', status: 'completed', duplicate: false,
      patch: {
        orders: [{ id: 'HD-NEW', status: 'open', customerId: 'c1', total: 70000, createdAt: 'a', updatedAt: 'a' }],
        orderItems: [{ productId: 'p1', productName: 'Coffee', unitPrice: 35000, quantity: 2 }]
      }
    }
  };
  const created = loadClient(options).createOrder({
    customerId: 'c1', clawbotOrderId: 'local-1',
    items: [{ productId: 'p1', quantity: 2 }]
  });
  assert.equal(created.orderId, 'HD-NEW');
  assert.equal(created.items[0].productId, 'p1');
  assert.equal(options.capturedRequest.body.payload.order.raw.clawbotOrderId, 'local-1');
  assert.equal(options.capturedRequest.body.payload.order.channel, 'online_bot');
  assert.equal(options.capturedRequest.body.payload.order.source, 'clawbot');
  assert.deepEqual(options.capturedRequest.body.payload.items, [{ productId: 'p1', quantity: 2 }]);
  assert.equal('memberId' in options.capturedRequest.body.payload.order, false, 'memberId omitted entirely when not resolved');
});

test('createOrder attaches memberId to the order payload when the customer resolved a POS member', () => {
  const options = {
    body: {
      ok: true, action: 'createOrder', requestId: 'x', orderId: 'HD-NEW', status: 'completed', duplicate: false,
      patch: {
        orders: [{ id: 'HD-NEW', status: 'open', customerId: 'c1', total: 70000, createdAt: 'a', updatedAt: 'a' }],
        orderItems: []
      }
    }
  };
  loadClient(options).createOrder({
    customerId: 'c1', clawbotOrderId: 'local-1', items: [], memberId: 'M1'
  });
  assert.equal(options.capturedRequest.body.payload.order.memberId, 'M1');
});

test('completeOrder and cancelOrder use a stable per-order requestId and treat duplicate/processing as a no-op', () => {
  const options = {
    body: { ok: true, action: 'completeOrder', requestId: 'x', orderId: 'HD1', status: 'duplicate', duplicate: true }
  };
  const client = loadClient(options);
  assert.deepEqual(client.completeOrder('HD1', 'bank_transfer'), { orderId: 'HD1', duplicate: true });
  assert.equal(options.capturedRequest.body.requestId, 'clawbot-completeOrder:HD1');
});

test('getMemberProfile normalizes the member and its request uses a fresh (non-stable) requestId', () => {
  const options = {
    body: {
      ok: true, action: 'getMemberProfile', requestId: 'x', status: 'completed',
      patch: {
        members: [{ id: 'M1', code: 'MB001', name: 'Nguyễn Văn A', phone: '0901234567', email: null, points: 120, totalSpend: 500000 }],
        pointTransactions: []
      }
    }
  };
  const client = loadClient(options);
  assert.deepEqual(client.getMemberProfile('M1'), {
    memberId: 'M1', code: 'MB001', name: 'Nguyễn Văn A', phone: '0901234567', email: null, points: 120, totalSpend: 500000
  });
  assert.equal(options.capturedRequest.body.action, 'getMemberProfile');
  assert.match(options.capturedRequest.body.requestId, /^clawbot-getMemberProfile-/);
});

test('getMemberProfile throws BOT_WEBHOOK_MEMBER_NOT_FOUND-shaped error for an unknown member (unlike getOrder)', () => {
  const options = {
    body: { ok: true, action: 'getMemberProfile', requestId: 'x', status: 'completed', patch: { members: [], pointTransactions: [] } }
  };
  assert.throws(
    () => loadClient(options).getMemberProfile('missing'),
    (error) => error.code === 'BOT_WEBHOOK_MEMBER_NOT_FOUND' && /missing/.test(error.message)
  );
});

test('listMembers sends the optional query and normalizes every match, or lists all when omitted', () => {
  const options = {
    body: {
      ok: true, action: 'listMembers', requestId: 'x', status: 'completed',
      patch: { members: [{ id: 'M1', name: 'A', phone: '0901234567', points: 0, totalSpend: 0 }] }
    }
  };
  const client = loadClient(options);
  assert.equal(client.listMembers('0901').length, 1);
  assert.deepEqual(options.capturedRequest.body.payload, { query: '0901' });
  client.listMembers();
  assert.deepEqual(options.capturedRequest.body.payload, {});
});

test('createMember sends only name/phone/email and ignores any id/points/totalSpend the caller passes', () => {
  const options = {
    body: {
      ok: true, action: 'createMember', requestId: 'x', memberId: 'M2', status: 'completed', duplicate: false,
      patch: { members: [{ id: 'M2', code: 'MB002', name: 'B', phone: '0909', email: null, points: 0, totalSpend: 0 }] }
    }
  };
  const client = loadClient(options);
  const created = client.createMember({ id: 'client-supplied-should-be-ignored', name: 'B', phone: '0909', points: 9999 });
  assert.deepEqual(options.capturedRequest.body.payload, { member: { name: 'B', phone: '0909' } });
  assert.equal(created.memberId, 'M2');
  assert.equal(created.points, 0);
});

test('createMember recovers via getMemberProfile on a resolved duplicate, and throws distinctly when memberId is not yet assigned', () => {
  const resolved = loadClient({
    bodyByAction: {
      createMember: { ok: true, action: 'createMember', requestId: 'x', memberId: 'M3', status: 'duplicate', duplicate: true },
      getMemberProfile: {
        ok: true, action: 'getMemberProfile', requestId: 'x', status: 'completed',
        patch: { members: [{ id: 'M3', name: 'C', phone: '0900', points: 0, totalSpend: 0 }], pointTransactions: [] }
      }
    }
  });
  assert.equal(resolved.createMember({ name: 'C', phone: '0900' }).memberId, 'M3');

  const stillProcessing = loadClient({
    bodyByAction: {
      createMember: { ok: true, action: 'createMember', requestId: 'x', status: 'processing', duplicate: true }
    }
  });
  assert.throws(
    () => stillProcessing.createMember({ name: 'D', phone: '0900' }),
    /no memberId yet/
  );
});

test('updateMember reuses a stable requestId per memberId, sends only name/phone/email, and recovers on duplicate', () => {
  const options = {
    bodyByAction: {
      updateMember: {
        ok: true, action: 'updateMember', requestId: 'x', memberId: 'M1', status: 'completed', duplicate: false,
        patch: { members: [{ id: 'M1', name: 'New Name', phone: '0901', points: 10, totalSpend: 20000 }] }
      }
    }
  };
  const client = loadClient(options);
  client.updateMember('M1', { name: 'New Name', phone: '0901', points: 99999 });
  assert.equal(options.requests[0].body.requestId, 'clawbot-updateMember:M1');
  assert.deepEqual(options.requests[0].body.payload, { memberId: 'M1', member: { name: 'New Name', phone: '0901' } });

  const duplicateOptions = {
    bodyByAction: {
      updateMember: { ok: true, action: 'updateMember', requestId: 'x', memberId: 'M1', status: 'duplicate', duplicate: true },
      getMemberProfile: {
        ok: true, action: 'getMemberProfile', requestId: 'x', status: 'completed',
        patch: { members: [{ id: 'M1', name: 'New Name', phone: '0901', points: 10, totalSpend: 20000 }], pointTransactions: [] }
      }
    }
  };
  assert.equal(loadClient(duplicateOptions).updateMember('M1', { name: 'New Name' }).name, 'New Name');
});

test('every infrastructure or business failure throws BotOrderWebhookError, with no fallback', () => {
  const cases = [
    { missingUrl: true, pattern: /Missing required script property: BOT_ORDER_WEBHOOK_URL/ },
    { missingSecret: true, pattern: /Missing required script property: BOT_ORDER_WEBHOOK_SECRET/ },
    { fetchError: true, pattern: /Bot order webhook request failed: network unavailable/ },
    { status: 500, body: {}, pattern: /HTTP 500/ },
    { invalidJson: true, pattern: /invalid JSON/ },
    { body: { ok: false, code: 'BOT_WEBHOOK_UNAUTHORIZED', requestId: 'x', message: 'bad secret' }, pattern: /bad secret/ }
  ];
  cases.forEach((options) => {
    assert.throws(() => loadClient(options).fetchMenuCatalog(), options.pattern);
  });
});
