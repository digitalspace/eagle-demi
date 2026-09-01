'use strict';

/**
 * Seeds the single `config` document that GET /api/config overlays on the app settings.
 *
 * It seeds FROM the app settings of the container it runs in, so the first read after seeding
 * returns byte-for-byte what the endpoint returned before the container existed. Parity is by
 * construction rather than by transcription — there is no table here to drift out of date.
 *
 * MUST RUN ON THE DEVBOX (`demi-devbox-<env>`) via `demi-run`. `demi-cosmos-*` is
 * private-endpoint-only and keyless, reachable as the app's managed identity and from nowhere
 * else; a laptop with `az` logged in cannot reach it. Kudu's /api/command will not do either —
 * the SCM container has no managed-identity endpoint. Same constraint as
 * `export-chunks-to-eagle.js`; see README.md for the recipe.
 *
 * Usage:
 *   node src/scripts/seed-config.js                  # print what would be written, write nothing
 *   node src/scripts/seed-config.js --live           # write it
 *   node src/scripts/seed-config.js --live --force   # overwrite an existing document
 *
 * Deliberately seeds only the keys the controller will accept from the document
 * (`OVERRIDABLE_KEYS`). API_LOCATION, API_PATH and BUILD_ID are not among them: the first two are
 * what the frontend bootstraps from, and BUILD_ID has to keep coming from the deploy package or it
 * stops proving which build is answering.
 */

const configRepository = require('../repositories/config');
const config = require('../config');

function parseArgs(argv) {
  return {
    live: argv.includes('--live'),
    force: argv.includes('--force')
  };
}

/**
 * The overridable subset of what `controllers/config.js` currently derives from app settings.
 * Booleans are stored as real JSON booleans — that is the point of moving them here.
 */
function buildDocument() {
  return {
    ENVIRONMENT: process.env.ENVIRONMENT || config.env || 'dev',
    KEYCLOAK_CLIENT_ID: process.env.KEYCLOAK_CLIENT_ID || 'eagle-admin-console',
    KEYCLOAK_URL: process.env.KEYCLOAK_URL || 'https://dev.loginproxy.gov.bc.ca/auth',
    KEYCLOAK_REALM: process.env.KEYCLOAK_REALM || 'eao-epic',
    KEYCLOAK_ENABLED: process.env.KEYCLOAK_ENABLED !== 'false',
    BANNER_COLOUR: process.env.BANNER_COLOUR || 'blue',
    USE_MOCK_DATA: process.env.USE_MOCK_DATA === 'true'
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const doc = buildDocument();

  console.log('Seeding config document from app settings:');
  console.log(JSON.stringify(doc, null, 2));

  const existing = await configRepository.get();
  if (existing && !args.force) {
    console.log('\nA config document already exists. Re-run with --force to overwrite it:');
    console.log(JSON.stringify(existing, null, 2));
    return;
  }

  if (!args.live) {
    console.log('\nDRY RUN — nothing written. Re-run with --live.');
    return;
  }

  const written = await configRepository.upsert(doc);
  console.log('\nWritten:');
  console.log(JSON.stringify(written, null, 2));
}

main().catch((err) => {
  console.error('[seed-config] failed:', err);
  process.exitCode = 1;
});
