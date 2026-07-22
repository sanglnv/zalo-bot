'use strict';

function mapperDependencies() {
  return typeof module !== 'undefined' && module.exports
    ? require('./mapInboundMessage')
    : ZaloInboundMapper;
}

function queryButton(button) {
  return {
    title: String(button.label || button.name || ''),
    type: 'oa.query.hide',
    payload: mapperDependencies().encodeQueryPayload({
      action: button.action || 'add_item',
      productId: button.productId,
      categoryId: button.categoryId,
      roomId: button.roomId,
      unit: button.unit,
      quantity: button.quantity
    })
  };
}

function renderOutboundMessage(message, userId) {
  if (!message || typeof message !== 'object' || !message.content) {
    throw new TypeError('OutboundMessage must contain content');
  }
  var id = String(userId);
  var content = message.content;
  var body = { recipient: { user_id: id }, message: {} };
  if (message.type === 'text') {
    if (typeof content.text !== 'string') throw new TypeError('text content.text must be a string');
    body.message.text = content.text;
  } else if (message.type === 'list') {
    if (!Array.isArray(content.items)) throw new TypeError('list content.items must be an array');
    body.message.text = typeof content.title === 'string' ? content.title : 'Danh mục món';
    body.message.attachment = {
      type: 'template',
      payload: {
        template_type: 'list',
        elements: content.items.map(function (product) {
          if (product.roomId != null) {
            return {
              title: product.name,
              subtitle: [product.pricePerHour != null ? String(product.pricePerHour) + '/giờ' : null,
                product.pricePerNight != null ? String(product.pricePerNight) + '/đêm' : null]
                .filter(Boolean).join(' · '),
              default_action: queryButton({ label: product.name, action: 'select_room', roomId: product.roomId })
            };
          }
          return {
            title: product.name,
            subtitle: String(product.price),
            default_action: queryButton({
              label: product.name,
              action: 'add_item',
              productId: product.productId,
              quantity: 1
            })
          };
        })
      }
    };
  } else if (message.type === 'button') {
    if (!Array.isArray(content.buttons)) throw new TypeError('button content.buttons must be an array');
    body.message.text = typeof content.text === 'string' ? content.text : '';
    if (content.buttons.length > 5) {
      // Zalo's button template hard-caps at 5. This happens in practice
      // once a shop has more than ~4 catalog categories (core always adds
      // a trailing "Giỏ hàng" button). Rather than crash (or silently drop
      // categories, which would make them permanently unreachable), degrade
      // to the list template -- same query payload per item via
      // default_action, but with no button-count limit.
      body.message.attachment = {
        type: 'template',
        payload: {
          template_type: 'list',
          elements: content.buttons.map(function (button) {
            return { title: String(button.label || ''), default_action: queryButton(button) };
          })
        }
      };
    } else {
      body.message.attachment = {
        type: 'template',
        payload: { buttons: content.buttons.map(queryButton) }
      };
    }
  } else if (message.type === 'image') {
    if (typeof content.data !== 'string' || !/^https?:\/\//.test(content.data)) {
      throw new TypeError('image content.data must be a direct HTTP(S) URL');
    }
    body.message.attachment = {
      type: 'template',
      payload: {
        template_type: 'media',
        elements: [{ media_type: 'image', url: content.data }]
      }
    };
  } else {
    throw new Error('Unsupported OutboundMessage type: ' + message.type);
  }
  return { method: 'sendCustomerServiceMessage', params: body };
}

var ZaloOutboundRenderer = Object.freeze({ renderOutboundMessage: renderOutboundMessage });
if (typeof module !== 'undefined' && module.exports) module.exports = ZaloOutboundRenderer;
