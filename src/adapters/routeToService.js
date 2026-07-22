'use strict';

function serviceActionOf(message) {
  if (message.payload && typeof message.payload.action === 'string') return message.payload.action;
  var action = message.text.trim().toLowerCase().split(/\s+/)[0] || '';
  if (action.charAt(0) === '/') action = action.slice(1).split('@')[0];
  return action === 'phong' ? 'start_booking' : action;
}

function routeToService(dependencies, inbound) {
  if (!dependencies || !dependencies.orderService || !dependencies.bookingService) {
    throw new TypeError('orderService and bookingService are required');
  }
  if (serviceActionOf(inbound) === 'start_booking') return dependencies.bookingService;
  var customer = dependencies.customerRepository.findByPlatformUserId(inbound.platform, inbound.platformUserId);
  var state = customer ? dependencies.conversationStateRepository.get(customer.customerId) : null;
  return state && state.contextData && state.contextData.activeFlow === 'booking'
    ? dependencies.bookingService : dependencies.orderService;
}

var ServiceRouter = Object.freeze({ actionOf: serviceActionOf, routeToService: routeToService });
if (typeof module !== 'undefined' && module.exports) module.exports = ServiceRouter;
