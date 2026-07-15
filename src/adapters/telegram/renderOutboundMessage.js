'use strict';

function telegramRendererDependencies() {
  return typeof module !== 'undefined' && module.exports
    ? require('./mapInboundMessage.js')
    : TelegramInboundMapper;
}

function buttonPayload(button) {
  var payload = { action: button.action };
  if (button.productId != null) payload.productId = button.productId;
  if (button.categoryId != null) payload.categoryId = button.categoryId;
  if (button.quantity != null) payload.quantity = button.quantity;
  return payload;
}

function formatPrice(value) {
  return String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' ₫';
}

/**
 * Pure conversion from a core OutboundMessage to a Telegram Bot API command.
 * @param {{type: string, content: Object}} message
 * @param {string|number} chatId
 * @param {{encodeCallbackData: function({action: string, productId?: string, categoryId?: string, quantity?: number}): string}=} inboundMapper
 * @returns {{method: string, params: Object}}
 */
function renderOutboundMessage(message, chatId, inboundMapper) {
  if (!message || typeof message !== 'object' || !message.content) {
    throw new TypeError('OutboundMessage must contain content');
  }
  var id = String(chatId);
  var content = message.content;
  var mapper = inboundMapper || telegramRendererDependencies();
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
              text: product.name + ' — ' + formatPrice(product.price),
              callback_data: mapper.encodeCallbackData({
                action: 'view_product', productId: product.productId
              })
            }];
          }).concat(Array.isArray(content.buttons) ? [content.buttons.map(function (button) {
            return {
              text: button.label,
              callback_data: mapper.encodeCallbackData(buttonPayload(button))
            };
          })] : [])
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
          inline_keyboard: content.buttons.reduce(function (rows, button, index) {
            if (index % 2 === 0) rows.push([]);
            rows[rows.length - 1].push({
              text: button.label,
              callback_data: mapper.encodeCallbackData(buttonPayload(button))
            });
            return rows;
          }, [])
        }
      }
    };
  }
  if (message.type === 'image') {
    if (typeof content.data !== 'string' || !/^https?:\/\//.test(content.data)) {
      throw new TypeError('image message content.data must be a direct HTTP(S) URL');
    }
    var photoParams = { chat_id: id, photo: content.data };
    if (typeof content.caption === 'string' && content.caption) photoParams.caption = content.caption;
    return { method: 'sendPhoto', params: photoParams };
  }
  throw new Error('Unsupported OutboundMessage type: ' + message.type);
}

var TelegramOutboundRenderer = Object.freeze({ renderOutboundMessage: renderOutboundMessage });

if (typeof module !== 'undefined' && module.exports) module.exports = TelegramOutboundRenderer;
