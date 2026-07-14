'use strict';

function normalizeMac(signature) {
  if (typeof signature !== 'string') return '';
  var trimmed = signature.trim();
  return trimmed.indexOf('mac=') === 0 ? trimmed.slice(4).toLowerCase() : trimmed.toLowerCase();
}

function signatureInput(rawBody, parsedBody, secretKey) {
  if (typeof rawBody !== 'string') throw new TypeError('rawBody must be a string');
  if (!parsedBody || parsedBody.app_id == null || parsedBody.timestamp == null) {
    throw new TypeError('Zalo webhook is missing app_id or timestamp');
  }
  if (typeof secretKey !== 'string' || secretKey === '') throw new TypeError('OA secret key is required');
  return String(parsedBody.app_id) + rawBody + String(parsedBody.timestamp) + secretKey;
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  var mismatch = 0;
  for (var index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function verifyWebhookSignature(signature, rawBody, secretKey, sha256Hex) {
  if (typeof sha256Hex !== 'function') throw new TypeError('sha256Hex must be a function');
  var body = JSON.parse(rawBody);
  var expected = String(sha256Hex(signatureInput(rawBody, body, secretKey))).toLowerCase();
  return constantTimeEqual(normalizeMac(signature), expected);
}

var ZaloWebhookSignature = Object.freeze({
  normalizeMac: normalizeMac,
  signatureInput: signatureInput,
  verifyWebhookSignature: verifyWebhookSignature
});
if (typeof module !== 'undefined' && module.exports) module.exports = ZaloWebhookSignature;
