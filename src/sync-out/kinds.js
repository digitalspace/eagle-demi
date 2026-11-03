'use strict';

// A kind is `{ repo, consumers, reconcile }`: the repository the worker re-reads and etag-writes a row through,
// consumer names in `./index.js`, and a hook whose `{ repair: true }` re-queues drifted rows.

const commentPeriods = require('../repositories/comment-periods');
const comments = require('../repositories/comments');
const documents = require('../repositories/documents');
const lists = require('../repositories/lists');
const notifications = require('../repositories/notifications');
const projects = require('../repositories/projects');
const updates = require('../repositories/updates');
const pending = require('./pending');
const { logger } = require('../utils/logger');

const COMMENT = 'comment';
const COMMENT_PERIOD = 'commentPeriod';
const DOCUMENT = 'document';
const NOTIFICATION = 'notification';
const ORGANIZATION = 'organization';
const PROJECT = 'project';
const UPDATE = 'update';

/**
 * The ENGAGE checks, then the pending hook, which alone sees native rows and lapsed send claims. Resolves to the
 * pending report with the ENGAGE report, or `{ error }` when that pass threw, under `engage`.
 */
async function reconcileCommentPeriods(options = {}) {
  let engage;
  try {
    // Required on call: the script requires sync-out itself.
    engage = await require('../scripts/reconcile-engage').run(options);
  } catch (err) {
    engage = { error: err.message };
    logger.error('[sync-out pending] commentPeriod: ENGAGE checks failed, pending pass runs anyway',
      { error: err.message, stack: err.stack });
  }
  // A row both passes queue gets a second message, which the worker skips as current.
  return { ...(await pending.reconcile(options, pending.depsFor(COMMENT_PERIOD))), engage };
}

// No pins kind: no client still reads pins from eagle-api (docs/eagle-api-port.md, Pins, Sync-out).
const KINDS = Object.freeze({
  // Eagle's POST numbers a comment from the period's `commentIdCount` and the echo copies it onto the DEMI row
  // (controllers/nosql/comment.js); until then DEMI's own number can repeat one Eagle gave another comment.
  [COMMENT]: Object.freeze({
    // Partitioned on periodId, which a message does not carry, so the read is by id alone.
    repo: Object.freeze({
      readForWrite: (id) => comments.readForWrite(id),
      listSyncPending: () => comments.listSyncPending(),
      upsert: (item, existing) => comments.upsert(item, existing)
    }),
    consumers: Object.freeze(['eagle']),
    reconcile: (options) => pending.reconcile(options, pending.depsFor(COMMENT))
  }),
  // eagle-api's comment POST takes the period's `commentIdCount`, and comment reads gate on the period
  // (helpers/parentRead.js).
  [COMMENT_PERIOD]: Object.freeze({
    repo: commentPeriods,
    consumers: Object.freeze(['eagle']),
    reconcile: reconcileCommentPeriods
  }),
  // eagle-admin writes documents through eagle-api until F10 (PUT, publish, feature); those handlers read
  // Eagle's copy of the document.
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
  // ENGAGE met-api reads eagle-api `/projectNotification/:id` until the EN slice, and eagle-api's
  // recentActivity aggregate looks up projectNotification.
  [NOTIFICATION]: Object.freeze({
    repo: Object.freeze({
      readForWrite: (id) => notifications.readForWrite(id),
      listSyncPending: () => notifications.listSyncPending(),
      upsert: (item, existing) => notifications.upsert(item, existing)
    }),
    consumers: Object.freeze(['eagle']),
    reconcile: (options) => pending.reconcile(options, pending.depsFor(NOTIFICATION))
  }),
  // A project's proponent and an organization's parentCompany are sent by Eagle id, and eagle-api's project reads
  // join `proponent` to the organization (helpers/aggregators.js).
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
  // eagle-api's document handlers, which eagle-admin writes through until F10, read the parent project
  // (document.js featureDocument counts featured documents per project).
  [PROJECT]: Object.freeze({
    repo: Object.freeze({
      readForWrite: (id) => projects.readForWrite(id),
      listSyncPending: () => projects.listSyncPending(),
      // Guarded on the stored row's etag, so two deliveries cannot both take the create claim.
      upsert: (item, existing) => projects.upsert(item, { etag: existing._etag })
    }),
    consumers: Object.freeze(['eagle']),
    reconcile: (options) => pending.reconcile(options, pending.depsFor(PROJECT))
  }),
  // eagle-api's `/public/recentActivity` serves Updates from Eagle's own copy until F5.
  [UPDATE]: Object.freeze({
    repo: Object.freeze({
      readForWrite: (id) => updates.readForWrite(id),
      listSyncPending: () => updates.listSyncPending(),
      upsert: (item, existing) => updates.upsert(item, existing)
    }),
    consumers: Object.freeze(['eagle']),
    reconcile: (options) => pending.reconcile(options, pending.depsFor(UPDATE))
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

module.exports = {
  KINDS, COMMENT, COMMENT_PERIOD, DOCUMENT, NOTIFICATION, ORGANIZATION, PROJECT, UPDATE, DEFAULT_KIND, kindOf, versionOf, nextSyncVersion
};
