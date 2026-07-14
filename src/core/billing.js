'use strict';

/**
 * @typedef {{type: 'fixed'|'percentage', value: number}} Discount
 */

/**
 * Calculate an order total without mutating its input.
 * @param {Array<{unitPrice: number, quantity: number}>} items
 * @param {Discount|null|undefined} discount
 * @returns {{subtotal: number, discountAmount: number, totalAmount: number}}
 */
function calculateBill(items, discount) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  var subtotal = items.reduce(function (sum, item, index) {
    if (!item || !Number.isFinite(item.unitPrice) || item.unitPrice < 0) {
      throw new TypeError('items[' + index + '].unitPrice must be a non-negative number');
    }
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new TypeError('items[' + index + '].quantity must be a positive integer');
    }
    return sum + item.unitPrice * item.quantity;
  }, 0);

  var discountAmount = 0;
  if (discount != null) {
    if (!discount || !Number.isFinite(discount.value) || discount.value < 0) {
      throw new TypeError('discount.value must be a non-negative number');
    }
    if (discount.type === 'fixed') discountAmount = discount.value;
    else if (discount.type === 'percentage') {
      if (discount.value > 100) throw new RangeError('percentage discount cannot exceed 100');
      discountAmount = subtotal * discount.value / 100;
    } else throw new TypeError('discount.type must be fixed or percentage');
  }

  discountAmount = Math.min(subtotal, discountAmount);
  return {
    subtotal: subtotal,
    discountAmount: discountAmount,
    totalAmount: subtotal - discountAmount
  };
}

var Billing = Object.freeze({ calculateBill: calculateBill });

if (typeof module !== 'undefined' && module.exports) module.exports = Billing;
