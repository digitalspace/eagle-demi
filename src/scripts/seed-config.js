'use strict';

// Usage: node src/scripts/seed-config.js [--live [--force]]; no flags prints the document and writes nothing.
// Run on the devbox via `demi-run`: Cosmos is private-endpoint-only and keyless, so a laptop cannot reach it.

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

// argv and deps are injectable so tests can run main() without Cosmos.
async function main(argv = process.argv.slice(2), deps = {}) {
  const repo = deps.configRepository || configRepository;
  const args = parseArgs(argv);
  const doc = buildDocument();

  console.log('Seeding config document from app settings:');
  console.log(JSON.stringify(doc, null, 2));

  const existing = await repo.get();
  if (existing && !args.force) {
    console.log('\nA config document already exists. Re-run with --force to overwrite it:');
    console.log(JSON.stringify(existing, null, 2));
    return;
  }

  if (!args.live) {
    console.log('\nDRY RUN — nothing written. Re-run with --live.');
    return;
  }

  const written = await repo.upsert(doc);
  console.log('\nWritten:');
  console.log(JSON.stringify(written, null, 2));
}

module.exports = { main };

if (require.main === module) {
  main().catch((err) => {
    console.error('[seed-config] failed:', err);
    process.exitCode = 1;
  });
}
