(function (window) {
  window.__env = window.__env || {};

  // ==========================================================================
  // STANDALONE DEMI DEMO LOCAL DEVELOPMENT CONFIGURATION
  // ==========================================================================

  window.__env.configEndpoint = false;
  window.__env.ENVIRONMENT = 'local'; // local | dev | test | prod
  window.__env.BANNER_COLOUR = 'blue';

  // API Configuration — Connects directly to local DEMI API
  window.__env.API_PATH = 'http://localhost:3000/api';
  window.__env.USE_MOCK_DATA = false;

  // Keycloak Authentication Configuration
  window.__env.KEYCLOAK_CLIENT_ID = 'eagle-admin-console';
  window.__env.KEYCLOAK_URL = 'https://dev.loginproxy.gov.bc.ca/auth';
  window.__env.KEYCLOAK_REALM = 'eao-epic';
  window.__env.KEYCLOAK_ENABLED = true;
  window.__env.REDIRECT_KEY = 'REDIRECT';

})(this);
