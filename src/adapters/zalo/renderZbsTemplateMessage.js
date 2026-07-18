'use strict';

function renderZbsTemplateMessage(message, userId, templateIds) {
  if (!message || message.type !== 'text' || !message.content ||
      typeof message.content.text !== 'string') {
    throw new TypeError('ZBS notification must be a normalized text message');
  }
  templateIds = templateIds || {};
  var expired = message.content.text.indexOf('đã hết hạn') >= 0;
  var paid = message.content.text.indexOf('Đã xác nhận thanh toán') === 0 ||
    message.content.text.indexOf('Payment confirmed') === 0;
  if (!expired && !paid) throw new Error('No ZBS template mapping for notification');
  var templateId = expired ? templateIds.expired : templateIds.paymentConfirmed;
  if (!templateId) throw new Error('Missing ZBS template id for ' + (expired ? 'expiry' : 'payment confirmation'));
  return {
    method: 'sendZbsTemplate',
    params: {
      user_id: String(userId),
      template_id: String(templateId),
      template_data: {
        order_id: String(message.content.orderId || ''),
        message: message.content.text
      }
    }
  };
}

var ZbsTemplateRenderer = Object.freeze({ renderZbsTemplateMessage: renderZbsTemplateMessage });
if (typeof module !== 'undefined' && module.exports) module.exports = ZbsTemplateRenderer;
