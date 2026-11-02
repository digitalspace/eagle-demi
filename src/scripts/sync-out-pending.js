'use strict';

/**
 * Runs one sync-out kind's reconcile hook: lists rows with a version not yet sent, and `--repair` re-queues
 * them. For comment periods the ENGAGE checks of reconcile-engage.js run first. Runs on the devbox via
 * `demi-run`, like reconcile-engage.js.
 */

const { KINDS, kindOf } = require('../sync-out/kinds');
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

async function run({ kind, repair }, reconcile = kindOf(kind).reconcile) {
  const report = await reconcile({ repair });
  if (report.engage && report.engage.error) throw new Error(`ENGAGE checks failed: ${report.engage.error}`);
  if (report.failed.length) throw new Error(`${report.failed.length} row(s) not re-queued: ${report.failed.join(', ')}`);
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
