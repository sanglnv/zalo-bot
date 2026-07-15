'use strict';

function syncTelegramFastPathSnapshot(snapshot) {
  if (!snapshot || snapshot.kind !== 'fast_path_sync') {
    throw new TypeError('Invalid fast-path snapshot');
  }
  if (!snapshot.customer || !snapshot.conversationState || !Array.isArray(snapshot.orders)) {
    throw new TypeError('Fast-path snapshot is incomplete');
  }
  if (snapshot.schemaVersion != null && snapshot.schemaVersion !== 2) {
    throw new TypeError('Unsupported fast-path snapshot schemaVersion');
  }
  var isV2 = snapshot.schemaVersion === 2;
  var customerId = String(snapshot.customerId || snapshot.customer.customerId || '');
  if (!customerId || String(snapshot.customer.customerId || '') !== customerId ||
      String(snapshot.conversationState.customerId || '') !== customerId) {
    throw new TypeError('Fast-path snapshot customerId is inconsistent');
  }
  if (snapshot.orders.some(function (order) {
    return !order || String(order.customerId || '') !== customerId;
  })) {
    throw new TypeError('Fast-path snapshot contains an order for another customer');
  }
  if (isV2 && (!Number.isInteger(snapshot.revision) || snapshot.revision <= 0 ||
      typeof snapshot.snapshotId !== 'string' || !snapshot.snapshotId)) {
    throw new TypeError('Fast-path snapshot v2 metadata is invalid');
  }
  if (!isV2 && !Number.isInteger(snapshot.updateId)) {
    throw new TypeError('Legacy fast-path snapshot updateId is invalid');
  }

  return SheetRepositorySupport.withScriptLock(function () {
    var markerSheet = SheetRepositorySupport.writableSheet(
      'FastPathSyncedUpdates', ['updateId', 'syncedAt']
    );
    var markerId = isV2 ? snapshot.snapshotId : String(snapshot.updateId);
    var duplicate = SheetRepositorySupport.rows(markerSheet).some(function (row) {
      return String(row[0]) === markerId;
    });
    if (duplicate) return { duplicate: true, stale: false };

    var stateSheet = SheetRepositorySupport.writableSheet(
      'FastPathSyncState', ['customerId', 'lastRevision', 'lastSnapshotId', 'syncedAt']
    );
    var stateRows = SheetRepositorySupport.rows(stateSheet);
    var stateIndex = stateRows.findIndex(function (row) {
      return String(row[0]) === customerId;
    });
    var currentRevision = stateIndex < 0 ? 0 : Number(stateRows[stateIndex][1] || 0);
    if ((!isV2 && currentRevision > 0) || (isV2 && snapshot.revision <= currentRevision)) {
      markerSheet.appendRow([markerId, new Date().toISOString()]);
      return { duplicate: false, stale: true, revision: currentRevision };
    }

    SheetCustomerRepository().save(snapshot.customer);
    snapshot.orders.forEach(function (order) { SheetOrderRepository().save(order); });
    SheetConversationStateRepository().set(customerId, snapshot.conversationState);

    var syncedAt = new Date().toISOString();
    markerSheet.appendRow([markerId, syncedAt]);
    if (isV2) {
      var values = [[customerId, snapshot.revision, snapshot.snapshotId, syncedAt]];
      if (stateIndex < 0) stateSheet.appendRow(values[0]);
      else stateSheet.getRange(stateIndex + 2, 1, 1, 4).setValues(values);
    }
    return {
      duplicate: false,
      stale: false,
      revision: isV2 ? snapshot.revision : 0,
      orders: snapshot.orders.length
    };
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { syncTelegramFastPathSnapshot: syncTelegramFastPathSnapshot };
}
