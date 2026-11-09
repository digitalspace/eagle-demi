'use strict';

// Each kind's reconcile hook: `{ repair: true }` re-queues drifted rows. Built from `KINDS`, so every kind has one.

const { KINDS, COMMENT_PERIOD, kindOf } = require('./kinds');
const pending = require('./pending');
const reconcileEngage = require('../scripts/reconcile-engage');
const { logger } = require('../utils/logger');

/**
 * The ENGAGE checks, then the pending hook, which alone sees native rows and lapsed send claims. Resolves to the
 * pending report with the ENGAGE report, or `{ error }` when that pass threw, under `engage`.
 */
async function reconcileCommentPeriods(options = {}) {
  let engage;
  try {
    engage = await reconcileEngage.run(options);
  } catch (err) {
    engage = { error: err.message };
    logger.error('[sync-out pending] commentPeriod: ENGAGE checks failed, pending pass runs anyway',
      { error: err.message, stack: err.stack });
  }
  // A row both passes queue gets a second message, which the worker skips as current.
  return { ...(await pending.reconcile(options, pending.depsFor(COMMENT_PERIOD))), engage };
}

const HOOKS = Object.freeze(Object.fromEntries(Object.keys(KINDS).map((kind) => [
  kind,
  kind === COMMENT_PERIOD ? reconcileCommentPeriods : (options) => pending.reconcile(options, pending.depsFor(kind))
])));

/** The reconcile hook of kind `name`; throws for an unregistered name. */
function reconcileOf(name) {
  kindOf(name);
  return HOOKS[name];
}

module.exports = { HOOKS, reconcileOf };
