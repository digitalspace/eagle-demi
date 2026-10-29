'use strict';

// Backfill for rows written before the PUT /eagle/* mirrors existed, and the repair path for List
// migrations, which fire no push. Order, resume and --only rules: docs/public-read-backfill.md.

const fs = require('fs');

const sources = require('../seed/sources');
const listsRepo = require('../repositories/lists');
const commentPeriodsRepo = require('../repositories/comment-periods');
const updatesRepo = require('../repositories/updates');
const organizationMirror = require('../controllers/nosql/organization');
const notificationMirror = require('../controllers/nosql/notification');
const updateMirror = require('../controllers/nosql/update');
const commentPeriodMirror = require('../controllers/nosql/comment-period');
const commentMirror = require('../controllers/nosql/comment');
const { upsertWithRetry } = require('../controllers/nosql/eagle-mirror');
const { eagleBaseAcl } = require('../seed/transform');
const { systemAccess } = require('../helpers/access-sql');
const { logger } = require('../utils/logger');

// Run order: a comment period needs its project mirrored, and a comment needs its period.
const ALL_STAGES = ['lists', 'organizations', 'notifications', 'updates', 'commentPeriods',
  'comments'];

const DEFAULT_STATE = './seed-public-reads.state.json';

// eagle-api returns little more than _id unless fields are named. It strips `author` from
// anonymous comments, so a backfilled anonymous comment has none.
const COMMENT_FIELDS = ['author', 'comment', 'commentId', 'dateAdded', 'documents', 'eaoStatus',
  'isAnonymous', 'period'];

/** A systematic failure would otherwise write one log record per row for the whole corpus. */
const MAX_LOGGED_ERRORS = 20;

function parseArgs(argv) {
  const args = {
    live: false, only: ALL_STAGES, onlyExplicit: false, since: null, state: DEFAULT_STATE,
    summary: null
  };
  let explicitDryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--state') args.state = String(argv[++i] || '');
    else if (a === '--since') args.since = String(argv[++i] || '');
    else if (a === '--summary') {
      args.summary = String(argv[++i] || '');
      // `--summary --live` would otherwise write the summary to a file named `--live` and run dry.
      if (!args.summary || args.summary.startsWith('--')) {
        throw new Error('[backfill] --summary needs a path');
      }
    }
    else if (a === '--only') {
      args.onlyExplicit = true;
      args.only = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
      // A missing or empty value would otherwise select nothing and exit 0 having done nothing —
      // the same silent no-op the unknown-stage guard below exists to prevent.
      if (!args.only.length) {
        throw new Error('[backfill] --only needs at least one stage. ' +
          `Valid: ${ALL_STAGES.join(', ')}`);
      }
    } else throw new Error(`[backfill] unknown argument: ${a}`);
  }

  if (args.live && explicitDryRun) {
    throw new Error('[backfill] --live and --dry-run contradict each other');
  }

  const unknown = args.only.filter(s => !ALL_STAGES.includes(s));
  if (unknown.length) {
    throw new Error(`[backfill] unknown stage(s): ${unknown.join(', ')}. ` +
      `Valid: ${ALL_STAGES.join(', ')}`);
  }
  // Run order is the dependency order, so `--only` selects stages and never reorders them.
  args.only = ALL_STAGES.filter(stage => args.only.includes(stage));

  if (args.since !== null) {
    const at = new Date(args.since);
    if (isNaN(at.getTime())) throw new Error(`[backfill] --since is not a date: ${args.since}`);
    args.since = at.toISOString();
  }
  if (!args.state) throw new Error('[backfill] --state needs a path');

  return args;
}

// The only mapping this script owns: eagle-api has no List write controller, so no mirror exists.
// A List item has no parent, so its own read[] is the whole ACL.
function mirrorListItem(eagleId, doc, read, existing) {
  return {
    id: eagleId,
    eagleId,
    kind: listsRepo.KINDS.LIST,
    sourceSystem: 'eagle',

    name: doc.name || '',
    type: doc.type || '',
    item: doc.item || '',
    legislation: doc.legislation ?? null,
    listOrder: doc.listOrder ?? null,

    isPublished: read.includes('public'),
    read,
    sources: { ...(existing && existing.sources), eagle: doc }
  };
}

/** The `List` half of the `lists` container, written the way every mirror writes. */
function mirrorList(eagleId, doc, repo = listsRepo) {
  const read = eagleBaseAcl(doc.read);
  return upsertWithRetry(
    repo,
    (current) => mirrorListItem(eagleId, doc, read, current),
    () => repo.readForWrite(eagleId, repo.KINDS.LIST)
  );
}

// Consumes the eagle-notify claim: old updates are not news. Live rows only, since a scheduled one
// still is; the 'backfill' mark also stops a later withdrawal sending a cancellation.
async function mirrorUpdate(eagleId, doc, deps) {
  const result = await deps.updateMirror.mirrorFromEagle(eagleId, doc);
  // No row was written — a newer push won, or this one never found the row standing still — so
  // there is no `saved` to read a claim off and nothing published to claim for.
  if (result.ignored || result.status === 'conflict') return result;
  const { saved, existing } = result;
  const now = new Date().toISOString();
  if (saved.isPublished && deps.updatesRepo.isLive(saved, null, now) && !(existing && existing.notifiedAt)) {
    await deps.updatesRepo.claimForBackfill(saved.id, now);
  }
  return result;
}

/** The stages that are one `/search` dataset walked start to finish. */
const DATASETS = {
  lists: {
    dataset: 'List',
    write: (doc, deps) => mirrorList(String(doc._id), doc, deps.listsRepo)
  },
  organizations: {
    dataset: 'Organization',
    write: (doc, deps) => deps.organizationMirror.mirrorFromEagle(String(doc._id), doc)
  },
  notifications: {
    dataset: 'ProjectNotification',
    write: (doc, deps) => deps.notificationMirror.mirrorFromEagle(String(doc._id), doc)
  },
  updates: {
    dataset: 'RecentActivity',
    write: (doc, deps) => mirrorUpdate(String(doc._id), doc, deps)
  },
  commentPeriods: {
    dataset: 'CommentPeriod',
    write: (doc, deps) => deps.commentPeriodMirror.mirrorFromEagle(String(doc._id), doc)
  }
};

// Client-side: eagle-api's /search takes no date filter. A row with no timestamp is admitted,
// since a wasted upsert is cheaper than drift.
function withinSince(doc, since) {
  if (!since) return true;
  const stamp = doc.dateUpdated || doc.dateAdded;
  if (!stamp) return true;
  const at = new Date(stamp);
  return isNaN(at.getTime()) ? true : at.toISOString() >= since;
}

function loadState(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return {}; }
}

function saveState(path, state) {
  fs.writeFileSync(path, JSON.stringify(state, null, 2));
}

// `dropped` (parent not in DEMI) is split out of `skipped`: an out-of-range row was never wanted,
// a dropped row is still owed.
const newCounts = () => ({ fetched: 0, written: 0, skipped: 0, dropped: 0, errors: 0 });

/** The checkpoint rule, and what `--summary` reports as unfinished. */
const stageFinished = (counts) => counts.errors === 0 && counts.dropped === 0;

function stageLine(stage, counts, live) {
  return `[backfill] ${stage} (this run): fetched=${counts.fetched} ` +
    `${live ? 'written' : 'would-write'}=${counts.written} ` +
    `skipped=${counts.skipped} dropped=${counts.dropped} errors=${counts.errors}`;
}

/** One row. Returns what it did, so the caller only counts. */
async function writeRow(doc, write, args, deps, counts) {
  counts.fetched++;
  if (!withinSince(doc, args.since)) { counts.skipped++; return; }
  if (!args.live) { counts.written++; return; }

  try {
    // null (parent not in DEMI), `ignored` and `conflict` all mean nothing was written; counting
    // them as drops keeps the stage off the checkpoint.
    const result = await write(doc, deps);
    const wrote = Boolean(result) && !result.ignored && result.status !== 'conflict';
    if (wrote) counts.written++; else { counts.skipped++; counts.dropped++; }
  } catch (err) {
    counts.errors++;
    if (counts.errors <= MAX_LOGGED_ERRORS) {
      logger.error(`[backfill] ${doc && doc._id}`, { error: err.message });
    }
  }
}

/** One `/search` dataset, page by page — nothing is accumulated. */
async function backfillDataset(stage, args, deps) {
  const { dataset, write } = DATASETS[stage];
  const counts = newCounts();
  await deps.sources.fetchAllPages(deps.sources.EAGLE_API_BASE, dataset, {
    accumulate: false,
    onPage: async (items) => {
      for (const doc of items) await writeRow(doc, write, args, deps, counts);
    }
  });
  return counts;
}

// `count=true` makes the body a bare array with the total in x-total-count. Both are checked: a
// missing header or envelope body would silently record zero comments and checkpoint the period.
async function fetchCommentPage(base, periodId, pageNum, deps, pageSize = deps.sources.PAGE_SIZE) {
  const url = `${base}/comment?period=${encodeURIComponent(periodId)}&count=true` +
    `&pageNum=${pageNum}&pageSize=${pageSize}` +
    `&fields=${encodeURIComponent(COMMENT_FIELDS.join('|'))}`;
  const { body, headers } = await deps.sources.fetchJsonWithHeaders(url);

  const rows = Array.isArray(body) ? body : [];
  if (rows.length && rows[0] && rows[0].total_items !== undefined && !rows[0]._id) {
    throw new Error(`period ${periodId} page ${pageNum}: eagle-api answered the total_items ` +
      'envelope, not a comment array — the count=true contract is broken');
  }

  const raw = headers.get('x-total-count');
  const total = Number(raw);
  if (raw === null || raw === '' || !Number.isFinite(total)) {
    throw new Error(`period ${periodId} page ${pageNum}: eagle-api sent no usable ` +
      `x-total-count (${JSON.stringify(raw)}) — refusing to read a missing total as zero`);
  }

  return { items: rows.filter(row => row && row._id), total };
}

// Throws on a short read: a truncated period looks exactly like one whose comments were withdrawn.
// Shared with reconcile-eagle.js.
async function eachCommentPage(periodId, deps, onPage) {
  const base = deps.sources.EAGLE_API_BASE;
  const pageSize = deps.sources.PAGE_SIZE;
  const seen = new Set();
  let fetched = 0;
  let total = null;
  let lastPage;

  for (let pageNum = 0; ; pageNum++) {
    lastPage = pageNum;
    const page = await fetchCommentPage(base, periodId, pageNum, deps);
    if (total === null) total = page.total;
    const fresh = deps.sources.freshById(page.items, seen);
    fetched += fresh.length;

    await onPage(fresh);

    if (page.items.length < pageSize) break;
    if (fetched >= total) break;
  }

  if (fetched < total) {
    throw new Error(`period ${periodId}: fetched ${fetched} comments but eagle-api reports ` +
      `${total} — refusing to treat a truncated read as the whole period`);
  }
  // A one-page read had no page boundary for the period to change across.
  const reread = lastPage === 0 ? total : (await fetchCommentPage(base, periodId, 0, deps, 1)).total;
  return { count: fetched, total: deps.sources.settledTotal(fetched, total, reread, `period ${periodId} comments`) };
}

// Periods are read from DEMI, not the fetch: the comment mirror needs the stored period's ACL
// ceiling and projectId. An unmirrored period is skipped whole.
async function backfillComments(args, deps, state) {
  const counts = newCounts();
  const periods = await deps.sources.fetchAllPages(deps.sources.EAGLE_API_BASE, 'CommentPeriod');
  // `--only comments` is the repair, so it ignores the per-period checkpoint; honouring it would
  // make the repair a no-op that exits 0.
  const done = new Set(args.onlyExplicit ? [] : ((state.comments && state.comments.periods) || []));

  for (const row of periods) {
    const periodId = String(row._id);
    if (done.has(periodId)) continue;

    const period = await deps.commentPeriodsRepo.getById(systemAccess(), periodId);
    if (!period) {
      counts.skipped++;
      counts.dropped++;
      continue;
    }

    const errorsBefore = counts.errors;
    try {
      await eachCommentPage(periodId, deps, async (items) => {
        for (const doc of items) {
          await writeRow(doc, (row, d) =>
            d.commentMirror.mirrorFromEagle(String(row._id), row, period), args, deps, counts);
        }
      });
      // writeRow swallows row failures into counts.errors, so only a period with no new errors is
      // checkpointed; otherwise its failed comments are lost for good.
      if (counts.errors === errorsBefore) {
        done.add(periodId);
        if (args.live) {
          state.comments = { ...state.comments, periods: [...done] };
          saveState(args.state, state);
        }
      }
    } catch (err) {
      counts.errors++;
      if (counts.errors <= MAX_LOGGED_ERRORS) {
        logger.error('[backfill] comment period', { periodId, error: err.message });
      }
    }
  }
  return counts;
}

/**
 * The whole run.
 *
 * @param {string[]} argv
 * @param {object} [overrides] test seam: any of the modules named in `defaults` below
 */
async function backfill(argv = [], overrides = {}) {
  const args = parseArgs(argv);
  const deps = {
    sources,
    listsRepo,
    commentPeriodsRepo,
    updatesRepo,
    organizationMirror,
    notificationMirror,
    updateMirror,
    commentPeriodMirror,
    commentMirror,
    ...overrides
  };

  const state = loadState(args.state);
  const summary = {
    eagle: deps.sources.EAGLE_API_BASE, live: args.live, stages: {}, skipped: [], unfinished: []
  };
  try {
    await runStages(args, deps, state, summary);
  } finally {
    if (args.summary) fs.writeFileSync(args.summary, `${JSON.stringify(summary, null, 2)}\n`);
  }
  return summary;
}

async function runStages(args, deps, state, summary) {
  for (const stage of args.only) {
    // Skip a finished stage on resume, but not one named by --only: that is the repair request.
    if (!args.onlyExplicit && state[stage] && state[stage].completedAt && stage !== 'comments') {
      summary.skipped.push(stage);
      logger.info(`[backfill] ${stage}: already done at ${state[stage].completedAt}, skipping`);
      continue;
    }

    let counts;
    try {
      counts = stage === 'comments'
        ? await backfillComments(args, deps, state)
        : await backfillDataset(stage, args, deps);
    } catch (err) {
      summary.unfinished.push(stage);
      throw err;
    }

    summary.stages[stage] = counts;
    if (!stageFinished(counts)) summary.unfinished.push(stage);
    logger.info(stageLine(stage, counts, args.live));

    // Checkpoint only clean stages: errors or drops mean rows are still owed.
    if (args.live && stageFinished(counts)) {
      // Spread the stage's own entry back in: the comment stage keeps its per-period checkpoint
      // there, and overwriting it would make the next run walk every period again.
      state[stage] = { ...state[stage], completedAt: new Date().toISOString(), ...counts };
      saveState(args.state, state);
    }
  }
}

module.exports = {
  ALL_STAGES,
  COMMENT_FIELDS,
  DEFAULT_STATE,
  parseArgs,
  mirrorListItem,
  mirrorList,
  withinSince,
  stageLine,
  eachCommentPage,
  backfill
};

if (require.main === module) {
  const { initCosmosClient } = require('../db/cosmos-nosql');

  initCosmosClient();
  backfill(process.argv.slice(2))
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error(err.message);
      process.exit(1);
    });
}
