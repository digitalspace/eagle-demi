'use strict';

// A kind is `{ repo, consumers, reconcile }`: the repository the worker re-reads and etag-writes a row through,
// consumer names in `./index.js`, and a hook whose `{ repair: true }` re-queues drifted rows.

const commentPeriods = require('../repositories/comment-periods');
const documents = require('../repositories/documents');
const lists = require('../repositories/lists');
const projects = require('../repositories/projects');
const pending = require('./pending');

const COMMENT_PERIOD = 'commentPeriod';
const DOCUMENT = 'document';
const ORGANIZATION = 'organization';
const PROJECT = 'project';

/**
 * The ENGAGE checks, then the pending hook, which alone sees native rows and lapsed create claims.
 * Resolves to the pending report with the ENGAGE report under `engage`.
 */
async function reconcileCommentPeriods(options = {}) {
  // Required on call: the script requires sync-out itself.
  const engage = await require('../scripts/reconcile-engage').run(options);
  const deps = pending.depsFor(COMMENT_PERIOD);
  // A row the ENGAGE pass re-queued reads as unsent now; a second message would only be skipped as current.
  const requeued = new Set(options.repair
    ? [...engage.neverSynced, ...engage.missingInEagle, ...engage.drift].map(f => f.id) : []);
  const repo = {
    listSyncPending: async () => (await deps.repo.listSyncPending()).filter(row => !requeued.has(String(row.id)))
  };
  return { ...(await pending.reconcile(options, { ...deps, repo })), engage };
}

// No pins kind: after F1 eagle-admin and eagle-public read and write pins on DEMI's project; on eagle-api only the
// pin routes eagle-admin stops calling use `pins` and `pinsRead`.
const KINDS = Object.freeze({
  // eagle-admin writes comments through eagle-api until F3; that handler takes the period's `commentIdCount`
  // (comment.js getNextCommentIdCount) and comment reads gate on the period (helpers/parentRead.js).
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
