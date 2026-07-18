'use strict';

function SheetCustomerRepository() {
  var SHEET = 'Customers';
  var HEADERS = ['customerId', 'phone', 'displayName', 'platformLinksJson', 'memberId'];
  var CACHE_TTL_SECONDS = 300;

  function cache() {
    return typeof CacheService === 'undefined' ? null : CacheService.getScriptCache();
  }

  function platformCacheKey(platform, platformUserId) {
    return 'customer:' + String(platform) + ':' + String(platformUserId);
  }

  function customerCacheKey(customerId) { return 'customer:id:' + String(customerId); }

  function cachePlatformLinks(customer) {
    var scriptCache = cache();
    if (!scriptCache) return;
    scriptCache.put(
      customerCacheKey(customer.customerId),
      JSON.stringify(customer),
      CACHE_TTL_SECONDS
    );
    (customer.platformLinks || []).forEach(function (link) {
      scriptCache.put(
        platformCacheKey(link.platform, link.platformUserId),
        String(customer.customerId),
        CACHE_TTL_SECONDS
      );
    });
  }

  function fromRow(row) {
    return { customerId: String(row[0]), phone: row[1] ? String(row[1]) : null,
      displayName: String(row[2] || ''), platformLinks: JSON.parse(row[3] || '[]'),
      memberId: row[4] ? String(row[4]) : null };
  }

  function save(customer) {
    return SheetRepositorySupport.withScriptLock(function () {
      var sheet = SheetRepositorySupport.writableSheet(SHEET, HEADERS);
      var all = SheetRepositorySupport.rows(sheet);
      var index = all.findIndex(function (row) { return String(row[0]) === customer.customerId; });
      var previous = index < 0 ? null : fromRow(all[index]);
      var values = [[customer.customerId, customer.phone || '', customer.displayName || '',
        JSON.stringify(customer.platformLinks || []), customer.memberId || '']];
      if (index < 0) sheet.appendRow(values[0]);
      else sheet.getRange(index + 2, 1, 1, HEADERS.length).setValues(values);
      var scriptCache = cache();
      if (scriptCache && previous) {
        scriptCache.remove(customerCacheKey(previous.customerId));
        previous.platformLinks.forEach(function (link) {
          scriptCache.remove(platformCacheKey(link.platform, link.platformUserId));
        });
      }
      cachePlatformLinks(customer);
      return customer;
    });
  }

  function findById(customerId) {
    var normalized = String(customerId);
    var scriptCache = cache();
    var cached = scriptCache ? scriptCache.get(customerCacheKey(normalized)) : null;
    if (cached) {
      try { return JSON.parse(cached); } catch (ignore) { scriptCache.remove(customerCacheKey(normalized)); }
    }
    var row = SheetRepositorySupport.rows(SheetRepositorySupport.readSheet(SHEET))
      .find(function (candidate) { return String(candidate[0]) === normalized; });
    var customer = row ? fromRow(row) : null;
    if (customer) cachePlatformLinks(customer);
    return customer;
  }

  function findByPlatformUserId(platform, platformUserId) {
    var scriptCache = cache();
    var key = platformCacheKey(platform, platformUserId);
    var cachedCustomerId = scriptCache ? scriptCache.get(key) : null;
    if (cachedCustomerId) {
      var cachedCustomer = findById(cachedCustomerId);
      if (cachedCustomer && cachedCustomer.platformLinks.some(function (link) {
        return link.platform === platform && link.platformUserId === platformUserId;
      })) return cachedCustomer;
      // Cache entries are only hints and may outlive manual Sheet edits.
      scriptCache.remove(key);
    }
    var customer = SheetRepositorySupport.rows(SheetRepositorySupport.readSheet(SHEET)).map(fromRow)
      .find(function (candidate) {
        return candidate.platformLinks.some(function (link) {
          return link.platform === platform && link.platformUserId === platformUserId;
        });
      });
    if (customer) cachePlatformLinks(customer);
    return customer || null;
  }

  return Object.freeze({ save: save, findById: findById, findByPlatformUserId: findByPlatformUserId });
}

if (typeof module !== 'undefined' && module.exports) module.exports = SheetCustomerRepository;
