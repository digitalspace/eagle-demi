'use strict';

/**
 * Sync-out kinds: the row types sync-out sends. Each message names its kind, and the worker re-reads
 * and writes the row through that kind's repository.
 *
 * A kind is `{ repo, consumers, reconcile }`:
 * - `repo`: the kind's repository; sync-out re-reads the row through it and writes back etag-guarded.
 * - `consumers`: names of the consumers in `./index.js` that send this kind; names repeat across kinds.
 * - `reconcile(options)`: checks the kind's rows against what the consumers wrote; `{ repair: true }`
 *   re-queues the ones that drifted.
 *
 * A Flip adds its kind here and its consumers to that kind's list in `./index.js`.
 */

const commentPeriods = require('../repositories/comment-periods');
const documents = require('../repositories/documents');
const lists = require('../repositories/lists');
const projects = require('../repositories/projects');
const pending = require('./pending');

const COMMENT_PERIOD = 'commentPeriod';
const DOCUMENT = 'document';
const ORGANIZATION = 'organization';
const PROJECT = 'project';

const KINDS = Object.freeze({
  [COMMENT_PERIOD]: Object.freeze({
    repo: commentPeriods,
    consumers: Object.freeze(['eagle']),
    // Required on call: the script requires sync-out itself.
    reconcile: (options) => require('../scripts/reconcile-engage').run(options)
  }),
  [DOCUMENT]: Object.freeze({
    // Called through the module, so a stub on the repository reaches the engine. The plain upsert never reads `_etag`.
    repo: Object.freeze({
      readForWrite: (id, projectId) => documents.readForWrite(id, projectId),
      listSyncPending: () => documents.listSyncPending(),
      upsert: (item, existing) => documents.upsertForSync(item, existing)
    }),
    consumers: Object.freeze(['eagle']),
    reconcile: (options) => pending.reconcile(options, pending.depsFor(DOCUMENT))
  }),
  [ORGANIZATION]: Object.freeze({
    // `lists` is partitioned on kind, so the read names it; a message's null projectId would miss the row.
    repo: Object.freeze({
      readForWrite: (id) => lists.readForWrite(id, lists.KINDS.ORGANIZATION),
      listSyncPending: () => lists.listSyncPending(lists.KINDS.ORGANIZATION),
      upsert: (item, existing) => lists.upsert(item, existing)
    }),
    consumers: Object.freeze(['eagle']),
    reconcile: (options) => pending.reconcile(options, pending.depsFor(ORGANIZATION))
  }),
  [PROJECT]: Object.freeze({
    repo: Object.freeze({
      readForWrite: (id) => projects.readForWrite(id),
      listSyncPending: () => projects.listSyncPending(),
      // Guarded on the stored row's etag, or a create, so two deliveries cannot both take the create claim.
      upsert: (item, existing) => projects.upsert(item, existing ? { etag: existing._etag } : { create: true })
    }),
    consumers: Object.freeze(['eagle']),
    reconcile: (options) => pending.reconcile(options, pending.depsFor(PROJECT))
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

module.exports = { KINDS, COMMENT_PERIOD, DOCUMENT, ORGANIZATION, PROJECT, DEFAULT_KIND, kindOf, versionOf, nextSyncVersion };
