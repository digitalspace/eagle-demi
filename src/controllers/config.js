'use strict';

const config = require('../config');

/**
 * Returns dynamic runtime configuration to the frontend
 */
exports.getConfig = (req, res) => {
  res.json({
    ENVIRONMENT: process.env.ENVIRONMENT || config.env || 'dev',
    API_LOCATION: process.env.API_LOCATION || 'https://demi-api-dev.azurewebsites.net',
    API_PATH: process.env.API_PATH || '/api',
    KEYCLOAK_CLIENT_ID: process.env.KEYCLOAK_CLIENT_ID || 'eagle-admin-console',
    KEYCLOAK_URL: process.env.KEYCLOAK_URL || 'https://dev.loginproxy.gov.bc.ca/auth',
    KEYCLOAK_REALM: process.env.KEYCLOAK_REALM || 'eao-epic',
    KEYCLOAK_ENABLED: process.env.KEYCLOAK_ENABLED !== 'false',
    TYPESENSE_URL: process.env.TYPESENSE_URL || 'https://demi-typesense-dev.calmgrass-35fa4cb1.canadacentral.azurecontainerapps.io',
    TYPESENSE_API_KEY: process.env.TYPESENSE_API_KEY || 'test-key-123',
    BANNER_COLOUR: process.env.BANNER_COLOUR || 'blue',
    USE_MOCK_DATA: process.env.USE_MOCK_DATA === 'true',
    configEndpoint: true
  });
};
