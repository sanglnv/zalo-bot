'use strict';

function SheetConversationStateRepository() {
  var SHEET = 'ConversationStates';
  var HEADERS = ['customerId', 'currentState', 'contextDataJson', 'updatedAt'];
  var CACHE_TTL_SECONDS = 300;

  function cache() {
    return typeof CacheService === 'undefined' ? null : CacheService.getScriptCache();
  }

  function cacheKey(customerId) { return 'conversation-state:' + String(customerId); }

  function cacheState(state) {
    var scriptCache = cache();
    if (scriptCache) scriptCache.put(cacheKey(state.customerId), JSON.stringify(state), CACHE_TTL_SECONDS);
  }

  function fromRow(row) {
    return { customerId: String(row[0]), currentState: String(row[1]),
      contextData: JSON.parse(row[2] || '{}'), updatedAt: String(row[3]) };
  }

  function get(customerId) {
    var normalized = String(customerId);
    var scriptCache = cache();
    var cached = scriptCache ? scriptCache.get(cacheKey(normalized)) : null;
    if (cached) {
      try { return JSON.parse(cached); } catch (ignore) { scriptCache.remove(cacheKey(normalized)); }
    }
    var row = SheetRepositorySupport.rows(SheetRepositorySupport.readSheet(SHEET))
      .find(function (candidate) { return String(candidate[0]) === normalized; });
    var state = row ? fromRow(row) : null;
    if (state) cacheState(state);
    return state;
  }

  function set(customerId, state) {
    if (customerId !== state.customerId) throw new Error('Conversation state customerId mismatch');
    return SheetRepositorySupport.withScriptLock(function () {
      var sheet = SheetRepositorySupport.writableSheet(SHEET, HEADERS);
      var all = SheetRepositorySupport.rows(sheet);
      var index = all.findIndex(function (row) { return String(row[0]) === customerId; });
      var values = [[customerId, state.currentState, JSON.stringify(state.contextData), state.updatedAt]];
      if (index < 0) sheet.appendRow(values[0]);
      else sheet.getRange(index + 2, 1, 1, HEADERS.length).setValues(values);
      cacheState(state);
      return state;
    });
  }

  return Object.freeze({ get: get, set: set });
}

if (typeof module !== 'undefined' && module.exports) module.exports = SheetConversationStateRepository;
