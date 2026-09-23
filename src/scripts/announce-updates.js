'use strict';

/**
 * Announce scheduled Updates once their `publishDate` passes.
 *
 *   node src/scripts/announce-updates.js
 *
 * In Azure it is the `announceUpdates` Functions timer in this app (api/index.js, scheduled by
 * ANNOUNCE_UPDATES_SCHEDULE). eagle-api does not push again at `publishDate`, so without this a
 * scheduled update would go live on the site and never reach subscribers. Each row goes through the
 * push path's own `announce`, so the conditional claim keeps it to one email even when a push and a
 * tick race, and a row archived or rescheduled after this run listed it fails the claim.
 *
 * The same list carries claims whose send got no answer, once their lease runs out, up to
 * NOTIFY_MAX_ATTEMPTS in all — a run killed mid-send included.
 */

const updates = require('../repositories/updates');
const notify = require('../services/notify');
const { announce } = require('../controllers/nosql/update');
const { logger } = require('../utils/logger');

// Rows per tick, sent together: each send waits up to 20 s, and a tick must end inside its 5 minutes.
// A backlog drains over the next ticks, oldest first.
const BATCH = 20;

async function run({ now = new Date().toISOString() } = {}) {
  // Dark: claim nothing, or the first real send after wiring would be suppressed.
  if (!notify.configured()) return { due: 0 };

  const due = await updates.listDueForNotify(now, BATCH);
  // `announce` never throws; each row holds its own claim, so they need no ordering among them.
  await Promise.all(due.map(item => announce(item, item, now)));
  if (due.length) logger.info(`[updates] scheduled announce: ${due.length} due`);
  return { due: due.length };
}

module.exports = { run, BATCH };

if (require.main === module) {
  const { initCosmosClient } = require('../db/cosmos-nosql');
  initCosmosClient();

  run().catch(err => {
    logger.error(`[updates] scheduled announce ${err.stack || err.message}`);
    process.exit(1);
  });
}
