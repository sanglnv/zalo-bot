'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateBill } = require('../core/billing');

const items = [
  { productId: 'coffee', unitPrice: 30_000, quantity: 2 },
  { productId: 'tea', unitPrice: 20_000, quantity: 1 }
];

test('calculates subtotal without a discount', () => {
  assert.deepEqual(calculateBill(items), {
    subtotal: 80_000, discountAmount: 0, totalAmount: 80_000
  });
});

test('applies fixed and percentage discounts', () => {
  assert.deepEqual(calculateBill(items, { type: 'fixed', value: 10_000 }), {
    subtotal: 80_000, discountAmount: 10_000, totalAmount: 70_000
  });
  assert.deepEqual(calculateBill(items, { type: 'percentage', value: 25 }), {
    subtotal: 80_000, discountAmount: 20_000, totalAmount: 60_000
  });
});

test('caps a fixed discount at the subtotal and handles an empty bill', () => {
  assert.equal(calculateBill(items, { type: 'fixed', value: 999_999 }).totalAmount, 0);
  assert.deepEqual(calculateBill([]), { subtotal: 0, discountAmount: 0, totalAmount: 0 });
});

test('rejects malformed items and discounts', () => {
  assert.throws(() => calculateBill(null), /items must be an array/);
  assert.throws(() => calculateBill([{ unitPrice: -1, quantity: 1 }]), /unitPrice/);
  assert.throws(() => calculateBill([{ unitPrice: 10, quantity: 0 }]), /quantity/);
  assert.throws(() => calculateBill(items, { type: 'percentage', value: 101 }), /cannot exceed 100/);
  assert.throws(() => calculateBill(items, { type: 'mystery', value: 1 }), /discount.type/);
});
