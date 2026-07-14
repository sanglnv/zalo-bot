'use strict';

function recordDuration(operation, fn) {
  if (typeof operation !== 'string' || !operation) throw new TypeError('operation is required');
  if (typeof fn !== 'function') throw new TypeError('fn must be a function');
  var startedAt = Date.now();
  try {
    return fn();
  } finally {
    var finishedAt = Date.now();
    try {
      SheetOperationMetricsRepository().record({
        timestamp: new Date(finishedAt).toISOString(),
        operation: operation,
        durationMs: Math.max(0, finishedAt - startedAt)
      });
    } catch (error) {
      if (typeof console !== 'undefined' && console.error) console.error(error);
    }
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { recordDuration: recordDuration };
