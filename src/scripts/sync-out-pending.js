'use strict';

/**
 * Runs one sync-out kind's reconcile hook: lists rows with a version not yet sent; `--repair` re-queues them.
 * Comment periods run the ENGAGE checks first. Runs on the devbox via `demi-run`.
 */

const { KINDS } = require('../sync-out/kinds');
const { reconcileOf } = require('../sync-out/reconcile');
const { logger } = require('../utils/logger');

const TAG = '[sync-out pending]';
const USAGE = `usage: node src/scripts/sync-out-pending.js --kind <${Object.keys(KINDS).join('|')}> [--repair] [--help]`;

function parseArgs(argv) {
  const args = { kind: null, repair: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repair') args.repair = true;
    else if (a === '--help') args.help = true;
    else if (a === '--kind') args.kind = argv[++i] || null;
    else throw new Error(`${TAG} unknown argument: ${a}`);
  }
  if (!args.help && !Object.hasOwn(KINDS, args.kind || '')) throw new Error(`${TAG} ${USAGE}`);
  return args;
}

async function run({ kind, repair }, reconcile = reconcileOf(kind)) {
  const report = await reconcile({ repair });
  const engage = report.engage || {};
  const problems = [
    engage.error && `ENGAGE checks failed: ${engage.error}`,
    engage.notRequeued && engage.notRequeued.length &&
      `${engage.notRequeued.length} ENGAGE row(s) not re-queued: ${engage.notRequeued.join(', ')}`,
    report.failed.length && `${report.failed.length} row(s) not re-queued: ${report.failed.join(', ')}`
  ].filter(Boolean);
  if (problems.length) throw new Error(problems.join('; '));
  return report;
}

module.exports = { parseArgs, run };

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    logger.error(err.message);
    process.exit(1);
  }
  if (args.help) {
    logger.info(USAGE);
    process.exit(0);
  }
  require('../db/cosmos-nosql').initCosmosClient();
  run(args).catch((err) => {
    logger.error(`${TAG} ${err.stack || err.message}`);
    process.exit(1);
  });
}
