'use strict';

const { logger } = require('../utils/logger');

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

// Exported for src/scripts/seed-public-config.js, so the seeded document, the pushed one and the
// served payload are filtered by ONE list rather than three that drift.
module.exports = { PUBLIC_KEYS, pickPublicKeys };
