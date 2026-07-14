'use strict';

var ZALO_QUERY_PREFIX = 'zc:';
var ZALO_QUERY_PAYLOAD_MAX_BYTES = 1000;

function utf8ByteLength(value) {
  return unescape(encodeURIComponent(value)).length;
}

function encodeQueryPayload(payload) {
  if (!payload || typeof payload.action !== 'string' || payload.action === '') {
    throw new TypeError('Zalo query payload action must be a non-empty string');
  }
  var parts = [encodeURIComponent(payload.action)];
  if (payload.productId != null) parts.push(encodeURIComponent(String(payload.productId)));
  if (payload.quantity != null) {
    if (!Number.isInteger(payload.quantity) || payload.quantity <= 0) {
      throw new TypeError('Zalo query payload quantity must be a positive integer');
    }
    if (payload.productId == null) throw new TypeError('Zalo query payload quantity requires productId');
    parts.push(String(payload.quantity));
  }
  var encoded = ZALO_QUERY_PREFIX + parts.join(':');
  // Zalo documents a 1,000-character limit. Enforcing the same number of
  // UTF-8 bytes is intentionally stricter and prevents multi-byte overflow.
  if (utf8ByteLength(encoded) > ZALO_QUERY_PAYLOAD_MAX_BYTES) {
    throw new RangeError('Zalo query payload exceeds 1000 UTF-8 bytes');
  }
  return encoded;
}

function decodeQueryPayload(value) {
  if (typeof value !== 'string' || value.indexOf(ZALO_QUERY_PREFIX) !== 0) return null;
  if (utf8ByteLength(value) > ZALO_QUERY_PAYLOAD_MAX_BYTES) {
    throw new RangeError('Zalo query payload exceeds 1000 UTF-8 bytes');
  }
  var parts = value.slice(ZALO_QUERY_PREFIX.length).split(':');
  var action;
  var productId;
  try {
    action = decodeURIComponent(parts[0]);
    productId = parts.length > 1 ? decodeURIComponent(parts[1]) : undefined;
  } catch (error) {
    throw new Error('Zalo query payload contains invalid encoding');
  }
  if (!action) throw new Error('Zalo query payload action is missing');
  if (action === 'add_item' || action === 'decrease_item' || action === 'remove_item') {
    if (!productId) throw new Error('add_item query payload requires productId');
    if (action !== 'add_item') {
      if (parts.length > 2) throw new Error('Invalid ' + action + ' Zalo query payload');
      return { action: action, productId: productId };
    }
    var quantity = parts.length < 3 || parts[2] === '' ? 1 : Number(parts[2]);
    if (!Number.isInteger(quantity) || quantity <= 0 || parts.length > 3) {
      throw new Error('Invalid add_item Zalo query payload');
    }
    return { action: action, productId: productId, quantity: quantity };
  }
  if (parts.length > 1) throw new Error('Zalo query action does not accept arguments: ' + action);
  return { action: action };
}

function mapInboundMessage(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('Zalo webhook event must be an object');
  }
  // oa.query.show/hide button clicks arrive as user_send_text. The compact
  // query string is therefore decoded from message.text, not a callback event.
  if (event.event_name !== 'user_send_text') return null;
  if (!event.sender || event.sender.id == null) throw new TypeError('Zalo event is missing sender.id');
  var text = event.message && typeof event.message.text === 'string' ? event.message.text : '';
  var payload = decodeQueryPayload(text);
  return {
    platform: 'zalo',
    platformUserId: String(event.sender.id),
    text: payload ? '' : text,
    payload: payload
  };
}

var ZaloInboundMapper = Object.freeze({
  QUERY_PREFIX: ZALO_QUERY_PREFIX,
  QUERY_PAYLOAD_MAX_BYTES: ZALO_QUERY_PAYLOAD_MAX_BYTES,
  encodeQueryPayload: encodeQueryPayload,
  decodeQueryPayload: decodeQueryPayload,
  mapInboundMessage: mapInboundMessage
});

if (typeof module !== 'undefined' && module.exports) module.exports = ZaloInboundMapper;
