'use strict';

function SheetConversationStateRepository() {
  var SHEET = 'ConversationStates';
  var HEADERS = ['customerId', 'currentState', 'contextDataJson', 'updatedAt'];

  function fromRow(row) {
    return { customerId: String(row[0]), currentState: String(row[1]),
      contextData: JSON.parse(row[2] || '{}'), updatedAt: String(row[3]) };
  }

  function get(customerId) {
    var row = SheetRepositorySupport.rows(SheetRepositorySupport.readSheet(SHEET))
      .find(function (candidate) { return String(candidate[0]) === customerId; });
    return row ? fromRow(row) : null;
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
      return state;
    });
  }

  return Object.freeze({ get: get, set: set });
}

if (typeof module !== 'undefined' && module.exports) module.exports = SheetConversationStateRepository;
