'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

// Which build is actually answering, read ONCE at load from a file stamped into the deploy package
// by scripts/package-api.py.
//
// Deliberately not an app setting. App Service keeps the previous container serving for about two
// minutes after a deploy, and that container picks up a new app setting on restart and reports it
// correctly — so an env-var build id proves a restart happened, not that new code is running. That
// is the exact failure this exists to catch, and it is how two deploys were believed effective
// while the old code kept answering.
//
// Absent locally (`yarn start`, tests), where the fallback is the env var and then 'unknown'.
const BUILD_ID = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, '../../build-id.txt'), 'utf8').trim();
  } catch {
    return process.env.BUILD_ID || 'unknown';
  }
})();

/**
 * Returns dynamic runtime configuration to the frontend.
 *
 * This endpoint is UNAUTHENTICATED — everything returned here is public. Never add
 * secrets, API keys, or connection strings. The frontend reaches the search backend only
 * through GET /api/search, so no search endpoint or key belongs in this payload.
 */
exports.getConfig = (req, res) => {
  res.json({
    // A short git sha plus a deploy timestamp. Public information; this endpoint is
    // unauthenticated and must stay free of anything that is not.
    BUILD_ID,
    ENVIRONMENT: process.env.ENVIRONMENT || config.env || 'dev',
    API_LOCATION: process.env.API_LOCATION || 'https://demi-api-dev.azurewebsites.net',
    API_PATH: process.env.API_PATH || '/api',
    KEYCLOAK_CLIENT_ID: process.env.KEYCLOAK_CLIENT_ID || 'eagle-admin-console',
    KEYCLOAK_URL: process.env.KEYCLOAK_URL || 'https://dev.loginproxy.gov.bc.ca/auth',
    KEYCLOAK_REALM: process.env.KEYCLOAK_REALM || 'eao-epic',
    KEYCLOAK_ENABLED: process.env.KEYCLOAK_ENABLED !== 'false',
    BANNER_COLOUR: process.env.BANNER_COLOUR || 'blue',
    USE_MOCK_DATA: process.env.USE_MOCK_DATA === 'true',
    configEndpoint: true
  });
};
