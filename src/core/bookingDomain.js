'use strict';

/**
 * @typedef {Object} Room
 * @property {string} roomId
 * @property {string} name
 * @property {string} roomType
 * @property {number} hourlyRate
 * @property {number} overnightRate
 * @property {number=} dailyRate Not used by the bot's UI (hourly/nightly only), but present on
 *   rooms coming back from the POS since it supports a third `daily` unit Clawbot doesn't expose.
 * @property {boolean} isAvailable
 */

/**
 * @typedef {Object} Booking
 * @property {string} bookingId
 * @property {string} customerId
 * @property {string|null} memberId
 * @property {string} roomId
 * @property {'hourly'|'nightly'} unit
 * @property {string} startAt
 * @property {string} endAt
 * @property {number=} durationHours
 * @property {number=} nights
 * @property {'AWAITING_PAYMENT'|'PAID'|'CANCELLED'|'EXPIRED'|'DONE'} status
 * @property {number} totalAmount
 * @property {string=} confirmedAt
 * @property {string=} confirmedBy
 * @property {string} createdAt
 * @property {string} updatedAt
 */

var BookingDomain = Object.freeze({
  Units: Object.freeze({ HOURLY: 'hourly', NIGHTLY: 'nightly' }),
  Statuses: Object.freeze({
    AWAITING_PAYMENT: 'AWAITING_PAYMENT', PAID: 'PAID', CANCELLED: 'CANCELLED',
    EXPIRED: 'EXPIRED', DONE: 'DONE'
  })
});

if (typeof module !== 'undefined' && module.exports) module.exports = BookingDomain;
