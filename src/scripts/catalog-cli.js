'use strict';

// The command line both catalog builders share: `--dry-run` is the only argument, and the exit
// code is 1 when the run reports anything missing.

const { logger } = require('../utils/logger');

function parseDryRunArgs(tag, argv) {
  const args = { dryRun: false };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else throw new Error(`[${tag}] unknown argument: ${arg}`);
  }
  return args;
}

/** Runs `run` when `mod` is the entry script, and exits with its result. */
function runWhenMain(mod, tag, run) {
  if (require.main !== mod) return;
  run(parseDryRunArgs(tag, process.argv.slice(2)))
    .then(summary => process.exit(summary.missing > 0 ? 1 : 0))
    .catch((err) => {
      logger.error(`[${tag}] ${err.stack || err.message}`);
      process.exit(1);
    });
}

module.exports = { parseDryRunArgs, runWhenMain };
