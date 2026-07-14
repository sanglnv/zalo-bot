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
    body.message.text = typeof content.title === 'string' ? content.title : 'Catalog';
    body.message.attachment = {
      type: 'template',
      payload: {
        template_type: 'list',
        elements: content.items.map(function (product) {
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
    if (content.buttons.length > 5) throw new RangeError('Zalo supports at most 5 buttons');
    body.message.text = typeof content.text === 'string' ? content.text : '';
    body.message.attachment = {
      type: 'template',
      payload: { buttons: content.buttons.map(queryButton) }
    };
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
