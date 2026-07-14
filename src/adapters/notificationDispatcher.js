'use strict';

/**
 * Dispatch normalized messages to every recognized customer platform link.
 * Unknown platforms are intentionally skipped for forward compatibility.
 * @param {Object} customer
 * @param {Object[]} outboundMessages
 * @param {Object} registry
 * @returns {Object[]}
 */
function dispatchNotifications(customer, outboundMessages, registry) {
  if (!Array.isArray(outboundMessages)) throw new TypeError('outboundMessages must be an array');
  registry = registry || {};
  var results = [];
  var links = customer && Array.isArray(customer.platformLinks) ? customer.platformLinks : [];
  links.forEach(function (link) {
    var entry = registry[link.platform];
    if (!entry) {
      results.push({ platform: link.platform, skipped: true });
      return;
    }
    if (!entry.client || typeof entry.client.execute !== 'function' ||
        typeof entry.renderOutboundMessage !== 'function') {
      throw new TypeError('Invalid notification registry entry: ' + link.platform);
    }
    outboundMessages.forEach(function (message) {
      entry.client.execute(entry.renderOutboundMessage(message, link.platformUserId));
    });
    results.push({ platform: link.platform, skipped: false });
  });
  return results;
}

var NotificationDispatcher = Object.freeze({ dispatchNotifications: dispatchNotifications });

if (typeof module !== 'undefined' && module.exports) module.exports = NotificationDispatcher;
