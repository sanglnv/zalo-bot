'use strict';

function SheetProcessedUpdateRepository() {
  var SHEET = 'ProcessedUpdates';
  var HEADERS = ['updateId', 'processedAt', 'deliveryStatus'];
  var STATUSES = Object.freeze({ pending: true, delivered: true, failed: true });
  var CACHE_TTL_SECONDS = 300;

  function cache() {
    return typeof CacheService === 'undefined' ? null : CacheService.getScriptCache();
  }

  function cacheKey(updateId) { return 'processed:telegram:' + String(updateId); }

  function writableSheet() {
    var sheet = SheetRepositorySupport.writableSheet(SHEET, HEADERS);
    var statusHeader = sheet.getRange(1, 3).getValue();
    if (statusHeader !== 'deliveryStatus') sheet.getRange(1, 3).setValue('deliveryStatus');
    return sheet;
  }

  function has(updateId) {
    var normalized = String(updateId);
    var scriptCache = cache();
    if (scriptCache && scriptCache.get(cacheKey(normalized))) return true;
    var exists = SheetRepositorySupport.rows(SheetRepositorySupport.readSheet(SHEET))
      .some(function (row) { return String(row[0]) === normalized; });
    if (exists && scriptCache) scriptCache.put(cacheKey(normalized), '1', CACHE_TTL_SECONDS);
    return exists;
  }

  function getDeliveryStatus(updateId) {
    var normalized = String(updateId);
    var row = SheetRepositorySupport.rows(SheetRepositorySupport.readSheet(SHEET))
      .find(function (candidate) { return String(candidate[0]) === normalized; });
    if (!row) return null;
    // Rows written before delivery tracking was introduced are kept deduped.
    return row[2] ? String(row[2]) : 'delivered';
  }

  function markProcessed(updateId, processedAt) {
    var normalized = String(updateId);
    return SheetRepositorySupport.withScriptLock(function () {
      var sheet = writableSheet();
      var exists = SheetRepositorySupport.rows(sheet)
        .some(function (row) { return String(row[0]) === normalized; });
      if (!exists) sheet.appendRow([normalized, processedAt, 'pending']);
      var scriptCache = cache();
      if (scriptCache) scriptCache.put(cacheKey(normalized), '1', CACHE_TTL_SECONDS);
      return !exists;
    });
  }

  function updateDeliveryStatus(updateId, status) {
    if (!STATUSES[status]) throw new Error('Invalid delivery status: ' + status);
    var normalized = String(updateId);
    return SheetRepositorySupport.withScriptLock(function () {
      var sheet = writableSheet();
      var rows = SheetRepositorySupport.rows(sheet);
      var index = rows.findIndex(function (row) { return String(row[0]) === normalized; });
      if (index < 0) throw new Error('Processed update not found: ' + normalized);
      sheet.getRange(index + 2, 3).setValue(status);
      return status;
    });
  }

  return Object.freeze({
    has: has,
    getDeliveryStatus: getDeliveryStatus,
    markProcessed: markProcessed,
    updateDeliveryStatus: updateDeliveryStatus
  });
}

if (typeof module !== 'undefined' && module.exports) module.exports = SheetProcessedUpdateRepository;
