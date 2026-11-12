'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const configRepository = require('../repositories/config');
const { serverError } = require('../helpers/response');
const { auditEvent } = require('../utils/audit');
const { logger } = require('../utils/logger');

// The only gate on what the stored document may publish. API_LOCATION, API_PATH and BUILD_ID are
// absent on purpose: the first two come from env.js at deploy time, BUILD_ID from the package.
const OVERRIDABLE_KEYS = [
  'ENVIRONMENT',
  'KEYCLOAK_CLIENT_ID',
  'KEYCLOAK_URL',
  'KEYCLOAK_REALM',
  'KEYCLOAK_ENABLED',
  'BANNER_COLOUR',
  'USE_MOCK_DATA'
];

// Served to anonymous callers: add only public values. Kept apart from OVERRIDABLE_KEYS so an admin
// console key never turns public; eagle-api's PUBLIC_KEYS minus KEYCLOAK_*, CENTRE_API_URL, ANALYTICS_API_URL.
const PUBLIC_KEYS = [
  'ENVIRONMENT',
  'BANNER_COLOUR',
  'LOG_LEVEL',
  'API_PATH',
  'SEARCH_API_PATH',
  'DEMI_PROJECTS_PATH',
  'DEMI_API_PATH',
  'ADMIN_PATH',
  'CONTENT_SEARCH',
  'EAGLE_ANALYTICS_URL',
  'APPINSIGHTS_CONNECTION_STRING',
  'SURVEY_URL',
  'SHOW_SURVEY_BANNER',
  'ACCESS_GATE',
  'EXTENDED_PROJECT_PAGES'
];

// Lower case only, unlike the shared projects pattern: the public site matches ids by exact string,
// so an upper-case id would be served and never match. Same rule as eagle-api's validator.
const EXTENDED_PAGE_PROJECT_ID = /^[0-9a-f]{24}$/;
const CONTENT_KEY = /^[a-z0-9-]{1,40}$/;
// Same cap as eagle-api; keeps the config item far under the Cosmos item size limit.
const MAX_EXTENDED_PROJECT_PAGES = 50;

/** EXTENDED_PROJECT_PAGES shape: a plain object of up to 50 Eagle project ids to extended page content keys. */
function isExtendedProjectPages(value) {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const entries = Object.entries(value);
  return entries.length <= MAX_EXTENDED_PROJECT_PAGES && entries.every(([id, contentKey]) =>
    EXTENDED_PAGE_PROJECT_ID.test(id) && typeof contentKey === 'string' && CONTENT_KEY.test(contentKey));
}

// From a file scripts/package-api.py stamps into the package, not an app setting: the old container
// keeps serving after a deploy and would report a new setting, hiding that old code still answers.
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

/** The app-settings payload; served alone when the `config` container is empty or unreachable. */
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
 * UNAUTHENTICATED: never add a secret. A failed Cosmos read serves app settings so the frontend stays up;
 * a boolean key takes only a stored boolean, dodging Bicep's string(bool) 'True' trap.
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
 * `source` narrowed to PUBLIC_KEYS. Only absence is skipped: a `false` ACCESS_GATE is a real
 * answer, and dropping it opens the curtain.
 */
function pickPublicKeys(source) {
  const picked = {};
  for (const key of PUBLIC_KEYS) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    // The one structured key: a malformed map is dropped whole rather than served to anonymous callers.
    if (key === 'EXTENDED_PROJECT_PAGES' && !isExtendedProjectPages(value)) {
      logger.warn('[config] EXTENDED_PROJECT_PAGES is not a map of up to 50 lower-case Eagle project ids to content keys; dropped');
      continue;
    }
    picked[key] = value;
  }
  return picked;
}

/**
 * UNAUTHENTICATED, no defaults. Missing document answers 503 `no-store`, never a guess: a default
 * would serve `ACCESS_GATE: false`. eagle-public then falls back to eagle-api's /api/config.
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

  // Front Door holds a response with no directive for 1 to 3 days; a minute bounds how long a
  // pushed change waits to reach the public site.
  res.set('Cache-Control', 'public, max-age=60').json(pickPublicKeys(stored));
};

/**
 * Refuses a push that is not a config payload, such as a SPA page; a missing ENVIRONMENT or a
 * non-boolean ACCESS_GATE is dangerous, not just wrong.
 *
 * @returns {string|null} the message to answer 400 with, or null when the body may be stored.
 */
function publicConfigRejection(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Body must be a JSON object of public config values.';
  }
  if (typeof body.ENVIRONMENT !== 'string' || body.ENVIRONMENT.trim() === '') {
    return 'ENVIRONMENT must be a non-empty string.';
  }
  if (typeof body.ACCESS_GATE !== 'boolean') {
    return 'ACCESS_GATE must be a boolean.';
  }
  return null;
}

/**
 * PUT /eagle/config/public: eagle-api pushes on every Config write. Body is the payload, not `{ doc }`,
 * and only PUBLIC_KEYS are stored, so eagle-api may send its whole /api/config.
 */
exports.upsertPublicFromEagle = async (req, res) => {
  const rejection = publicConfigRejection(req.body);
  if (rejection) return res.status(400).json({ error: rejection });

  try {
    // Read before write only to name the changed keys; Config edits are rare, not a hot path.
    const previous = await configRepository.getPublic();
    const document = pickPublicKeys(req.body);
    const saved = await configRepository.upsertPublic(document);
    const changed = changedKeys(previous, document);

    auditEvent(req, {
      action: 'config.push',
      targetType: 'config',
      targetId: configRepository.PUBLIC_ITEM_ID,
      // What the row is read for later: which environment's curtain moved, and which keys. The
      // values themselves are already public, so the trail can carry the gate it landed on.
      detail: { environment: document.ENVIRONMENT, accessGate: document.ACCESS_GATE, changed }
    });

    logger.info(
      `[config] public config pushed by eagle-api — ${changeSummary(previous, changed)}`);

    return res.json(pickPublicKeys(saved));
  } catch (err) {
    return serverError(res, err, 'public config push failed');
  }
};

/**
 * Which allowlisted keys the push moved. Compared as JSON so `true` and `'true'` differ, while
 * absent and null match: the served payload skips both.
 */
function changedKeys(previous, document) {
  return PUBLIC_KEYS.filter(key =>
    JSON.stringify((previous && previous[key]) ?? null) !== JSON.stringify(document[key] ?? null));
}

/** The `changedKeys` list as the log line says it. */
function changeSummary(previous, changed) {
  if (!previous) return 'first document written';
  return changed.length ? `changed: ${changed.join(', ')}` : 'no key changed';
}

// Exported for src/scripts/seed-public-config.js, so the seeded document, the pushed one and the
// served payload are filtered by ONE list rather than three that drift.
exports.PUBLIC_KEYS = PUBLIC_KEYS;
exports.pickPublicKeys = pickPublicKeys;
