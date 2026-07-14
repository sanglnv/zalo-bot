'use strict';

function telegramCallbackByteLength(value) {
  var encoded = encodeURIComponent(value);
  var bytes = 0;
  for (var index = 0; index < encoded.length; index += 1) {
    if (encoded[index] === '%') index += 2;
    bytes += 1;
  }
  return bytes;
}

/**
 * Encode a compact callback payload. Components are URI encoded so IDs may
 * safely contain separators while the final value remains under Telegram's
 * 64-byte callback_data limit.
 * @param {{action: string, productId?: string, quantity?: number}} payload
 * @returns {string}
 */
function encodeCallbackData(payload) {
  if (!payload || typeof payload.action !== 'string' || payload.action === '') {
    throw new TypeError('callback payload action must be a non-empty string');
  }
  var parts = [encodeURIComponent(payload.action)];
  if (payload.productId != null) parts.push(encodeURIComponent(String(payload.productId)));
  if (payload.quantity != null) {
    if (!Number.isInteger(payload.quantity) || payload.quantity <= 0) {
      throw new TypeError('callback payload quantity must be a positive integer');
    }
    if (payload.productId == null) throw new TypeError('callback payload quantity requires productId');
    parts.push(String(payload.quantity));
  }
  var encoded = parts.join(':');
  if (telegramCallbackByteLength(encoded) > 64) {
    throw new RangeError('callback_data exceeds Telegram 64-byte limit');
  }
  return encoded;
}

/** @param {string} data @returns {Object} */
function decodeCallbackData(data) {
  if (typeof data !== 'string' || data === '') throw new TypeError('callback_data must be a non-empty string');
  if (telegramCallbackByteLength(data) > 64) throw new RangeError('callback_data exceeds Telegram 64-byte limit');
  var parts = data.split(':');
  var action;
  var productId;
  try {
    action = decodeURIComponent(parts[0]);
    productId = parts.length > 1 ? decodeURIComponent(parts[1]) : undefined;
  } catch (error) {
    throw new Error('callback_data contains invalid encoding');
  }
  if (!action) throw new Error('callback_data action is missing');
  if (action === 'add_item') {
    if (!productId) throw new Error('add_item callback_data requires productId');
    var quantity = parts.length < 3 || parts[2] === '' ? 1 : Number(parts[2]);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error('add_item callback_data quantity must be a positive integer');
    }
    if (parts.length > 3) throw new Error('callback_data has too many components');
    return { action: action, productId: productId, quantity: quantity };
  }
  if (parts.length > 1) throw new Error('callback_data action does not accept arguments: ' + action);
  return { action: action };
}

function requireChatId(chat) {
  if (!chat || (typeof chat.id !== 'number' && typeof chat.id !== 'string')) {
    throw new TypeError('Telegram update is missing chat.id');
  }
  return String(chat.id);
}

/**
 * @param {Object} update Telegram webhook update
 * @returns {Object|null} normalized InboundMessage, or null for unsupported updates
 */
function mapInboundMessage(update) {
  if (!update || typeof update !== 'object' || Array.isArray(update)) {
    throw new TypeError('Telegram update must be an object');
  }
  if (update.message) {
    return {
      platform: 'telegram',
      platformUserId: requireChatId(update.message.chat),
      text: typeof update.message.text === 'string' ? update.message.text : '',
      payload: null
    };
  }
  if (update.callback_query) {
    var callback = update.callback_query;
    return {
      platform: 'telegram',
      platformUserId: requireChatId(callback.message && callback.message.chat),
      text: '',
      payload: decodeCallbackData(callback.data)
    };
  }
  return null;
}

var TelegramInboundMapper = Object.freeze({
  encodeCallbackData: encodeCallbackData,
  decodeCallbackData: decodeCallbackData,
  mapInboundMessage: mapInboundMessage
});

if (typeof module !== 'undefined' && module.exports) module.exports = TelegramInboundMapper;
