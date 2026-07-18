'use strict';

function SheetZaloProcessedUpdateRepository() {
  var SHEET = 'ZaloProcessedUpdates';
  var HEADERS = ['messageId', 'processedAt', 'deliveryStatus'];
  var STATUSES = Object.freeze({ pending: true, delivered: true, failed: true });
  var CACHE_TTL_SECONDS = 300;
  function cache() {
    return typeof CacheService === 'undefined' ? null : CacheService.getScriptCache();
  }
  function cacheKey(messageId) { return 'processed:zalo:' + String(messageId); }

  function writableSheet() {
    return SheetRepositorySupport.writableSheet(SHEET, HEADERS);
  }
  function has(messageId) {
    var id = String(messageId);
    var scriptCache = cache();
    if (scriptCache && scriptCache.get(cacheKey(id))) return true;
    var exists = SheetRepositorySupport.rows(SheetRepositorySupport.readSheet(SHEET))
      .some(function (row) { return String(row[0]) === id; });
    if (exists && scriptCache) scriptCache.put(cacheKey(id), '1', CACHE_TTL_SECONDS);
    return exists;
  }
  function markProcessed(messageId, processedAt) {
    var id = String(messageId);
    return SheetRepositorySupport.withScriptLock(function () {
      var sheet = writableSheet();
      var exists = SheetRepositorySupport.rows(sheet)
        .some(function (row) { return String(row[0]) === id; });
      if (!exists) sheet.appendRow([id, processedAt, 'pending']);
      var scriptCache = cache();
      if (scriptCache) scriptCache.put(cacheKey(id), '1', CACHE_TTL_SECONDS);
      return !exists;
    });
  }
  function updateDeliveryStatus(messageId, status) {
    if (!STATUSES[status]) throw new Error('Invalid delivery status: ' + status);
    var id = String(messageId);
    return SheetRepositorySupport.withScriptLock(function () {
      var sheet = writableSheet();
      var rows = SheetRepositorySupport.rows(sheet);
      var index = rows.findIndex(function (row) { return String(row[0]) === id; });
      if (index < 0) throw new Error('Processed Zalo message not found: ' + id);
      sheet.getRange(index + 2, 3).setValue(status);
      return status;
    });
  }
  return Object.freeze({ has: has, markProcessed: markProcessed, updateDeliveryStatus: updateDeliveryStatus });
}

if (typeof module !== 'undefined' && module.exports) module.exports = SheetZaloProcessedUpdateRepository;
