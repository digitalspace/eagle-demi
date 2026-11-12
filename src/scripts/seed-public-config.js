'use strict';

/**
 * Seed the `public` config document from eagle-api's live `GET /api/config`: bootstrap and manual
 * override only, since eagle-api pushes later writes. Dry run unless `--live`; `--force` overwrites.
 */

const { pickPublicKeys } = require('../controllers/config');
const configRepository = require('../repositories/config');
const sources = require('../seed/sources');
const config = require('../config');
const { logger } = require('../utils/logger');

// `config.environmentName` is ENVIRONMENT and only ENVIRONMENT — the one name api-function-flex
// .bicep sets — so it is what picks the source below.

/** Where eagle-api answers, per environment. Overridden wholesale by `EAGLE_CONFIG_URL`. */
const DEFAULT_CONFIG_URLS = {
  dev: 'https://eagle-dev.apps.silver.devops.gov.bc.ca/api/config',
  test: 'https://eagle-test.apps.silver.devops.gov.bc.ca/api/config',
  prod: 'https://projects.eao.gov.bc.ca/api/config'
};

function parseArgs(argv) {
  return {
    live: argv.includes('--live'),
    force: argv.includes('--force')
  };
}

/**
 * An unknown ENVIRONMENT throws: falling back to dev would publish dev paths to the public site and
 * look like it worked.
 */
function eagleConfigUrl(env = config.environmentName) {
  if (process.env.EAGLE_CONFIG_URL) return process.env.EAGLE_CONFIG_URL;
  const url = DEFAULT_CONFIG_URLS[env];
  if (!url) {
    throw new Error(
      `No default eagle-api config URL for ENVIRONMENT '${env}' ` +
      `(known: ${Object.keys(DEFAULT_CONFIG_URLS).join(', ')}). Set EAGLE_CONFIG_URL.`);
  }
  return url;
}

/**
 * The controller's own filter, so seeded and pushed documents match. Absent keys stay absent (the
 * controller defaults nothing); a stored `false` is kept.
 */
function buildDocument(payload) {
  return pickPublicKeys(payload);
}

async function seed(argv, deps = {}) {
  const fetchJson = deps.fetchJson || sources.fetchJson;
  const repository = deps.repository || configRepository;

  const args = parseArgs(argv);
  const url = eagleConfigUrl();

  logger.info(`[seed-public-config] reading ${url}`);
  const payload = await fetchJson(url);
  const doc = buildDocument(payload);

  // No ENVIRONMENT means not eagle-api's config, such as a JSON error envelope; refuse rather than
  // seed an empty document the controller would serve.
  if (!doc.ENVIRONMENT) {
    throw new Error(`${url} answered without ENVIRONMENT — that is not an eagle-api config payload.`);
  }

  logger.info(`[seed-public-config] document to write:\n${JSON.stringify(doc, null, 2)}`);

  const existing = await repository.getPublic();
  if (existing && !args.force) {
    logger.info('[seed-public-config] a public config document already exists. Re-run with ' +
      `--force to overwrite it:\n${JSON.stringify(existing, null, 2)}`);
    return { written: false, document: doc };
  }

  if (!args.live) {
    logger.info('[seed-public-config] DRY RUN — nothing written. Re-run with --live.');
    return { written: false, document: doc };
  }

  const written = await repository.upsertPublic(doc);
  logger.info(`[seed-public-config] written:\n${JSON.stringify(written, null, 2)}`);
  return { written: true, document: written };
}

module.exports = {
  DEFAULT_CONFIG_URLS,
  parseArgs,
  eagleConfigUrl,
  buildDocument,
  seed
};

if (require.main === module) {
  const { initCosmosClient } = require('../db/cosmos-nosql');

  initCosmosClient();
  seed(process.argv.slice(2))
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error(`[seed-public-config] failed: ${err.message}`, { stack: err.stack });
      process.exit(1);
    });
}
