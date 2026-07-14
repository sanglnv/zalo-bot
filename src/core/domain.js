'use strict';

/**
 * @typedef {Object} PlatformLink
 * @property {string} platform
 * @property {string} platformUserId
 */

/**
 * @typedef {Object} Customer
 * @property {string} customerId
 * @property {string|null} phone
 * @property {string} displayName
 * @property {PlatformLink[]} platformLinks
 */

/**
 * @typedef {Object} Product
 * @property {string} productId
 * @property {string} name
 * @property {number} price
 * @property {boolean} isAvailable
 */

/**
 * @typedef {Object} OrderItem
 * @property {string} productId
 * @property {string} name
 * @property {number} unitPrice
 * @property {number} quantity
 */

/**
 * @typedef {Object} Order
 * @property {string} orderId
 * @property {string} customerId
 * @property {OrderItem[]} items
 * @property {string} status
 * @property {number} totalAmount
 * @property {string} createdAt ISO-8601 timestamp
 * @property {string} updatedAt ISO-8601 timestamp
 */

/**
 * @typedef {Object} Payment
 * @property {string} orderId
 * @property {string} qrContent
 * @property {number} amount
 * @property {string} status
 * @property {string|null} confirmedAt ISO-8601 timestamp
 * @property {string|null} confirmedBy
 */

/**
 * @typedef {Object} ConversationState
 * @property {string} customerId
 * @property {string} currentState
 * @property {Object} contextData
 * @property {string} updatedAt ISO-8601 timestamp
 */

/**
 * Normalized input contract. The core treats platform as an opaque adapter key.
 * @typedef {Object} InboundMessage
 * @property {string} platform
 * @property {string} platformUserId
 * @property {string} text
 * @property {Object|null} payload
 */

/**
 * @typedef {'text'|'list'|'button'|'image'} OutboundMessageType
 */

/**
 * @typedef {Object} OutboundMessage
 * @property {OutboundMessageType} type
 * @property {Object} content
 */

/** @param {unknown} value @param {string} name */
function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(name + ' must be a non-empty string');
  }
}

/** @param {InboundMessage} message @returns {InboundMessage} */
function validateInboundMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new TypeError('InboundMessage must be an object');
  }
  requireNonEmptyString(message.platform, 'platform');
  requireNonEmptyString(message.platformUserId, 'platformUserId');
  if (typeof message.text !== 'string') throw new TypeError('text must be a string');
  if (message.payload !== null &&
      (typeof message.payload !== 'object' || Array.isArray(message.payload))) {
    throw new TypeError('payload must be an object or null');
  }
  return message;
}

var Domain = Object.freeze({ validateInboundMessage: validateInboundMessage });

if (typeof module !== 'undefined' && module.exports) module.exports = Domain;
