'use strict';

/**
 * Diff the published Eagle id sets against the rows the Eagle push mirrored into DEMI.
 *
 * eagle-api hard-deletes with no tombstone, so the push cannot tell DEMI a row is gone. This
 * reports both directions and CHANGES NOTHING — a DEMI row absent from Eagle's public search may
 * equally be one Eagle merely unpublished, and eagle-api gives an anonymous caller no way to tell
 * the two apart (see `unpublishedOrDeleted` below), so there is nothing here it is safe to delete.
 *
 *   node src/scripts/reconcile-eagle.js [--json] [--comments]
 *
 * It covers the containers the Eagle push and the backfill write: projects, documents, comment
 * periods, lists (both kinds), notifications, updates, and — only with `--comments`, which costs
 * one eagle-api round trip per comment period — comments.
 *
 * Runs on the devbox via `demi-run` — same recipe as the other database scripts,
 * see README "Running anything against the database". Alert on the one `drift=` line, clean is 0.
 * The API app also runs `run()` nightly on a Functions timer when RECONCILE_SCHEDULE is set — see
 * api/index.js, and azure/modules/observability.bicep for the alert that reads the line.
 *
 * A document or a comment period only counts as `eagleOnly` when DEMI would hold it — its Eagle
 * `project` ref names a project in the merged registry, or a `ProjectNotification`. That is not a
 * rule restated here: `documentAdmission` IS seed-nosql's own function, run over the same merged
 * project registry. The rest report separately under `unresolvedParent`, since the seed and the
 * mirrors drop them too and they are not push drift.
 */

const sources = require('../seed/sources');
const projects = require('../repositories/projects');
const documents = require('../repositories/documents');
const commentPeriods = require('../repositories/comment-periods');
const comments = require('../repositories/comments');
const lists = require('../repositories/lists');
const notifications = require('../repositories/notifications');
const updates = require('../repositories/updates');
const { buildRegistry, buildProjectIndex } = require('../merge/project');
const { surplusOf, truncatedReads, documentAdmission } = require('./seed-nosql');
const { eachCommentPage } = require('./seed-public-reads');
const { systemAccess, MAX_PAGE_SIZE } = require('../helpers/access-sql');
const { logger } = require('../utils/logger');

/** The containers reported, in the order `report` prints them and `summaryLine` names them. */
const LABELS = ['projects', 'documents', 'commentPeriods', 'lists', 'notifications', 'updates',
  'comments'];

function parseArgs(argv) {
  const args = { json: false, comments: false };
  for (const a of argv) {
    if (a === '--json') args.json = true;
    else if (a === '--comments') args.comments = true;
    else throw new Error(`[reconcile] unknown argument: ${a}`);
  }
  return args;
}

/**
 * Both directions in one pass.
 *
 * `pushOwned` is why projects need every row carrying an `eagleId` and not just the
 * `sourceSystem: 'eagle'` ones: a Track-sourced row also holds an `eagleId`, so reading only the
 * Eagle-sourced rows would compute ~350 matched projects as missing from DEMI. It is in the
 * membership test and out of the push's own drift.
 *
 * @param {Array}    rows             DEMI rows
 * @param {function} keyOf            row -> the Eagle id it mirrors
 * @param {Set}      eagleIds         ids Eagle currently publishes
 * @param {function} pushOwned        row -> is this row the Eagle push's to keep in step
 * @param {function} parentPublished  eagleId -> is the id's parent project published (default: yes)
 */
function diff(rows, keyOf, eagleIds, pushOwned = () => true, parentPublished = () => true) {
  const inDemi = new Set(rows.map(keyOf));
  const absent = surplusOf(rows, keyOf, eagleIds);
  const missing = [...eagleIds].filter(id => !inDemi.has(id));
  return {
    unpublishedOrDeleted: absent.filter(pushOwned),
    trackOnly: absent.filter(row => !pushOwned(row)),
    eagleOnly: missing.filter(parentPublished),
    unresolvedParent: missing.filter(id => !parentPublished(id))
  };
}

/** Every id set a diff produced, as one drift number. */
function driftOf(summary) {
  return LABELS.reduce((total, label) => {
    const s = summary[label];
    return s ? total + s.unpublishedOrDeleted.length + s.eagleOnly.length : total;
  }, 0);
}

/**
 * The line a log alert matches. `drift=0` is clean.
 *
 * A container the run did not sweep says `skipped` rather than zero — `comments` is behind
 * `--comments` and a zero there would read as "no drift" for a sweep that never happened.
 */
function summaryLine(summary) {
  const { projects: p, documents: d } = summary;
  const counts = (label) => {
    const s = summary[label];
    return s
      ? `${label}: unpublishedOrDeleted=${s.unpublishedOrDeleted.length} eagleOnly=${s.eagleOnly.length} `
      : `${label}: skipped `;
  };
  return '[reconcile] ' +
    `projects: unpublishedOrDeleted=${p.unpublishedOrDeleted.length} eagleOnly=${p.eagleOnly.length} ` +
    `documents: unpublishedOrDeleted=${d.unpublishedOrDeleted.length} eagleOnly=${d.eagleOnly.length} ` +
    `unresolvedParent=${d.unresolvedParent.length} ` +
    counts('commentPeriods') + counts('lists') + counts('notifications') + counts('updates') +
    counts('comments') +
    `drift=${summary.drift}`;
}

/**
 * Every published id of one `/search` dataset.
 *
 * `fetchAllPages` throws on a short read, so an id missing here is an id Eagle does not publish
 * rather than one a truncated fetch did not reach.
 */
async function eagleIds(src, dataset, into = new Set(), onRow) {
  for (const row of await src.fetchAllPages(src.EAGLE_API_BASE, dataset)) {
    into.add(String(row._id));
    if (onRow) onRow(row);
  }
  return into;
}

/**
 * @param {string[]} argv
 * @param {object} [deps] test seam: {sources, projects, documents, commentPeriods, comments,
 *   lists, notifications, updates}
 */
async function reconcile(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const src = deps.sources || sources;
  const projectsRepo = deps.projects || projects;
  const documentsRepo = deps.documents || documents;
  const periodsRepo = deps.commentPeriods || commentPeriods;
  const commentsRepo = deps.comments || comments;
  const listsRepo = deps.lists || lists;
  const notificationsRepo = deps.notifications || notifications;
  const updatesRepo = deps.updates || updates;

  // systemAccess(), because a scoped context lists only what it can see: every row it cannot read
  // would compute as Eagle-only drift, and every unpublished row as gone from Eagle.
  const access = systemAccess();

  const summary = {
    eagle: src.EAGLE_API_BASE, projects: {}, documents: {}, drift: 0, failures: []
  };

  // Eagle first: `fetchAllPages` throws when a fetch falls short of the reported
  // `searchResultsTotal`, so a truncated read can never be mistaken for a shrunken corpus.
  const eagleProjects = await src.fetchEagleProjects();
  const eagleProjectIds = new Set(eagleProjects.map(p => String(p._id)));
  // The registry seed-nosql builds. A Track row's dangling epic_guid resolves here exactly as it
  // does there, which is why this and not `eagleProjectIds` is the parent test: DEMI holds a
  // project row for such a guid, so a child under one is drift rather than unresolvable.
  const projectIndex = buildProjectIndex(
    buildRegistry(await src.loadTrackProjects(), eagleProjects).projects);
  // `admit` is the parent gate for BOTH children Eagle hangs off a `project` reference: a document
  // and a comment period. Either may name a `ProjectNotification` there.
  const { admit } = await documentAdmission(src, projectIndex);
  const eagleDocumentIds = new Set();
  const eagleDocumentProject = new Map(); // doc id -> its Eagle project id
  await src.streamEagleDocuments(page => {
    for (const doc of page) {
      const id = String(doc._id);
      eagleDocumentIds.add(id);
      eagleDocumentProject.set(id, doc.project != null ? String(doc.project) : null);
    }
  });

  const projectRows = await projectsRepo.listWithEagleId(access);
  const documentRows = await documentsRepo.listSeededIds(access);

  summary.failures = (await truncatedReads(access, [
    ['projects', projectRows, projectsRepo.countWithEagleId],
    ['documents', documentRows, documentsRepo.countSeededIds]
  ])).map(short => `${short} — the diff below is computed off a truncated read`);

  const projectDiff = diff(projectRows, row => String(row.eagleId), eagleProjectIds,
    row => row.sourceSystem === 'eagle');
  const documentDiff = diff(documentRows, row => String(row.id), eagleDocumentIds, undefined,
    id => admit(eagleDocumentProject.get(id)) !== null);

  summary.projects = { inDemi: projectRows.length, inEagle: eagleProjectIds.size, ...projectDiff };
  summary.documents = { inDemi: documentRows.length, inEagle: eagleDocumentIds.size, ...documentDiff };

  // The public-read containers, enumerated through the SAME repository reads a request uses. Their
  // rows carry `id === eagleId`, and every one of them is the backfill's or the push's, so there is
  // no `pushOwned` split to make.
  //
  // Comment periods DO need a parent gate. eagle-api's `dataset=CommentPeriod` gates on the
  // period's own `read[]` and joins no parent (`api/aggregators/searchAggregator.js`), so a period
  // Eagle publishes under a project it does not publish is still in the id set — while the mirror
  // drops it, because its parent project row is not in DEMI. Measured on test 2026-09-07: 29 such
  // periods under 20 unpublished projects, every one of them reported as push drift.
  const notificationRows = await notificationsRepo.list(access, {});
  const periodRows = [];
  // MAX_PAGE_SIZE caps ONE partition's read, so the ceiling is per parent. Comparing the running
  // total against it would fire on every real run once DEMI holds that many periods in all.
  let periodPageFilled = false;
  // Every partition a period can live in: `commentPeriods` partitions on the parent, and the
  // mirror admits a project or a `ProjectNotification` — nothing else.
  const periodParents = [...projectRows, ...notificationRows];
  for (const parent of periodParents) {
    const rows = await periodsRepo.listByProject(parent.id, access, {});
    periodPageFilled = periodPageFilled || rows.length >= MAX_PAGE_SIZE;
    periodRows.push(...rows);
  }
  const listRows = [
    ...await listsRepo.listByKind(listsRepo.KINDS.LIST, access, {}),
    ...await listsRepo.listByKind(listsRepo.KINDS.ORGANIZATION, access, {})
  ];
  const updateRows = await updatesRepo.list(access, {});

  // One `lists` container holds both kinds, so both id sets are one comparison.
  const eagleListIds = await eagleIds(src, 'Organization', await eagleIds(src, 'List'));
  // The period's own parent ref rides along: it is the only thing that says whether the mirror
  // could have resolved a parent for it.
  const eaglePeriodProject = new Map(); // period id -> its Eagle parent ref
  const eaglePeriodIds = await eagleIds(src, 'CommentPeriod', new Set(), row => {
    eaglePeriodProject.set(String(row._id), row.project != null ? String(row.project) : null);
  });
  const eagleNotificationIds = await eagleIds(src, 'ProjectNotification');
  const eagleUpdateIds = await eagleIds(src, 'RecentActivity');

  summary.commentPeriods = {
    inDemi: periodRows.length, inEagle: eaglePeriodIds.size,
    ...diff(periodRows, row => String(row.id), eaglePeriodIds, undefined,
      id => admit(eaglePeriodProject.get(id)) !== null)
  };
  summary.lists = {
    inDemi: listRows.length, inEagle: eagleListIds.size,
    ...diff(listRows, row => String(row.id), eagleListIds)
  };
  summary.notifications = {
    inDemi: notificationRows.length, inEagle: eagleNotificationIds.size,
    ...diff(notificationRows, row => String(row.id), eagleNotificationIds)
  };
  summary.updates = {
    inDemi: updateRows.length, inEagle: eagleUpdateIds.size,
    ...diff(updateRows, row => String(row.id), eagleUpdateIds)
  };

  summary.failures.push(...(await truncatedReads(access, [
    ['lists', listRows, async (a) =>
      (await listsRepo.countByKind(listsRepo.KINDS.LIST, a)) +
      (await listsRepo.countByKind(listsRepo.KINDS.ORGANIZATION, a))],
    ['notifications', notificationRows, notificationsRepo.count],
    ['updates', updateRows, updatesRepo.count]
  ])).map(short => `${short} — the diff below is computed off a truncated read`));

  // The per-partition enumerations have no cheap COUNT to pair with — one per project, one per
  // period — so the ceiling itself is the check: a partition that filled a page may hold more.
  if (periodPageFilled) {
    summary.failures.push('a project filled a comment-period page — the commentPeriods diff below ' +
      'is computed off a truncated read');
  }

  // Comments are OPT-IN: the sweep costs one eagle-api round trip per comment period and one
  // single-partition Cosmos query per period, which is too much to put on the nightly timer.
  if (args.comments) {
    const commentRows = [];
    const eagleCommentIds = new Set();
    // Comments under a period the mirror could not resolve. Walking DEMI's periods alone never
    // fetched them, so they were neither drift nor reported — a silent hole the size of the
    // unresolved-period set. They cost one round trip each, on a flag that is already opt-in.
    const unresolvedComments = new Set();
    let ceiling = false;
    for (const periodId of summary.commentPeriods.unresolvedParent) {
      await eachCommentPage(periodId, { sources: src }, (items) => {
        for (const row of items) {
          eagleCommentIds.add(String(row._id));
          unresolvedComments.add(String(row._id));
        }
      });
    }
    for (const period of periodRows) {
      const rows = await commentsRepo.listByPeriod(period.id, access, {});
      ceiling = ceiling || rows.length >= MAX_PAGE_SIZE;
      commentRows.push(...rows);
      await eachCommentPage(period.id, { sources: src },
        (items) => { for (const row of items) eagleCommentIds.add(String(row._id)); });
    }
    if (ceiling) {
      summary.failures.push('a period filled a comment page — the comments diff below is computed ' +
        'off a truncated read');
    }
    summary.comments = {
      inDemi: commentRows.length, inEagle: eagleCommentIds.size,
      ...diff(commentRows, row => String(row.id), eagleCommentIds, undefined,
        id => !unresolvedComments.has(id))
    };
  }

  summary.drift = driftOf(summary);

  return summary;
}

function report(summary, { json } = {}) {
  const lines = [`[reconcile] eagle=${summary.eagle}`];
  for (const label of LABELS) {
    const s = summary[label];
    // `comments` is only there when the run swept it — see `--comments`.
    if (!s) continue;
    // Capped: a real drift can carry thousands of ids and --json is where the full set lives.
    const preview = ids => ids.slice(0, 20).join(', ') + (ids.length > 20 ? ', …' : '');
    const line = (text, ids) =>
      lines.push(`  ${text}: ${ids.length}${ids.length ? ` — ${preview(ids)}` : ''}`);

    lines.push(`${label}: ${s.inDemi} mirrored in DEMI, ${s.inEagle} published in Eagle`);
    // NOT a delete list. eagle-api's `/api/public/{document,project}/{id}` answers `200 []` for a
    // deleted row AND for one that merely lost `public` from its `read[]` — both are what
    // `runDataQuery(..., ['public'], ...)` returns when nothing matches — so an anonymous caller
    // cannot tell an unpublished row from a hard-deleted one. Purging on this set would destroy
    // an unpublished row, its chunks and its index entries.
    // ponytail: report-only until eagle-api offers a tombstone or DEMI holds a credential that
    // can read unpublished rows; then this set can be probed one id at a time and purged.
    line('unpublishedOrDeleted (gone from Eagle\'s public search, NOT purged)',
      s.unpublishedOrDeleted.map(r => r.id));
    line('eagleOnly (the push missed these)', s.eagleOnly);
    if (s.unresolvedParent.length) {
      line('unresolvedParent (Eagle-only, but its own project is unpublished/gone — seed-nosql ' +
        'drops these too, not counted as drift)', s.unresolvedParent);
    }
    if (s.trackOnly.length) {
      lines.push(`  ${s.trackOnly.length} Track-sourced project(s) are also gone from Eagle's ` +
        'public search — that is close-unpublished-track-projects.js, not the push');
    }
  }
  for (const f of summary.failures) lines.push(`  ✗ ${f}`);
  if (json) {
    const ids = s => ({
      unpublishedOrDeleted: s.unpublishedOrDeleted.map(r => r.id), eagleOnly: s.eagleOnly,
      unresolvedParent: s.unresolvedParent
    });
    const full = {};
    for (const label of LABELS) if (summary[label]) full[label] = ids(summary[label]);
    lines.push(JSON.stringify(full, null, 2));
  }
  return lines.join('\n');
}

/**
 * One run, logging exactly what the CLI logs — the nightly schedule and the CLI must not be able
 * to produce different output, because the log alert matches only one of the two lines.
 *
 * No `live` option: this script changes nothing in any mode. See the header.
 *
 * @param {object} [opts] {json} full id sets, {comments} sweep the comment container too (one
 *   eagle-api round trip per comment period), {deps} the same test seam `reconcile` takes
 */
async function run({ json = false, comments: sweepComments = false, deps } = {}) {
  const summary = await reconcile(sweepComments ? ['--comments'] : [], deps);
  logger.info(report(summary, { json }));
  // Its own record, so a log alert matches this line and not the report body around it.
  logger.info(summaryLine(summary));
  return summary;
}

module.exports = { parseArgs, diff, summaryLine, reconcile, report, run };

if (require.main === module) {
  const { initCosmosClient } = require('../db/cosmos-nosql');

  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    logger.error(err.message);
    process.exit(1);
  }
  initCosmosClient();

  run({ json: args.json, comments: args.comments })
    .catch(err => {
      logger.error(`[reconcile] ${err.stack || err.message}`);
      process.exit(1);
    });
}
