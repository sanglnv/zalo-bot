'use strict';

var SheetRepositorySupport = (function () {
  var LOCK_TIMEOUT_MS = 30000;
  var LOCK_WARN_MS = 1000;
  var lockDepth = 0;

  function spreadsheet() {
    var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (!id) throw new Error('Missing required script property: SPREADSHEET_ID');
    return SpreadsheetApp.openById(id);
  }

  function readSheet(name) {
    return spreadsheet().getSheetByName(name);
  }

  function writableSheet(name, headers) {
    var book = spreadsheet();
    var sheet = book.getSheetByName(name) || book.insertSheet(name);
    if (sheet.getLastRow() === 0) sheet.appendRow(headers);
    return sheet;
  }

  function withScriptLock(operation) {
    if (lockDepth > 0) {
      lockDepth += 1;
      try {
        return operation();
      } finally {
        lockDepth -= 1;
      }
    }
    var lock = LockService.getScriptLock();
    // Also support an outer runtime lock acquired outside this helper.
    if (typeof lock.hasLock === 'function' && lock.hasLock()) return operation();
    var waitStartedAt = Date.now();
    if (!lock.tryLock(LOCK_TIMEOUT_MS)) throw new Error('Could not acquire script lock within 30 seconds');
    var waitMs = Math.max(0, Date.now() - waitStartedAt);
    if (waitMs >= LOCK_WARN_MS && typeof console !== 'undefined' && console.warn) {
      console.warn(JSON.stringify({ event: 'script_lock_contention', waitMs: waitMs }));
    }
    lockDepth = 1;
    try {
      return operation();
    } finally {
      lockDepth = 0;
      lock.releaseLock();
    }
  }

  function rows(sheet) {
    if (!sheet || sheet.getLastRow() < 2) return [];
    return sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  }

  return Object.freeze({
    readSheet: readSheet,
    writableSheet: writableSheet,
    withScriptLock: withScriptLock,
    rows: rows
  });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SheetRepositorySupport;
