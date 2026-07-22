'use strict';

var RepositoryContracts = Object.freeze({
  order: Object.freeze(['save', 'findById', 'findByCustomerId', 'updateStatus']),
  room: Object.freeze(['list', 'findById']),
  booking: Object.freeze(['save', 'findById', 'findByCustomerId', 'updateStatus', 'findOverlapping']),
  customer: Object.freeze(['save', 'findById', 'findByPlatformUserId']),
  conversationState: Object.freeze(['get', 'set'])
});

/** @param {Object} repository @param {string[]} methods @param {string} name */
function assertRepository(repository, methods, name) {
  if (!repository || typeof repository !== 'object') throw new TypeError(name + ' is required');
  methods.forEach(function (method) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(name + ' must implement ' + method + '()');
    }
  });
}

var Repositories = Object.freeze({ contracts: RepositoryContracts, assert: assertRepository });

if (typeof module !== 'undefined' && module.exports) module.exports = Repositories;
