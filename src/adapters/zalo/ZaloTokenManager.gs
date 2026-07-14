'use strict';

var ZaloTokenManager = (function () {
  var TOKEN_ENDPOINT = 'https://oauth.zaloapp.com/v4/oa/access_token';
  var EXPIRY_SKEW_MS = 5 * 60 * 1000;
  var KEYS = Object.freeze({
    accessToken: 'ZALO_ACCESS_TOKEN',
    refreshToken: 'ZALO_REFRESH_TOKEN',
    expiresAt: 'ZALO_ACCESS_TOKEN_EXPIRES_AT'
  });

  function create(dependencies) {
    dependencies = dependencies || {};
    if (!dependencies.properties || typeof dependencies.properties.getProperty !== 'function' ||
        typeof dependencies.properties.setProperties !== 'function') {
      throw new TypeError('properties must implement getProperty() and setProperties()');
    }
    if (typeof dependencies.withLock !== 'function') throw new TypeError('withLock must be a function');
    if (typeof dependencies.refresh !== 'function') throw new TypeError('refresh must be a function');
    if (typeof dependencies.nowMs !== 'function') throw new TypeError('nowMs must be a function');

    function getValidAccessToken() {
      // The whole read/check/refresh/rotation write is one global transaction.
      // Zalo refresh tokens are single-use, so a narrower lock can revoke access.
      return dependencies.withLock(function () {
        var accessToken = dependencies.properties.getProperty(KEYS.accessToken);
        var expiresAt = Number(dependencies.properties.getProperty(KEYS.expiresAt));
        if (accessToken && Number.isFinite(expiresAt) &&
            expiresAt - EXPIRY_SKEW_MS > dependencies.nowMs()) {
          return accessToken;
        }
        var refreshToken = dependencies.properties.getProperty(KEYS.refreshToken);
        if (!refreshToken) throw new Error('Missing required script property: ' + KEYS.refreshToken);
        var result = dependencies.refresh(refreshToken);
        if (!result || !result.access_token || !result.refresh_token) {
          throw new Error('Zalo token refresh response omitted rotated tokens');
        }
        var expiresIn = Number(result.expires_in);
        if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
          throw new Error('Zalo token refresh response has invalid expires_in');
        }
        var values = {};
        values[KEYS.accessToken] = String(result.access_token);
        values[KEYS.refreshToken] = String(result.refresh_token);
        values[KEYS.expiresAt] = String(dependencies.nowMs() + expiresIn * 1000);
        // One setProperties call minimizes the interval in which the rotated
        // refresh token exists only in Zalo's response.
        dependencies.properties.setProperties(values, false);
        return values[KEYS.accessToken];
      });
    }

    function bootstrap(accessToken, refreshToken, expiresInSeconds) {
      if (typeof accessToken !== 'string' || !accessToken) throw new TypeError('accessToken is required');
      if (typeof refreshToken !== 'string' || !refreshToken) throw new TypeError('refreshToken is required');
      var ttl = expiresInSeconds == null ? 90000 : Number(expiresInSeconds);
      if (!Number.isFinite(ttl) || ttl <= 0) throw new TypeError('expiresInSeconds must be positive');
      return dependencies.withLock(function () {
        var values = {};
        values[KEYS.accessToken] = accessToken;
        values[KEYS.refreshToken] = refreshToken;
        values[KEYS.expiresAt] = String(dependencies.nowMs() + ttl * 1000);
        dependencies.properties.setProperties(values, false);
        return true;
      });
    }

    return Object.freeze({ getValidAccessToken: getValidAccessToken, bootstrap: bootstrap });
  }

  function requiredProperty(properties, name) {
    var value = properties.getProperty(name);
    if (!value) throw new Error('Missing required script property: ' + name);
    return value;
  }

  function defaultRefresh(refreshToken) {
    var properties = PropertiesService.getScriptProperties();
    var response = UrlFetchApp.fetch(TOKEN_ENDPOINT, {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      headers: { secret_key: requiredProperty(properties, 'ZALO_APP_SECRET') },
      payload: {
        refresh_token: refreshToken,
        app_id: requiredProperty(properties, 'ZALO_APP_ID'),
        grant_type: 'refresh_token'
      },
      muteHttpExceptions: true
    });
    var status = response.getResponseCode();
    var text = response.getContentText();
    var parsed;
    try { parsed = JSON.parse(text); } catch (error) { parsed = null; }
    if (status < 200 || status >= 300 || !parsed || parsed.error) {
      throw new Error('Zalo OAuth refresh failed with HTTP ' + status + ': ' + text);
    }
    return parsed;
  }

  function createDefault() {
    return create({
      properties: PropertiesService.getScriptProperties(),
      withLock: SheetRepositorySupport.withScriptLock,
      refresh: defaultRefresh,
      nowMs: function () { return Date.now(); }
    });
  }

  return Object.freeze({ create: create, createDefault: createDefault, KEYS: KEYS });
})();

function getValidZaloAccessToken() {
  return ZaloTokenManager.createDefault().getValidAccessToken();
}

function bootstrapZaloTokens(accessToken, refreshToken, expiresInSeconds) {
  return ZaloTokenManager.createDefault().bootstrap(accessToken, refreshToken, expiresInSeconds);
}

if (typeof module !== 'undefined' && module.exports) module.exports = ZaloTokenManager;
