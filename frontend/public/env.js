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

  // API — API_LOCATION stays empty everywhere: relative /api goes through the dev-server
  // proxy locally and through Front Door -> APIM when deployed.
  window.__env.API_LOCATION = '';
  window.__env.API_PATH = '/api';
  window.__env.DEV_PROXY_TARGET = 'https://demi-apim-test.azure-api.net';

  // eagle-notify staff API. Relative locally (dev proxy, see proxy.conf.js); deploy rewrites it
  // to the notify-api host, whose CORS list must carry this site's origin.
  window.__env.NOTIFY_API_LOCATION = '/notify-api';
  window.__env.DEV_NOTIFY_PROXY_TARGET = 'https://notify-api-test.azurewebsites.net';
  window.__env.USE_MOCK_DATA = false;

  // Application Insights. Empty = no browser telemetry; the deploy fills it in per environment.
  window.__env.APPINSIGHTS_CONNECTION_STRING = '';

  // Keycloak Authentication Configuration
  window.__env.KEYCLOAK_CLIENT_ID = 'eagle-admin-console';
  window.__env.KEYCLOAK_URL = 'https://test.loginproxy.gov.bc.ca/auth';
  window.__env.KEYCLOAK_REALM = 'eao-epic';
  window.__env.KEYCLOAK_ENABLED = true;
  window.__env.REDIRECT_KEY = 'REDIRECT';

})(this);
