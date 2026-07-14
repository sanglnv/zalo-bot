'use strict';

function SheetOrderRepository() {
  var SHEET = 'Orders';
  var HEADERS = [
    'orderId', 'customerId', 'itemsJson', 'status', 'totalAmount',
    'createdAt', 'updatedAt', 'confirmedAt', 'confirmedBy'
  ];

  function writableSheet() {
    var sheet = SheetRepositorySupport.writableSheet(SHEET, HEADERS);
    ['confirmedAt', 'confirmedBy'].forEach(function (header, offset) {
      var column = 8 + offset;
      if (sheet.getRange(1, column).getValue() !== header) {
        sheet.getRange(1, column).setValue(header);
      }
    });
    return sheet;
  }

  function fromRow(row) {
    return {
      orderId: String(row[0]), customerId: String(row[1]), items: JSON.parse(row[2]),
      status: String(row[3]), totalAmount: Number(row[4]), createdAt: String(row[5]),
      updatedAt: String(row[6]), confirmedAt: row[7] ? String(row[7]) : null,
      confirmedBy: row[8] ? String(row[8]) : null
    };
  }

  function save(order) {
    return SheetRepositorySupport.withScriptLock(function () {
      var sheet = writableSheet();
      var all = SheetRepositorySupport.rows(sheet);
      var index = all.findIndex(function (row) { return String(row[0]) === order.orderId; });
      var values = [[order.orderId, order.customerId, JSON.stringify(order.items), order.status,
        order.totalAmount, order.createdAt, order.updatedAt, order.confirmedAt || '', order.confirmedBy || '']];
      if (index < 0) sheet.appendRow(values[0]);
      else sheet.getRange(index + 2, 1, 1, HEADERS.length).setValues(values);
      return order;
    });
  }

  function findById(orderId) {
    var row = SheetRepositorySupport.rows(SheetRepositorySupport.readSheet(SHEET))
      .find(function (candidate) { return String(candidate[0]) === orderId; });
    return row ? fromRow(row) : null;
  }

  function findByCustomerId(customerId) {
    return SheetRepositorySupport.rows(SheetRepositorySupport.readSheet(SHEET))
      .filter(function (row) { return String(row[1]) === customerId; }).map(fromRow);
  }

  function findAwaitingPaymentOlderThan(cutoffIso, limit) {
    var cutoff = new Date(cutoffIso).getTime();
    if (!Number.isFinite(cutoff)) throw new TypeError('cutoffIso must be a valid timestamp');
    if (!Number.isInteger(limit) || limit <= 0) throw new TypeError('limit must be a positive integer');
    return SheetRepositorySupport.rows(SheetRepositorySupport.readSheet(SHEET))
      .map(fromRow)
      .filter(function (order) {
        var createdAt = new Date(order.createdAt).getTime();
        return order.status === 'AWAITING_PAYMENT' && Number.isFinite(createdAt) && createdAt < cutoff;
      })
      .sort(function (left, right) {
        return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
      })
      .slice(0, limit);
  }

  function updateStatus(orderId, status) {
    return SheetRepositorySupport.withScriptLock(function () {
      var sheet = SheetRepositorySupport.readSheet(SHEET);
      var all = SheetRepositorySupport.rows(sheet);
      var index = all.findIndex(function (row) { return String(row[0]) === orderId; });
      if (index < 0) throw new Error('Order not found: ' + orderId);
      sheet.getRange(index + 2, 4).setValue(status);
      sheet.getRange(index + 2, 7).setValue(new Date().toISOString());
      return true;
    });
  }

  return Object.freeze({
    save: save,
    findById: findById,
    findByCustomerId: findByCustomerId,
    findAwaitingPaymentOlderThan: findAwaitingPaymentOlderThan,
    updateStatus: updateStatus
  });
}

if (typeof module !== 'undefined' && module.exports) module.exports = SheetOrderRepository;
