(function (window) {
  window.__env = window.__env || {};

  // ==========================================================================
  // STANDALONE DEMI DEMO LOCAL DEVELOPMENT CONFIGURATION
  // ==========================================================================

  // Local dev: false, so env.js is the whole config. /api/config would hand back the Azure
  // API_LOCATION and every call would leave the dev proxy and hit CORS.
  window.__env.configEndpoint = false;
  window.__env.ENVIRONMENT = 'test'; // local | dev | test | prod
  window.__env.BANNER_COLOUR = 'blue';

  // API — keep API_LOCATION empty locally so calls stay relative (/api) and go through the
  // dev-server proxy; proxy.conf.js forwards them to DEV_PROXY_TARGET. Deploy rewrites both.
  window.__env.API_LOCATION = '';
  window.__env.API_PATH = '/api';
  window.__env.DEV_PROXY_TARGET = 'https://demi-api-test.azurewebsites.net';

  // eagle-notify staff API. Relative locally (dev proxy, see proxy.conf.js); deploy rewrites it
  // to the notify-api host, whose CORS list must carry this site's origin.
  window.__env.NOTIFY_API_LOCATION = '/notify-api';
  window.__env.DEV_NOTIFY_PROXY_TARGET = 'https://notify-api-test.azurewebsites.net';
  window.__env.USE_MOCK_DATA = false;

  // Keycloak Authentication Configuration
  window.__env.KEYCLOAK_CLIENT_ID = 'eagle-admin-console';
  window.__env.KEYCLOAK_URL = 'https://test.loginproxy.gov.bc.ca/auth';
  window.__env.KEYCLOAK_REALM = 'eao-epic';
  window.__env.KEYCLOAK_ENABLED = true;
  window.__env.REDIRECT_KEY = 'REDIRECT';

})(this);
