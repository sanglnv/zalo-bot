'use strict';

function SheetErrorLogRepository() {
  var SHEET = 'ErrorLogs';
  var HEADERS = ['timestamp', 'context', 'message', 'stack'];

  function log(entry) {
    return SheetRepositorySupport.withScriptLock(function () {
      var sheet = SheetRepositorySupport.writableSheet(SHEET, HEADERS);
      sheet.appendRow([
        entry.timestamp,
        typeof entry.context === 'string' ? entry.context : JSON.stringify(entry.context || {}),
        entry.message || '',
        entry.stack || ''
      ]);
      return entry;
    });
  }

  return Object.freeze({ log: log });
}

if (typeof module !== 'undefined' && module.exports) module.exports = SheetErrorLogRepository;
