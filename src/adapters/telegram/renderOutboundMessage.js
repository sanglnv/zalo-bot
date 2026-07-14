'use strict';

function telegramRendererDependencies() {
  return typeof module !== 'undefined' && module.exports
    ? require('./mapInboundMessage')
    : TelegramInboundMapper;
}

function buttonPayload(button) {
  var payload = { action: button.action };
  if (button.productId != null) payload.productId = button.productId;
  if (button.quantity != null) payload.quantity = button.quantity;
  return payload;
}

/**
 * Pure conversion from a core OutboundMessage to a Telegram Bot API command.
 * @param {{type: string, content: Object}} message
 * @param {string|number} chatId
 * @returns {{method: string, params: Object}}
 */
function renderOutboundMessage(message, chatId) {
  if (!message || typeof message !== 'object' || !message.content) {
    throw new TypeError('OutboundMessage must contain content');
  }
  var id = String(chatId);
  var content = message.content;
  if (message.type === 'text') {
    if (typeof content.text !== 'string') throw new TypeError('text message content.text must be a string');
    return { method: 'sendMessage', params: { chat_id: id, text: content.text } };
  }
  if (message.type === 'list') {
    if (!Array.isArray(content.items)) throw new TypeError('list message content.items must be an array');
    return {
      method: 'sendMessage',
      params: {
        chat_id: id,
        text: typeof content.title === 'string' ? content.title : 'Catalog',
        reply_markup: {
          inline_keyboard: content.items.map(function (product) {
            return [{
              text: product.name + ' — ' + product.price,
              callback_data: telegramRendererDependencies().encodeCallbackData({
                action: 'add_item', productId: product.productId, quantity: 1
              })
            }];
          })
        }
      }
    };
  }
  if (message.type === 'button') {
    if (!Array.isArray(content.buttons)) throw new TypeError('button message content.buttons must be an array');
    return {
      method: 'sendMessage',
      params: {
        chat_id: id,
        text: typeof content.text === 'string' ? content.text : '',
        reply_markup: {
          inline_keyboard: [content.buttons.map(function (button) {
            return {
              text: button.label,
              callback_data: telegramRendererDependencies().encodeCallbackData(buttonPayload(button))
            };
          })]
        }
      }
    };
  }
  if (message.type === 'image') {
    if (typeof content.data !== 'string' || !/^https?:\/\//.test(content.data)) {
      throw new TypeError('image message content.data must be a direct HTTP(S) URL');
    }
    return { method: 'sendPhoto', params: { chat_id: id, photo: content.data } };
  }
  throw new Error('Unsupported OutboundMessage type: ' + message.type);
}

var TelegramOutboundRenderer = Object.freeze({ renderOutboundMessage: renderOutboundMessage });

if (typeof module !== 'undefined' && module.exports) module.exports = TelegramOutboundRenderer;
