'use strict';

function SheetOperationMetricsRepository() {
  var SHEET = 'OperationMetrics';
  var HEADERS = ['timestamp', 'operation', 'durationMs'];

  function record(entry) {
    return SheetRepositorySupport.withScriptLock(function () {
      var sheet = SheetRepositorySupport.writableSheet(SHEET, HEADERS);
      sheet.appendRow([entry.timestamp, entry.operation, entry.durationMs]);
      return entry;
    });
  }

  return Object.freeze({ record: record });
}

if (typeof module !== 'undefined' && module.exports) module.exports = SheetOperationMetricsRepository;
