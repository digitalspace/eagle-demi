(function (window) {
  window.__env = window.__env || {};

  // ==========================================================================
  // STANDALONE DEMI DEMO LOCAL DEVELOPMENT CONFIGURATION
  // ==========================================================================

  window.__env.configEndpoint = true;
  window.__env.ENVIRONMENT = 'dev'; // local | dev | test | prod
  window.__env.BANNER_COLOUR = 'blue';

  // API — proxy.conf.js reads API_LOCATION to generate dev server proxy rules
  // The Angular app uses relative paths (/api) — never API_LOCATION directly
  window.__env.API_LOCATION = 'https://demi-api-dev.azurewebsites.net';
  window.__env.API_PATH = 'https://demi-api-dev.azurewebsites.net/api';
  window.__env.USE_MOCK_DATA = false;

  // Keycloak Authentication Configuration
  window.__env.KEYCLOAK_CLIENT_ID = 'eagle-admin-console';
  window.__env.KEYCLOAK_URL = 'https://dev.loginproxy.gov.bc.ca/auth';
  window.__env.KEYCLOAK_REALM = 'eao-epic';
  window.__env.KEYCLOAK_ENABLED = true;
  window.__env.REDIRECT_KEY = 'REDIRECT';

})(this);
