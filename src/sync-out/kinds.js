'use strict';

/**
 * Sync-out kinds: the row types sync-out sends. Each message names its kind, and the worker re-reads
 * and writes the row through that kind's repository.
 *
 * A kind is `{ repo, consumers, reconcile }`:
 * - `repo`: the kind's repository; sync-out re-reads the row through it and writes back etag-guarded.
 * - `consumers`: names of the consumers in `./index.js` that send this kind.
 * - `reconcile(options)`: checks the kind's rows against what the consumers wrote; `{ repair: true }`
 *   re-queues the ones that drifted.
 *
 * A Flip adds its kind here and its consumer to the list in `./index.js`.
 */

const commentPeriods = require('../repositories/comment-periods');

const COMMENT_PERIOD = 'commentPeriod';

const KINDS = Object.freeze({
  [COMMENT_PERIOD]: Object.freeze({
    repo: commentPeriods,
    consumers: Object.freeze(['eagle']),
    // Required on call: the script requires sync-out itself.
    reconcile: (options) => require('../scripts/reconcile-engage').run(options)
  })
});

/** The kind of a message that names none: messages queued before kinds existed were all comment periods. */
const DEFAULT_KIND = COMMENT_PERIOD;

/** A row's `syncVersion`, 0 for a row that has none. Every kind's rows carry it. */
const versionOf = (row) => (row && Number.isInteger(row.syncVersion) ? row.syncVersion : 0);

/** The `syncVersion` a write over `current` stores: one past it, 1 for a create. */
const nextSyncVersion = (current) => versionOf(current) + 1;

/** The registered kind `name`; throws for any other name. */
function kindOf(name) {
  if (!Object.hasOwn(KINDS, name)) throw new Error(`sync-out has no kind named ${name}`);
  return KINDS[name];
}

module.exports = { KINDS, COMMENT_PERIOD, DEFAULT_KIND, kindOf, versionOf, nextSyncVersion };
