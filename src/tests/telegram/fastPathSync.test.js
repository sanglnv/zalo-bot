'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require.extensions['.gs'] = require.extensions['.js'];

function fixture() {
  const sheets = new Map();
  const customers = new Map();
  const orders = new Map();
  const states = new Map();

  function sheet(name, headers) {
    if (!sheets.has(name)) {
      const rows = [];
      sheets.set(name, {
        rows,
        appendRow(values) { rows.push([...values]); },
        getRange(row, column, rowCount, columnCount) {
          return {
            setValues(values) {
              rows[row - 2] = values[0].slice(0, columnCount);
            }
          };
        }
      });
    }
    return sheets.get(name);
  }

  global.SheetRepositorySupport = {
    writableSheet: sheet,
    rows: (value) => value.rows.map((row) => [...row]),
    withScriptLock: (operation) => operation()
  };
  global.SheetCustomerRepository = () => ({
    save(value) { customers.set(value.customerId, structuredClone(value)); }
  });
  global.SheetOrderRepository = () => ({
    save(value) { orders.set(value.orderId, structuredClone(value)); }
  });
  global.SheetConversationStateRepository = () => ({
    set(customerId, value) { states.set(customerId, structuredClone(value)); }
  });

  delete require.cache[require.resolve('../../adapters/telegram/FastPathSync.gs')];
  const { syncTelegramFastPathSnapshot } = require('../../adapters/telegram/FastPathSync.gs');
  return { syncTelegramFastPathSnapshot, sheets, customers, orders, states };
}

function snapshot(customerId, revision, status, snapshotId) {
  return {
    kind: 'fast_path_sync',
    schemaVersion: 2,
    snapshotId,
    customerId,
    revision,
    updateId: revision,
    capturedAt: '2026-07-15T00:00:00.000Z',
    customer: { customerId, platformLinks: [{ platform: 'telegram', platformUserId: customerId }] },
    conversationState: {
      customerId,
      currentState: status,
      contextData: {},
      updatedAt: '2026-07-15T00:00:00.000Z'
    },
    orders: [{
      orderId: 'order-' + customerId,
      customerId,
      items: [],
      status,
      totalAmount: 100,
      createdAt: '2026-07-15T00:00:00.000Z',
      updatedAt: '2026-07-15T00:00:00.000Z'
    }]
  };
}

test('GAS fast-path sync rejects out-of-order and duplicate snapshots per customer', () => {
  const f = fixture();
  assert.equal(f.syncTelegramFastPathSnapshot(snapshot('c1', 2, 'PAID', 's2')).stale, false);
  assert.equal(f.syncTelegramFastPathSnapshot(snapshot('c1', 1, 'AWAITING_PAYMENT', 's1')).stale, true);
  assert.equal(f.syncTelegramFastPathSnapshot(snapshot('c1', 2, 'PAID', 's2')).duplicate, true);
  assert.equal(f.orders.get('order-c1').status, 'PAID');
  assert.equal(f.states.get('c1').currentState, 'PAID');
});

test('snapshot revisions are isolated by customer', () => {
  const f = fixture();
  f.syncTelegramFastPathSnapshot(snapshot('c1', 3, 'PAID', 'same-time-a'));
  f.syncTelegramFastPathSnapshot(snapshot('c2', 1, 'AWAITING_PAYMENT', 'same-time-b'));
  assert.equal(f.orders.get('order-c1').status, 'PAID');
  assert.equal(f.orders.get('order-c2').status, 'AWAITING_PAYMENT');
});

test('legacy snapshots cannot overwrite a customer after snapshot v2 is active', () => {
  const f = fixture();
  f.syncTelegramFastPathSnapshot(snapshot('c1', 4, 'PAID', 'v2'));
  const legacy = snapshot('c1', 1, 'AWAITING_PAYMENT', 'legacy');
  delete legacy.schemaVersion;
  delete legacy.snapshotId;
  delete legacy.customerId;
  const result = f.syncTelegramFastPathSnapshot(legacy);
  assert.equal(result.stale, true);
  assert.equal(f.orders.get('order-c1').status, 'PAID');
});

test('snapshot sync rejects unsupported schemas and cross-customer orders', () => {
  const f = fixture();
  const unsupported = snapshot('c1', 1, 'PAID', 'unsupported');
  unsupported.schemaVersion = 3;
  assert.throws(
    () => f.syncTelegramFastPathSnapshot(unsupported),
    /Unsupported fast-path snapshot schemaVersion/
  );
  const crossed = snapshot('c1', 1, 'PAID', 'crossed');
  crossed.orders[0].customerId = 'c2';
  assert.throws(
    () => f.syncTelegramFastPathSnapshot(crossed),
    /order for another customer/
  );
});
