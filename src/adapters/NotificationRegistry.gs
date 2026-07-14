'use strict';

function buildNotificationRegistry() {
  var properties = PropertiesService.getScriptProperties();
  var tokenManager = ZaloTokenManager.createDefault();
  return {
    telegram: {
      renderOutboundMessage: TelegramOutboundRenderer.renderOutboundMessage,
      client: TelegramClient.create()
    },
    zalo: {
      // Scheduled expiry and staff payment confirmation are not direct chat
      // replies. They intentionally use approved ZBS templates, while the
      // webhook uses ZaloClient and the normal customer-service Send API.
      renderOutboundMessage: function (message, userId) {
        return ZbsTemplateRenderer.renderZbsTemplateMessage(message, userId, {
          paymentConfirmed: properties.getProperty('ZALO_ZBS_PAYMENT_CONFIRMED_TEMPLATE_ID'),
          expired: properties.getProperty('ZALO_ZBS_ORDER_EXPIRED_TEMPLATE_ID')
        });
      },
      client: ZbsTemplateClient.create(tokenManager)
    }
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = buildNotificationRegistry;
