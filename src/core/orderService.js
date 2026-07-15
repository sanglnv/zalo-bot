'use strict';

function orderServiceDependencies() {
  return typeof module !== 'undefined' && module.exports ? {
      Domain: require('./domain.js'),
      StateMachine: require('./stateMachine.js'),
      Billing: require('./billing.js'),
      Repositories: require('./repositoryContracts.js')
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

function UserActionError(code, customerMessage, action, currentState) {
  this.name = 'UserActionError';
  this.code = code || 'USER_ACTION_ERROR';
  this.customerMessage = customerMessage;
  this.action = action || null;
  this.currentState = currentState || null;
  this.message = customerMessage;
  if (Error.captureStackTrace) Error.captureStackTrace(this, UserActionError);
}
UserActionError.prototype = Object.create(Error.prototype);
UserActionError.prototype.constructor = UserActionError;

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
 * @param {{Domain: Object, StateMachine: Object, Billing: Object, Repositories: Object}=} dependencies.coreDependencies Static dependency bundle for runtimes without CommonJS require
 * @returns {{handleMessage: function(import('./domain').InboundMessage): import('./domain').OutboundMessage[], confirmPayment: function(string, string): Object, expireOrder: function(string): Object}}
 */
function createOrderService(dependencies) {
  dependencies = dependencies || {};
  var d = dependencies.coreDependencies || orderServiceDependencies();
  ['Domain', 'StateMachine', 'Billing', 'Repositories'].forEach(function (name) {
    if (!d[name]) throw new TypeError('coreDependencies.' + name + ' is required');
  });
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
  var telemetrySink = typeof dependencies.telemetry === 'function'
    ? dependencies.telemetry
    : function () {};

  function telemetry(event, details) {
    try { telemetrySink(event, details); }
    catch (ignore) {}
  }

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

  function startFreshOrder(state) {
    var event = state.currentState === d.StateMachine.States.IDLE
      ? d.StateMachine.Events.START_BROWSING
      : d.StateMachine.Events.START_NEW_ORDER;
    var result = d.StateMachine.transition(state.currentState, event, state.contextData);
    return persistState({
      customerId: state.customerId,
      currentState: result.nextState,
      contextData: { cart: [] },
      updatedAt: dependencies.now().toISOString()
    });
  }

  function userError(code, message, action, state) {
    return new UserActionError(code, message, action, state && state.currentState);
  }

  function formatMoney(amount) {
    return String(Math.round(Number(amount) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' ₫';
  }

  function cartTotal(cart) {
    return (cart || []).reduce(function (total, item) {
      return total + item.unitPrice * item.quantity;
    }, 0);
  }

  function cartMessage(cart) {
    if (!cart || cart.length === 0) return 'Giỏ hàng đang trống.';
    var lines = cart.map(function (item) {
      return '• ' + item.name + ' × ' + item.quantity + ': ' + formatMoney(item.unitPrice * item.quantity);
    });
    return 'Giỏ hàng của bạn:\n' + lines.join('\n') + '\nTổng: ' + formatMoney(cartTotal(cart));
  }

  function latestOrder(customerId) {
    var orders = dependencies.orderRepository.findByCustomerId(customerId);
    if (!Array.isArray(orders) || orders.length === 0) return null;
    return orders.slice().sort(function (left, right) {
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    })[0];
  }

  function pendingOrder(state, customer) {
    var orderId = state.contextData && state.contextData.orderId;
    var contextual = orderId ? dependencies.orderRepository.findById(orderId) : null;
    if (contextual && contextual.status === 'AWAITING_PAYMENT') return contextual;
    var awaiting = dependencies.orderRepository.findByCustomerId(customer.customerId)
      .filter(function (order) { return order.status === 'AWAITING_PAYMENT'; })
      .sort(function (left, right) {
        return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
      });
    return awaiting[0] || null;
  }

  function pendingOrderResponse(order) {
    return [outbound('button', {
      text: 'Bạn đang có đơn #' + order.orderId + ' chờ thanh toán.\nTổng tiền: ' +
        formatMoney(order.totalAmount),
      buttons: [
        { action: 'resend_qr', label: 'Xem lại QR' },
        { action: 'status', label: 'Trạng thái' },
        { action: 'cancel', label: 'Hủy đơn' }
      ]
    })];
  }

  function helpResponse() {
    return [outbound('button', {
      text: 'Bạn có thể chọn Catalog, xem giỏ hàng, thanh toán hoặc kiểm tra đơn hàng.',
      buttons: [
        { action: 'catalog', label: 'Catalog' },
        { action: 'cart', label: 'Giỏ hàng' },
        { action: 'status', label: 'Trạng thái' }
      ]
    })];
  }

  function availableCatalog() {
    var products = dependencies.getCatalog();
    if (!Array.isArray(products)) throw new TypeError('getCatalog() must return an array');
    return products.filter(function (product) { return product.isAvailable; });
  }

  function catalogCategories(products) {
    var seen = {};
    return products.reduce(function (categories, product) {
      var categoryId = product.categoryId || 'CAT_OTHER';
      if (seen[categoryId]) return categories;
      seen[categoryId] = true;
      categories.push({
        categoryId: categoryId,
        categoryName: product.categoryName || categoryId
      });
      return categories;
    }, []);
  }

  function catalogResponse(products) {
    if (!products.length) return outbound('button', {
      text: 'Hôm nay quán đã hết món hoặc đang tạm ngừng bán. Vui lòng quay lại sau.',
      buttons: [
        { action: 'status', label: 'Kiểm tra đơn hàng' }
      ]
    });
    var hasCategories = products.some(function (product) { return !!product.categoryId; });
    if (!hasCategories) return outbound('list', { title: 'Catalog', items: products });
    return outbound('button', {
      text: 'Chọn danh mục sản phẩm:',
      buttons: catalogCategories(products).map(function (category) {
        return {
          action: 'select_category',
          categoryId: category.categoryId,
          label: category.categoryName
        };
      }).concat([{ action: 'cart', label: 'Giỏ hàng' }])
    });
  }

  function actionOf(message) {
    if (message.payload && typeof message.payload.action === 'string') return message.payload.action;
    var action = message.text.trim().toLowerCase().split(/\s+/)[0] || '';
    if (action.charAt(0) === '/') action = action.slice(1).split('@')[0];
    return action;
  }

  /** @param {import('./domain').InboundMessage} message */
  function handleMessageTransaction(message) {
    d.Domain.validateInboundMessage(message);
    var customer = getOrCreateCustomer(message);
    var state = loadState(customer.customerId);
    telemetry('state_loaded', {
      traceId: message.traceId || null,
      customerId: customer.customerId,
      currentState: state.currentState
    });
    var action = actionOf(message);

    if (action === 'start' || action === 'help') {
      var activeAtStart = pendingOrder(state, customer);
      if (activeAtStart) return pendingOrderResponse(activeAtStart);
      if (action === 'help') return helpResponse();
      return [outbound('button', {
        text: 'Xin chào! Bạn muốn đặt món hay kiểm tra đơn hàng?',
        buttons: [
          { action: 'catalog', label: 'Xem catalog' },
          { action: 'status', label: 'Trạng thái đơn' },
          { action: 'help', label: 'Trợ giúp' }
        ]
      })];
    }

    if (action === 'catalog' || action === 'browse') {
      var awaitingOrder = pendingOrder(state, customer);
      if (awaitingOrder) return pendingOrderResponse(awaitingOrder);
      var catalogItems = availableCatalog();
      if (state.currentState === d.StateMachine.States.IDLE ||
          state.currentState === d.StateMachine.States.PAID ||
          state.currentState === d.StateMachine.States.DONE ||
          state.currentState === d.StateMachine.States.CANCELLED ||
          state.currentState === d.StateMachine.States.EXPIRED) {
        state = startFreshOrder(state);
      }
      return [catalogResponse(catalogItems)];
    }

    if (action === 'select_category') {
      var selectedCategoryId = message.payload && message.payload.categoryId;
      var categoryProducts = availableCatalog().filter(function (product) {
        return (product.categoryId || 'CAT_OTHER') === selectedCategoryId;
      });
      if (!categoryProducts.length) {
        throw userError('CATEGORY_EMPTY', 'Danh mục này hiện chưa có sản phẩm.', action, state);
      }
      return [outbound('list', {
        title: categoryProducts[0].categoryName || 'Sản phẩm',
        items: categoryProducts,
        buttons: [
          { action: 'catalog', label: '← Danh mục' },
          { action: 'cart', label: 'Giỏ hàng' }
        ]
      })];
    }

    if (action === 'view_product') {
      var viewedProductId = message.payload && message.payload.productId;
      var viewedProduct = availableCatalog().find(function (item) {
        return item.productId === viewedProductId;
      });
      if (!viewedProduct) {
        throw userError(
          'PRODUCT_UNAVAILABLE', 'Món này đã hết hoặc hiện đang tạm ngừng bán.', action, state
        );
      }
      var pendingForProduct = pendingOrder(state, customer);
      if (pendingForProduct) return pendingOrderResponse(pendingForProduct);
      if (state.currentState !== d.StateMachine.States.BROWSING &&
          state.currentState !== d.StateMachine.States.CART &&
          state.currentState !== d.StateMachine.States.CONFIRMING) {
        throw userError('INVALID_FLOW', 'Hãy mở catalog trước khi chọn sản phẩm.', action, state);
      }
      return [outbound('button', {
        text: viewedProduct.name + '\n' + formatMoney(viewedProduct.price) +
          '\n\nChọn số lượng muốn thêm vào giỏ:',
        buttons: [
          { action: 'add_item', productId: viewedProduct.productId, quantity: 1, label: 'Thêm 1' },
          { action: 'add_item', productId: viewedProduct.productId, quantity: 2, label: 'Thêm 2' },
          { action: 'add_item', productId: viewedProduct.productId, quantity: 3, label: 'Thêm 3' },
          { action: 'add_item', productId: viewedProduct.productId, quantity: 5, label: 'Thêm 5' },
          {
            action: 'select_category',
            categoryId: viewedProduct.categoryId || 'CAT_OTHER',
            label: '← Sản phẩm'
          },
          { action: 'cart', label: 'Giỏ hàng' }
        ]
      })];
    }

    if (action === 'new_order') {
      var pendingForNewOrder = pendingOrder(state, customer);
      if (pendingForNewOrder) return pendingOrderResponse(pendingForNewOrder);
      if (state.currentState !== d.StateMachine.States.PAID &&
          state.currentState !== d.StateMachine.States.DONE &&
          state.currentState !== d.StateMachine.States.CANCELLED &&
          state.currentState !== d.StateMachine.States.EXPIRED) {
        throw userError('ACTIVE_SESSION', 'Bạn đang có một phiên mua hàng. Hãy xem giỏ hoặc hủy trước.', action, state);
      }
      var newOrderCatalog = availableCatalog();
      state = startFreshOrder(state);
      return [catalogResponse(newOrderCatalog)];
    }

    if (action === 'add_item') {
      var productId = message.payload && message.payload.productId;
      var quantity = message.payload && message.payload.quantity == null ? 1 : message.payload.quantity;
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw userError('INVALID_QUANTITY', 'Số lượng sản phẩm không hợp lệ.', action, state);
      }
      var product = availableCatalog().find(function (item) { return item.productId === productId; });
      if (!product) throw userError(
        'PRODUCT_UNAVAILABLE', 'Món này đã hết hoặc hiện đang tạm ngừng bán.', action, state
      );
      if (state.currentState !== d.StateMachine.States.BROWSING &&
          state.currentState !== d.StateMachine.States.CART &&
          state.currentState !== d.StateMachine.States.CONFIRMING) {
        var activeForAdd = pendingOrder(state, customer);
        if (activeForAdd) return pendingOrderResponse(activeForAdd);
        throw userError('INVALID_FLOW', 'Hãy mở catalog trước khi chọn sản phẩm.', action, state);
      }
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
      return [outbound('button', {
        text: 'Đã thêm ' + product.name + ' × ' + quantity + '.\n' +
          'Giỏ hàng: ' + cart.reduce(function (sum, item) { return sum + item.quantity; }, 0) +
          ' sản phẩm — ' + formatMoney(cartTotal(cart)),
        cart: cart,
        buttons: [
          { action: 'decrease_item', productId: product.productId, label: 'Giảm 1' },
          { action: 'remove_item', productId: product.productId, label: 'Xóa món' },
          { action: 'cart', label: 'Xem giỏ' },
          { action: 'checkout', label: 'Thanh toán' },
          { action: 'catalog', label: 'Chọn thêm' }
        ]
      })];
    }

    if (action === 'decrease_item' || action === 'remove_item') {
      if (state.currentState !== d.StateMachine.States.CART &&
          state.currentState !== d.StateMachine.States.CONFIRMING) {
        throw userError('INVALID_FLOW', 'Hiện không có giỏ hàng nào để chỉnh sửa.', action, state);
      }
      var targetProductId = message.payload && message.payload.productId;
      var editableCart = (state.contextData.cart || []).map(function (item) {
        return Object.assign({}, item);
      });
      var targetIndex = editableCart.findIndex(function (item) { return item.productId === targetProductId; });
      if (targetIndex < 0) {
        throw userError('ITEM_NOT_IN_CART', 'Sản phẩm không còn trong giỏ hàng.', action, state);
      }
      if (action === 'remove_item' || editableCart[targetIndex].quantity === 1) {
        editableCart.splice(targetIndex, 1);
      } else {
        editableCart[targetIndex].quantity -= 1;
      }
      state = persistTransition(state, d.StateMachine.Events.UPDATE_CART, {
        cart: editableCart,
        bill: null
      });
      return [outbound('button', {
        text: cartMessage(editableCart),
        buttons: editableCart.length ? [
          { action: 'checkout', label: 'Thanh toán' },
          { action: 'catalog', label: 'Chọn thêm' },
          { action: 'cancel', label: 'Hủy giỏ' }
        ] : [{ action: 'catalog', label: 'Chọn sản phẩm' }]
      })];
    }

    if (action === 'cart') {
      var pendingForCart = pendingOrder(state, customer);
      if (pendingForCart) return pendingOrderResponse(pendingForCart);
      var currentCart = state.contextData.cart || [];
      return [outbound('button', {
        text: cartMessage(currentCart),
        buttons: currentCart.length ? [
          { action: 'checkout', label: 'Thanh toán' },
          { action: 'catalog', label: 'Chọn thêm' },
          { action: 'cancel', label: 'Hủy giỏ' }
        ] : [{ action: 'catalog', label: 'Xem catalog' }]
      })];
    }

    if (action === 'checkout') {
      var checkoutCart = state.contextData.cart || [];
      if (checkoutCart.length === 0) {
        throw userError('EMPTY_CART', 'Giỏ hàng đang trống. Hãy chọn sản phẩm trước.', action, state);
      }
      if (state.currentState === d.StateMachine.States.CONFIRMING) {
        return [outbound('button', {
          text: cartMessage(checkoutCart) + '\nVui lòng xác nhận đơn hàng.',
          buttons: [{ action: 'confirm_order', label: 'Xác nhận' }, { action: 'cancel', label: 'Hủy' }]
        })];
      }
      if (state.currentState !== d.StateMachine.States.CART) {
        var activeForCheckout = pendingOrder(state, customer);
        if (activeForCheckout) return pendingOrderResponse(activeForCheckout);
        throw userError('INVALID_FLOW', 'Hãy xem catalog và chọn sản phẩm trước.', action, state);
      }
      var preview = d.Billing.calculateBill(checkoutCart, state.contextData.discount || null);
      state = persistTransition(state, d.StateMachine.Events.REVIEW_CART, { bill: preview });
      return [outbound('button', {
        text: cartMessage(checkoutCart) + '\nVui lòng xác nhận đơn hàng.',
        summary: preview,
        buttons: [{ action: 'confirm_order', label: 'Xác nhận' }, { action: 'cancel', label: 'Hủy' }]
      })];
    }

    if (action === 'confirm_order') {
      var existingAwaiting = pendingOrder(state, customer);
      if (existingAwaiting) return pendingOrderResponse(existingAwaiting);
      if (state.currentState !== d.StateMachine.States.CONFIRMING) {
        throw userError('INVALID_FLOW', 'Hãy chọn sản phẩm và kiểm tra giỏ trước khi xác nhận.', action, state);
      }
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
        outbound('text', {
          text: 'Đã tạo đơn #' + order.orderId + '. Vui lòng thanh toán ' + formatMoney(order.totalAmount) + '.',
          orderId: order.orderId,
          amount: order.totalAmount
        }),
        outbound('image', {
          purpose: 'payment_qr', data: qrContent, orderId: order.orderId,
          caption: 'Đơn #' + order.orderId + '\nSố tiền: ' + formatMoney(order.totalAmount)
        })
      ];
    }

    if (action === 'status') {
      var orderForStatus = latestOrder(customer.customerId);
      if (!orderForStatus) {
        return [outbound('button', {
          text: 'Bạn chưa có đơn hàng nào.',
          buttons: [{ action: 'catalog', label: 'Xem catalog' }]
        })];
      }
      if (orderForStatus.status === 'AWAITING_PAYMENT') return pendingOrderResponse(orderForStatus);
      return [outbound('button', {
        text: 'Đơn #' + orderForStatus.orderId + '\nTrạng thái: ' + orderForStatus.status +
          '\nTổng tiền: ' + formatMoney(orderForStatus.totalAmount),
        buttons: [{ action: 'new_order', label: 'Đặt đơn mới' }]
      })];
    }

    if (action === 'resend_qr') {
      var orderForQr = pendingOrder(state, customer);
      if (!orderForQr) {
        throw userError('NO_PENDING_PAYMENT', 'Không có đơn nào đang chờ thanh toán.', action, state);
      }
      return [outbound('image', {
        purpose: 'payment_qr', data: dependencies.createQrContent(orderForQr), orderId: orderForQr.orderId,
        caption: 'Đơn #' + orderForQr.orderId + '\nSố tiền: ' + formatMoney(orderForQr.totalAmount)
      })];
    }

    if (action === 'cancel') {
      if (state.currentState === d.StateMachine.States.CANCELLED) {
        return [outbound('button', {
          text: 'Đơn/giỏ hàng đã được hủy.',
          buttons: [{ action: 'new_order', label: 'Đặt đơn mới' }]
        })];
      }
      if (state.currentState === d.StateMachine.States.IDLE ||
          state.currentState === d.StateMachine.States.PAID ||
          state.currentState === d.StateMachine.States.DONE ||
          state.currentState === d.StateMachine.States.EXPIRED) {
        throw userError('NOTHING_TO_CANCEL', 'Hiện không có đơn hoặc giỏ hàng nào có thể hủy.', action, state);
      }
      var cancelledState = prepareTransition(state, d.StateMachine.Events.CANCEL);
      if (cancelledState.contextData.orderId) {
        dependencies.orderRepository.updateStatus(cancelledState.contextData.orderId, 'CANCELLED');
      }
      state = persistState(cancelledState);
      return [outbound('button', {
        text: 'Đã hủy đơn/giỏ hàng.',
        buttons: [{ action: 'new_order', label: 'Đặt đơn mới' }]
      })];
    }

    return helpResponse();
  }

  function handleMessage(message) {
    return dependencies.withLock(function () { return handleMessageTransaction(message); });
  }

  function requireAwaitingPayment(orderId) {
    var order = dependencies.orderRepository.findById(orderId);
    if (!order) throw new OrderNotFoundError(orderId);
    var state = dependencies.conversationStateRepository.get(order.customerId);
    if (order.status !== 'AWAITING_PAYMENT') {
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
      var customer = dependencies.customerRepository.findById(order.customerId);
      if (!customer) throw new Error('Customer not found for order: ' + orderId);
      var timestamp = dependencies.now().toISOString();
      dependencies.orderRepository.save(Object.assign({}, order, {
        status: 'PAID',
        confirmedAt: timestamp,
        confirmedBy: confirmedBy,
        updatedAt: timestamp
      }));
      if (state && state.currentState === d.StateMachine.States.AWAITING_PAYMENT &&
          state.contextData.orderId === orderId) {
        var result = d.StateMachine.transition(
          state.currentState, d.StateMachine.Events.PAYMENT_CONFIRMED, state.contextData
        );
        dependencies.conversationStateRepository.set(order.customerId, {
          customerId: order.customerId,
          currentState: result.nextState,
          contextData: result.newContextData,
          updatedAt: timestamp
        });
      }
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
      var customer = dependencies.customerRepository.findById(order.customerId);
      if (!customer) throw new Error('Customer not found for order: ' + orderId);
      var timestamp = dependencies.now().toISOString();
      dependencies.orderRepository.save(Object.assign({}, order, {
        status: 'EXPIRED',
        updatedAt: timestamp
      }));
      if (state && state.currentState === d.StateMachine.States.AWAITING_PAYMENT &&
          state.contextData.orderId === orderId) {
        var result = d.StateMachine.transition(
          state.currentState, d.StateMachine.Events.PAYMENT_EXPIRED, state.contextData
        );
        dependencies.conversationStateRepository.set(order.customerId, {
          customerId: order.customerId,
          currentState: result.nextState,
          contextData: result.newContextData,
          updatedAt: timestamp
        });
      }
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
    PaymentAlreadyResolvedError: PaymentAlreadyResolvedError,
    UserActionError: UserActionError
  })
});

if (typeof module !== 'undefined' && module.exports) module.exports = OrderService;
