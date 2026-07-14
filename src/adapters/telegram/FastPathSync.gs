'use strict';

function syncTelegramFastPathSnapshot(snapshot) {
  if (!snapshot || snapshot.kind !== 'fast_path_sync' || !Number.isInteger(snapshot.updateId)) {
    throw new TypeError('Invalid fast-path snapshot');
  }
  if (!snapshot.customer || !snapshot.conversationState || !Array.isArray(snapshot.orders)) {
    throw new TypeError('Fast-path snapshot is incomplete');
  }

  var markerSheet = SheetRepositorySupport.writableSheet(
    'FastPathSyncedUpdates', ['updateId', 'syncedAt']
  );
  var duplicate = SheetRepositorySupport.rows(markerSheet).some(function (row) {
    return String(row[0]) === String(snapshot.updateId);
  });
  if (duplicate) return { duplicate: true };

  SheetCustomerRepository().save(snapshot.customer);
  snapshot.orders.forEach(function (order) { SheetOrderRepository().save(order); });
  SheetConversationStateRepository().set(
    snapshot.conversationState.customerId,
    snapshot.conversationState
  );
  SheetRepositorySupport.withScriptLock(function () {
    var sheet = SheetRepositorySupport.writableSheet(
      'FastPathSyncedUpdates', ['updateId', 'syncedAt']
    );
    var alreadyStored = SheetRepositorySupport.rows(sheet).some(function (row) {
      return String(row[0]) === String(snapshot.updateId);
    });
    if (!alreadyStored) sheet.appendRow([snapshot.updateId, new Date().toISOString()]);
  });
  return { duplicate: false, orders: snapshot.orders.length };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { syncTelegramFastPathSnapshot: syncTelegramFastPathSnapshot };
}
