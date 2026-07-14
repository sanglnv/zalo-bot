'use strict';

function routedPostWithoutMetrics(e) {
  var explicit = e && e.parameter && e.parameter.platform;
  if (explicit === 'zalo') return doZaloPost(e);
  if (explicit === 'telegram') return doTelegramPostWithoutMetrics(e);
  try {
    var body = JSON.parse(e && e.postData ? e.postData.contents : 'null');
    if (body && typeof body.event_name === 'string') return doZaloPost(e);
  } catch (ignore) {}
  return doTelegramPostWithoutMetrics(e);
}

function doPost(e) {
  return recordDuration('doPost', function () { return routedPostWithoutMetrics(e); });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { doPost: doPost };
