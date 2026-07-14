'use strict';

function secureGatewayTokenEquals(actual, expected) {
  if (!actual || !expected) return false;
  var actualHash = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(actual),
    Utilities.Charset.UTF_8
  );
  var expectedHash = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(expected),
    Utilities.Charset.UTF_8
  );
  var difference = 0;
  for (var index = 0; index < actualHash.length; index += 1) {
    difference |= (actualHash[index] & 255) ^ (expectedHash[index] & 255);
  }
  return difference === 0;
}

function validTelegramGateway(e) {
  var expected = PropertiesService
    .getScriptProperties()
    .getProperty('GAS_GATEWAY_TOKEN');

  var actual = e && e.parameter
    ? e.parameter.gateway_token
    : '';

  return secureGatewayTokenEquals(actual, expected);
}

function routedPostWithoutMetrics(e) {
  var explicit = e && e.parameter && e.parameter.platform;
  if (explicit === 'zalo') return doZaloPost(e);
  if (explicit === 'telegram') {
    if (!validTelegramGateway(e)) return HtmlService.createHtmlOutput('OK');
    if (e.parameter.gateway_probe === '1') return HtmlService.createHtmlOutput('GATEWAY_OK');
    return doTelegramPostWithoutMetrics(e);
  }
  try {
    var body = JSON.parse(e && e.postData ? e.postData.contents : 'null');
    if (body && typeof body.event_name === 'string') return doZaloPost(e);
  } catch (ignore) {}
  return HtmlService.createHtmlOutput('OK');
}

function doPost(e) {
  return recordDuration('doPost', function () { return routedPostWithoutMetrics(e); });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    doPost: doPost,
    validTelegramGateway: validTelegramGateway,
    secureGatewayTokenEquals: secureGatewayTokenEquals
  };
}
