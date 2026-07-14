'use strict';

function SheetCustomerRepository() {
  var SHEET = 'Customers';
  var HEADERS = ['customerId', 'phone', 'displayName', 'platformLinksJson'];

  function fromRow(row) {
    return { customerId: String(row[0]), phone: row[1] ? String(row[1]) : null,
      displayName: String(row[2] || ''), platformLinks: JSON.parse(row[3] || '[]') };
  }

  function save(customer) {
    return SheetRepositorySupport.withScriptLock(function () {
      var sheet = SheetRepositorySupport.writableSheet(SHEET, HEADERS);
      var all = SheetRepositorySupport.rows(sheet);
      var index = all.findIndex(function (row) { return String(row[0]) === customer.customerId; });
      var values = [[customer.customerId, customer.phone || '', customer.displayName || '',
        JSON.stringify(customer.platformLinks || [])]];
      if (index < 0) sheet.appendRow(values[0]);
      else sheet.getRange(index + 2, 1, 1, HEADERS.length).setValues(values);
      return customer;
    });
  }

  function findById(customerId) {
    var row = SheetRepositorySupport.rows(SheetRepositorySupport.readSheet(SHEET))
      .find(function (candidate) { return String(candidate[0]) === customerId; });
    return row ? fromRow(row) : null;
  }

  function findByPlatformUserId(platform, platformUserId) {
    var customer = SheetRepositorySupport.rows(SheetRepositorySupport.readSheet(SHEET)).map(fromRow)
      .find(function (candidate) {
        return candidate.platformLinks.some(function (link) {
          return link.platform === platform && link.platformUserId === platformUserId;
        });
      });
    return customer || null;
  }

  return Object.freeze({ save: save, findById: findById, findByPlatformUserId: findByPlatformUserId });
}

if (typeof module !== 'undefined' && module.exports) module.exports = SheetCustomerRepository;
