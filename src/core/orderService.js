'use strict';

function orderServiceDependencies() {
  return typeof module !== 'undefined' && module.exports ? {
      Domain: require('./domain'),
      StateMachine: require('./stateMachine'),
      Billing: require('./billing'),
      Repositories: require('./repositoryContracts')
    } : { Domain: Domain, StateMachine: StateMachine, Billing: Billing, Repositories: Repositories };
}

/** @param {string} type @param {Object} content */
function outbound(type, content) {
  return { type: type, content: content };
}

function OrderNotFoundError(orderId) {
  this.name = 'OrderNotFoundError';
  this.code = 'ORDER_NOT_FOUND';
  this.orderId = orderId;
  this.message = 'Order not found: ' + orderId;
  if (Error.captureStackTrace) Error.captureStackTrace(this, OrderNotFoundError);
}
OrderNotFoundError.prototype = Object.create(Error.prototype);
OrderNotFoundError.prototype.constructor = OrderNotFoundError;

function PaymentAlreadyResolvedError(orderId, status) {
  this.name = 'PaymentAlreadyResolvedError';
  this.code = 'PAYMENT_ALREADY_RESOLVED';
  this.orderId = orderId;
  this.status = status;
  this.message = 'Payment is already resolved or not awaiting payment for order ' + orderId;
  if (Error.captureStackTrace) Error.captureStackTrace(this, PaymentAlreadyResolvedError);
}
PaymentAlreadyResolvedError.prototype = Object.create(Error.prototype);
PaymentAlreadyResolvedError.prototype.constructor = PaymentAlreadyResolvedError;

/**
 * Create the platform-neutral order application service.
 * All side effects enter through injected dependencies.
 *
 * @param {Object} dependencies
 * @param {Object} dependencies.orderRepository
 * @param {Object} dependencies.customerRepository
 * @param {Object} dependencies.conversationStateRepository
 * @param {function(): import('./domain').Product[]} dependencies.getCatalog
 * @param {function(Object): string} dependencies.createQrContent
 * @param {function(): string} dependencies.createId
 * @param {function(): Date} dependencies.now
 * @param {function(function(): *): *} dependencies.withLock Runs one complete message transaction under a lock
 * @returns {{handleMessage: function(import('./domain').InboundMessage): import('./domain').OutboundMessage[], confirmPayment: function(string, string): Object, expireOrder: function(string): Object}}
 */
function createOrderService(dependencies) {
  var d = orderServiceDependencies();
  dependencies = dependencies || {};
  d.Repositories.assert(dependencies.orderRepository, d.Repositories.contracts.order, 'orderRepository');
  d.Repositories.assert(dependencies.customerRepository, d.Repositories.contracts.customer, 'customerRepository');
  d.Repositories.assert(
    dependencies.conversationStateRepository,
    d.Repositories.contracts.conversationState,
    'conversationStateRepository'
  );
  ['getCatalog', 'createQrContent', 'createId', 'now', 'withLock'].forEach(function (name) {
    if (typeof dependencies[name] !== 'function') throw new TypeError(name + ' must be a function');
  });

  function getOrCreateCustomer(message) {
    var customer = dependencies.customerRepository.findByPlatformUserId(
      message.platform,
      message.platformUserId
    );
    if (customer) return customer;
    customer = {
      customerId: dependencies.createId(),
      phone: null,
      displayName: '',
      platformLinks: [{ platform: message.platform, platformUserId: message.platformUserId }]
    };
    dependencies.customerRepository.save(customer);
    return customer;
  }

  function loadState(customerId) {
    return dependencies.conversationStateRepository.get(customerId) || {
      customerId: customerId,
      currentState: d.StateMachine.States.IDLE,
      contextData: { cart: [] },
      updatedAt: dependencies.now().toISOString()
    };
  }

  function prepareTransition(state, event, patch) {
    var result = d.StateMachine.transition(state.currentState, event, state.contextData);
    return {
      customerId: state.customerId,
      currentState: result.nextState,
      contextData: Object.assign({}, result.newContextData, patch || {}),
      updatedAt: dependencies.now().toISOString()
    };
  }

  function persistState(next) {
    dependencies.conversationStateRepository.set(next.customerId, next);
    return next;
  }

  function persistTransition(state, event, patch) {
    return persistState(prepareTransition(state, event, patch));
  }

  function availableCatalog() {
    var products = dependencies.getCatalog();
    if (!Array.isArray(products)) throw new TypeError('getCatalog() must return an array');
    return products.filter(function (product) { return product.isAvailable; });
  }

  function actionOf(message) {
    if (message.payload && typeof message.payload.action === 'string') return message.payload.action;
    return message.text.trim().toLowerCase();
  }

  /** @param {import('./domain').InboundMessage} message */
  function handleMessageTransaction(message) {
    d.Domain.validateInboundMessage(message);
    var customer = getOrCreateCustomer(message);
    var state = loadState(customer.customerId);
    var action = actionOf(message);

    if (action === 'catalog' || action === 'browse') {
      state = persistTransition(state, d.StateMachine.Events.START_BROWSING);
      return [outbound('list', { title: 'Catalog', items: availableCatalog() })];
    }

    if (action === 'add_item') {
      var productId = message.payload && message.payload.productId;
      var quantity = message.payload && message.payload.quantity == null ? 1 : message.payload.quantity;
      if (!Number.isInteger(quantity) || quantity <= 0) throw new TypeError('quantity must be a positive integer');
      var product = availableCatalog().find(function (item) { return item.productId === productId; });
      if (!product) throw new Error('Product is unavailable or does not exist: ' + productId);
      var cart = (state.contextData.cart || []).map(function (item) { return Object.assign({}, item); });
      var existing = cart.find(function (item) { return item.productId === product.productId; });
      if (existing) existing.quantity += quantity;
      else cart.push({
        productId: product.productId,
        name: product.name,
        unitPrice: product.price,
        quantity: quantity
      });
      state = persistTransition(state, d.StateMachine.Events.ADD_TO_CART, { cart: cart });
      return [outbound('text', { text: product.name + ' added to cart.', cart: cart })];
    }

    if (action === 'checkout') {
      var checkoutCart = state.contextData.cart || [];
      if (checkoutCart.length === 0) throw new Error('Cannot check out an empty cart');
      var preview = d.Billing.calculateBill(checkoutCart, state.contextData.discount || null);
      state = persistTransition(state, d.StateMachine.Events.REVIEW_CART, { bill: preview });
      return [outbound('button', {
        text: 'Confirm order',
        summary: preview,
        buttons: [{ action: 'confirm_order', label: 'Confirm' }, { action: 'cancel', label: 'Cancel' }]
      })];
    }

    if (action === 'confirm_order') {
      // Validate the transition before creating an order. This makes a replay
      // harmless after the outer lock has serialized it behind the first request.
      var preparedState = prepareTransition(state, d.StateMachine.Events.CONFIRM_ORDER);
      var bill = d.Billing.calculateBill(state.contextData.cart || [], state.contextData.discount || null);
      var timestamp = dependencies.now().toISOString();
      var order = {
        orderId: dependencies.createId(),
        customerId: customer.customerId,
        items: (state.contextData.cart || []).map(function (item) { return Object.assign({}, item); }),
        status: 'AWAITING_PAYMENT',
        totalAmount: bill.totalAmount,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      if (order.items.length === 0) throw new Error('Cannot confirm an empty cart');
      dependencies.orderRepository.save(order);
      preparedState.contextData = Object.assign({}, preparedState.contextData, {
        orderId: order.orderId, bill: bill
      });
      state = persistState(preparedState);
      var qrContent = dependencies.createQrContent(order);
      return [
        outbound('text', { text: 'Order confirmed.', orderId: order.orderId, amount: order.totalAmount }),
        outbound('image', { purpose: 'payment_qr', data: qrContent, orderId: order.orderId })
      ];
    }

    if (action === 'cancel') {
      var cancelledState = prepareTransition(state, d.StateMachine.Events.CANCEL);
      if (cancelledState.contextData.orderId) {
        dependencies.orderRepository.updateStatus(cancelledState.contextData.orderId, 'CANCELLED');
      }
      state = persistState(cancelledState);
      return [outbound('text', { text: 'Order cancelled.' })];
    }

    throw new Error('Unsupported action: ' + action);
  }

  function handleMessage(message) {
    return dependencies.withLock(function () { return handleMessageTransaction(message); });
  }

  function requireAwaitingPayment(orderId) {
    var order = dependencies.orderRepository.findById(orderId);
    if (!order) throw new OrderNotFoundError(orderId);
    var state = dependencies.conversationStateRepository.get(order.customerId);
    if (!state ||
        state.currentState !== d.StateMachine.States.AWAITING_PAYMENT ||
        state.contextData.orderId !== orderId) {
      throw new PaymentAlreadyResolvedError(orderId, order.status);
    }
    return { order: order, state: state };
  }

  function confirmPayment(orderId, confirmedBy) {
    return dependencies.withLock(function () {
      if (typeof orderId !== 'string' || orderId.trim() === '') {
        throw new TypeError('orderId must be a non-empty string');
      }
      if (typeof confirmedBy !== 'string' || confirmedBy.trim() === '') {
        throw new TypeError('confirmedBy must be a non-empty string');
      }
      var awaiting = requireAwaitingPayment(orderId);
      var order = awaiting.order;
      var state = awaiting.state;
      var result = d.StateMachine.transition(
        state.currentState,
        d.StateMachine.Events.PAYMENT_CONFIRMED,
        state.contextData
      );
      var customer = dependencies.customerRepository.findById(order.customerId);
      if (!customer) throw new Error('Customer not found for order: ' + orderId);
      var timestamp = dependencies.now().toISOString();
      dependencies.orderRepository.save(Object.assign({}, order, {
        status: 'PAID',
        confirmedAt: timestamp,
        confirmedBy: confirmedBy,
        updatedAt: timestamp
      }));
      dependencies.conversationStateRepository.set(order.customerId, {
        customerId: order.customerId,
        currentState: result.nextState,
        contextData: result.newContextData,
        updatedAt: timestamp
      });
      return {
        customer: customer,
        outboundMessages: [outbound('text', {
          text: 'Payment confirmed for order ' + orderId + '. Thank you!',
          orderId: orderId
        })]
      };
    });
  }

  function expireOrder(orderId) {
    return dependencies.withLock(function () {
      if (typeof orderId !== 'string' || orderId.trim() === '') {
        throw new TypeError('orderId must be a non-empty string');
      }
      var awaiting = requireAwaitingPayment(orderId);
      var order = awaiting.order;
      var state = awaiting.state;
      var result = d.StateMachine.transition(
        state.currentState,
        d.StateMachine.Events.PAYMENT_EXPIRED,
        state.contextData
      );
      var customer = dependencies.customerRepository.findById(order.customerId);
      if (!customer) throw new Error('Customer not found for order: ' + orderId);
      var timestamp = dependencies.now().toISOString();
      dependencies.orderRepository.save(Object.assign({}, order, {
        status: 'EXPIRED',
        updatedAt: timestamp
      }));
      dependencies.conversationStateRepository.set(order.customerId, {
        customerId: order.customerId,
        currentState: result.nextState,
        contextData: result.newContextData,
        updatedAt: timestamp
      });
      return {
        customer: customer,
        outboundMessages: [outbound('text', {
          text: 'Đơn hàng #' + orderId +
            ' đã hết hạn do quá thời gian chờ thanh toán. Vui lòng đặt lại nếu quý khách vẫn muốn mua.',
          orderId: orderId
        })]
      };
    });
  }

  return Object.freeze({
    handleMessage: handleMessage,
    confirmPayment: confirmPayment,
    expireOrder: expireOrder
  });
}

var OrderService = Object.freeze({
  create: createOrderService,
  Errors: Object.freeze({
    OrderNotFoundError: OrderNotFoundError,
    PaymentAlreadyResolvedError: PaymentAlreadyResolvedError
  })
});

if (typeof module !== 'undefined' && module.exports) module.exports = OrderService;
