'use strict';

/**
 * Seeds the `public` config document that GET /api/config/public serves to eagle-public.
 *
 * It seeds FROM eagle-api's own live `GET /api/config`, so the first read after seeding returns
 * what eagle-public was already booting on. Parity is by construction rather than by
 * transcription — there is no table here to keep in step with Mongo.
 *
 * eagle-api's Mongo `Config` collection stays the source of truth. Nothing pushes it here and
 * nothing writes back: eagle-api has no Config write controller to push from, and the document is
 * edited in Mongo by hand. A hand edit therefore leaves this copy stale until somebody re-runs
 * this script, which is the trade for not building a write path. `epic_config_check` reports the
 * drift; it does not fix it.
 *
 * MUST RUN ON THE DEVBOX (`demi-devbox-<env>`) via `demi-run`. `demi-cosmos-*` is
 * private-endpoint-only and keyless, reachable as the app's managed identity and from nowhere
 * else; a laptop with `az` logged in cannot reach it. Same constraint as `seed-config.js`; see
 * README.md for the recipe.
 *
 * Usage:
 *   node src/scripts/seed-public-config.js                  # print what would be written
 *   node src/scripts/seed-public-config.js --live           # write it
 *   node src/scripts/seed-public-config.js --live --force   # overwrite an existing document
 *
 * The source URL comes from `EAGLE_CONFIG_URL`, defaulting per `ENVIRONMENT` — the environment is
 * chosen by the settings the process starts with, never by a flag, as every other database script
 * does it.
 *
 * Only the keys the controller will serve (`PUBLIC_KEYS`) are stored. Storing eagle-api's whole
 * payload would put `BUILD_ID`, `API_LOCATION` and the `KEYCLOAK_*` block in a document that
 * exists to be read by an anonymous public site, where none of them mean anything.
 */

const { PUBLIC_KEYS } = require('../controllers/config');
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
 * The eagle-api /api/config URL this run reads.
 *
 * An unrecognised ENVIRONMENT throws rather than falling back to dev: seeding the test or prod
 * container from the dev payload would publish dev paths to the public site, and it would look
 * like it worked.
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
 * eagle-api's payload, filtered to what this API will serve.
 *
 * Absent keys stay absent — the controller serves what the document carries and defaults nothing,
 * so writing a null here would be a value the public site then has to interpret. A stored `false`
 * IS a value and is kept.
 */
function buildDocument(payload) {
  const doc = {};
  for (const key of PUBLIC_KEYS) {
    const value = payload[key];
    if (value === undefined || value === null) continue;
    doc[key] = value;
  }
  return doc;
}

async function seed(argv, deps = {}) {
  const fetchJson = deps.fetchJson || sources.fetchJson;
  const repository = deps.repository || configRepository;

  const args = parseArgs(argv);
  const url = eagleConfigUrl();

  logger.info(`[seed-public-config] reading ${url}`);
  const payload = await fetchJson(url);
  const doc = buildDocument(payload);

  // A payload missing ENVIRONMENT is not eagle-api's config: an rproxy that fell through to the
  // SPA answers 200 with index.html, and JSON.parse would have thrown, but a JSON error envelope
  // would not. Refusing here beats seeding an empty document the controller then serves.
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
