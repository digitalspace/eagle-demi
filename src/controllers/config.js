'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const configRepository = require('../repositories/config');
const { logger } = require('../utils/logger');

// The keys the stored document is allowed to supply. Anything else in the container is ignored,
// so adding a field to the document does not publish it — this list is the only gate on a public,
// unauthenticated payload.
//
// Absent on purpose:
//   API_LOCATION / API_PATH  the frontend bootstraps from these, so a stored value would fight
//                            the one baked into env.js at deploy time.
//   BUILD_ID                 must keep coming from the deploy package; see below.
const OVERRIDABLE_KEYS = [
  'ENVIRONMENT',
  'KEYCLOAK_CLIENT_ID',
  'KEYCLOAK_URL',
  'KEYCLOAK_REALM',
  'KEYCLOAK_ENABLED',
  'BANNER_COLOUR',
  'USE_MOCK_DATA'
];

// The keys GET /config/public may serve to the PUBLIC site. Its own list, not a slice of
// OVERRIDABLE_KEYS: the two documents answer different frontends, and a key added for the DEMI
// admin console must not become public because the lists were shared.
//
// This is eagle-api's own PUBLIC_KEYS (api/controllers/config.js) minus KEYCLOAK_* — the public
// site does not log in — and minus ANALYTICS_API_URL, a constant shim eagle-api keeps for an
// Angular version this endpoint has no reason to carry.
//
// Adding a key here publishes it to anonymous callers the moment the document carries it, so the
// same rule as above applies: nothing that is not already public information.
const PUBLIC_KEYS = [
  'ENVIRONMENT',
  'BANNER_COLOUR',
  'LOG_LEVEL',
  'API_PATH',
  'SEARCH_API_PATH',
  'DEMI_PROJECTS_PATH',
  'ADMIN_PATH',
  'CONTENT_SEARCH',
  'EAGLE_ANALYTICS_URL',
  'APPINSIGHTS_CONNECTION_STRING',
  'SURVEY_URL',
  'SHOW_SURVEY_BANNER',
  'ACCESS_GATE'
];

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
  const candidates = [
    path.join(__dirname, '../../build-id.txt'),
    path.join(process.cwd(), 'build-id.txt')
  ];
  const errors = [];
  for (const candidate of candidates) {
    try {
      return fs.readFileSync(candidate, 'utf8').trim();
    } catch (err) {
      errors.push(`${candidate} (${err.code})`);
    }
  }
  logger.warn(`build-id.txt not found, tried: ${errors.join(', ')}`);
  return process.env.BUILD_ID || 'unknown';
})();

/**
 * What the app settings say, on their own. This is the whole payload when the `config` container
 * is empty or unreachable, and it is exactly what this endpoint returned before it read Cosmos.
 */
function fromEnvironment() {
  return {
    // A short git sha plus a deploy timestamp. Public information; this endpoint is
    // unauthenticated and must stay free of anything that is not.
    BUILD_ID,
    ENVIRONMENT: process.env.ENVIRONMENT || config.env || 'dev',
    // '' = same-origin /api. Azure drops empty-valued app settings from the env, so the
    // default lives here and no app setting declares it.
    API_LOCATION: process.env.API_LOCATION || '',
    API_PATH: process.env.API_PATH || '/api',
    KEYCLOAK_CLIENT_ID: process.env.KEYCLOAK_CLIENT_ID || 'eagle-admin-console',
    KEYCLOAK_URL: process.env.KEYCLOAK_URL || 'https://dev.loginproxy.gov.bc.ca/auth',
    KEYCLOAK_REALM: process.env.KEYCLOAK_REALM || 'eao-epic',
    KEYCLOAK_ENABLED: process.env.KEYCLOAK_ENABLED !== 'false',
    BANNER_COLOUR: process.env.BANNER_COLOUR || 'blue',
    USE_MOCK_DATA: process.env.USE_MOCK_DATA === 'true',
    configEndpoint: true
  };
}

/**
 * Returns dynamic runtime configuration to the frontend.
 *
 * This endpoint is UNAUTHENTICATED — everything returned here is public. Never add
 * secrets, API keys, or connection strings. The frontend reaches the search backend only
 * through GET /api/search, so no search endpoint or key belongs in this payload.
 *
 * Values come from the `config` container, overlaid on the app settings. Two consequences worth
 * knowing:
 *
 *   - This used to be a fast non-DB route and no longer
 *     is. A Cosmos failure must NOT take the frontend down, so a failed read logs and serves the
 *     app-settings payload — the same answer this endpoint gave before the container existed.
 *
 *   - Stored values are real JSON, so `KEYCLOAK_ENABLED: false` arrives as a boolean rather than
 *     through a string comparison. That closes the `string(bool)` trap where Bicep emits 'True'
 *     and the comparison is against 'true' — the bug that had the summariser silently switched
 *     off. Only accept a boolean from the document; anything else falls through to the env var.
 */
exports.getConfig = async (req, res) => {
  const payload = fromEnvironment();

  let stored = null;
  try {
    stored = await configRepository.get();
  } catch (err) {
    logger.error(`[config] Cosmos read failed, serving app settings: ${err.message}`);
  }

  if (stored) {
    for (const key of OVERRIDABLE_KEYS) {
      const value = stored[key];
      if (value === undefined || value === null) continue;
      if (typeof payload[key] === 'boolean' && typeof value !== 'boolean') continue;
      payload[key] = value;
    }
  }

  res.json(payload);
};

/**
 * Returns the PUBLIC site's runtime configuration, straight from the `public` document.
 *
 * UNAUTHENTICATED, like /config above, and the same rule holds: everything here is public, so
 * never add a secret. What is served is exactly the `PUBLIC_KEYS` the document carries — no app
 * settings overlay and no defaults, because this container is not where those values come from.
 * eagle-api's Mongo `Config` is the source of truth; this document is a seeded copy of it.
 *
 * A missing or unreadable document answers 503, where /config degrades to app settings. The
 * difference is deliberate and it is the whole reason this is a separate route: a defaulted
 * payload would serve `ACCESS_GATE: false` and open the access curtain on a site that is meant to
 * be gated. Refusing to answer is safe — eagle-public falls back to eagle-api's /api/config —
 * while answering with a guess is not. `no-store` so no cache can hold the refusal, or serve it
 * on after the document is seeded.
 */
exports.getPublicConfig = async (req, res) => {
  let stored;
  try {
    stored = await configRepository.getPublic();
  } catch (err) {
    logger.error(`[config] public config read failed: ${err.message}`);
    return res.set('Cache-Control', 'no-store').status(503)
      .json({ error: 'Public configuration is unavailable.' });
  }

  if (!stored) {
    logger.error('[config] public config document is not seeded — see src/scripts/seed-public-config.js');
    return res.set('Cache-Control', 'no-store').status(503)
      .json({ error: 'Public configuration is unavailable.' });
  }

  const payload = {};
  for (const key of PUBLIC_KEYS) {
    const value = stored[key];
    // Only absence is skipped. A stored `false` — ACCESS_GATE above all — is a real answer and
    // must survive as a boolean; treating it as missing is how the curtain opens.
    if (value === undefined || value === null) continue;
    payload[key] = value;
  }

  res.json(payload);
};

// Exported for src/scripts/seed-public-config.js, so the seeded document and the served payload
// are filtered by ONE list rather than two that drift.
exports.PUBLIC_KEYS = PUBLIC_KEYS;
