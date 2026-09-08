'use strict';

/**
 * Backfill the public-read containers from eagle-api.
 *
 * The `PUT /eagle/*` mirrors only ever see a row eagle-api WRITES. Everything written before the
 * mirrors existed — every list item, organization, notification, comment period and comment in the
 * corpus — has to be walked in once. This is that walk, and it is also the repair tool: a `List`
 * migration in eagle-api touches Mongo directly and fires no push, so `--only lists` after one is
 * the only way DEMI hears about it.
 *
 * NOTHING IS MAPPED HERE except the `kind: 'List'` row. Every other dataset goes through its own
 * mirror's `mirrorFromEagle`, the same function the push handler calls, so a backfilled row and a
 * pushed row are byte-for-byte the same — including the ACL ceiling a comment period takes from
 * its project and a comment takes from its period. `List` has no mirror because eagle-api has no
 * List write controller to push from (see src/http/routes.js), so this script is its only writer.
 *
 * Order matters, and `--only` does not reorder it: a comment period needs its project mirrored
 * (seed-nosql.js), and a comment needs its period.
 *
 *   1. lists           Eagle `List`                 -> lists (kind: List)
 *   2. organizations   Eagle `Organization`         -> lists (kind: Organization)
 *   3. notifications   Eagle `ProjectNotification`  -> notifications
 *   4. updates         Eagle `RecentActivity`       -> updates
 *   5. commentPeriods  Eagle `CommentPeriod`        -> commentPeriods
 *   6. comments        /api/public/comment          -> comments
 *
 * **DRY RUN BY DEFAULT**, as seed-nosql.js is. `--live` is required to write anything.
 *
 * Usage:
 *   node src/scripts/seed-public-reads.js [--live | --dry-run]
 *                                         [--only lists,comments] [--since 2026-01-01]
 *                                         [--state ./seed-public-reads.state.json]
 *
 * The environment is chosen the way every other database script chooses it — by the settings the
 * process starts with, never by a flag: `EAGLE_API_BASE` for the source and `COSMOS_ENDPOINT` /
 * `COSMOS_NOSQL_DATABASE` for the target, which `demi-run` supplies on the devbox. See
 * docs/public-read-backfill.md.
 *
 * Resumable. Each finished dataset is written to the state file, and a rerun skips it; the comment
 * stage checkpoints per comment period, so a killed run resumes at the period it died in rather
 * than at the first one. Writes are upserts, so a replay is harmless either way.
 *
 * `--only <stage>` RE-RUNS the stages it names, checkpoint or no checkpoint — it is how a repair is
 * asked for. Delete the state file to force a full rerun of everything.
 */

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
const { seedAcl } = require('../seed/transform');
const { systemAccess } = require('../helpers/access-sql');
const { logger } = require('../utils/logger');

/** Every stage `--only` accepts, IN RUN ORDER — see the header. */
const ALL_STAGES = ['lists', 'organizations', 'notifications', 'updates', 'commentPeriods',
  'comments'];

const DEFAULT_STATE = './seed-public-reads.state.json';

/**
 * `/api/public/comment` returns `_id`, `read` and little else unless the fields are named, so the
 * mirror would store a row of nulls. Every field `controllers/nosql/comment.js` reads is listed.
 * `author` is asked for and usually withheld: eagle-api deletes it from an anonymous comment
 * before it answers, which is why a backfilled anonymous comment carries no author.
 */
const COMMENT_FIELDS = ['author', 'comment', 'commentId', 'dateAdded', 'documents', 'eaoStatus',
  'isAnonymous', 'period'];

/** A systematic failure would otherwise write one log record per row for the whole corpus. */
const MAX_LOGGED_ERRORS = 20;

function parseArgs(argv) {
  const args = {
    live: false, only: ALL_STAGES, onlyExplicit: false, since: null, state: DEFAULT_STATE
  };
  let explicitDryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--state') args.state = String(argv[++i] || '');
    else if (a === '--since') args.since = String(argv[++i] || '');
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

/**
 * The `kind: 'List'` row. The only mapping this script owns — see the header.
 *
 * A List item is a lookup label with no parent, so its own `read[]` is the whole ACL, exactly as
 * the Organization mirror treats an organization.
 */
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
  const read = seedAcl(doc.read);
  return upsertWithRetry(
    repo,
    (current) => mirrorListItem(eagleId, doc, read, current),
    () => repo.getById(systemAccess(), eagleId, repo.KINDS.LIST)
  );
}

/**
 * Mirror one `RecentActivity` and CONSUME its notification claim.
 *
 * `controllers/nosql/update.js` announces a publication to eagle-notify once per update, guarded by
 * `notifiedAt`. A backfill carries years of already-published updates, and none of them is news, so
 * the claim is taken here rather than left for the next push to spend on a five-year-old headline.
 */
async function mirrorUpdate(eagleId, doc, deps) {
  const result = await deps.updateMirror.mirrorFromEagle(eagleId, doc);
  const { saved, existing } = result;
  if (saved.isPublished && !(existing && existing.notifiedAt)) {
    await deps.updatesRepo.claimForNotify(saved.id, new Date().toISOString());
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

/**
 * Is this row inside `--since`?
 *
 * Client-side: eagle-api's `/search` takes no date filter, so `--since` narrows what is WRITTEN and
 * never what is fetched. A row carrying neither timestamp is admitted — a row rewritten without a
 * date is worth one wasted upsert, a row skipped for want of one is drift.
 */
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

/** Counters every stage reports, and the line the run is read off. */
const newCounts = () => ({ fetched: 0, written: 0, skipped: 0, errors: 0 });

function stageLine(stage, counts, live) {
  return `[backfill] ${stage}: fetched=${counts.fetched} ` +
    `${live ? 'written' : 'would-write'}=${counts.written} ` +
    `skipped=${counts.skipped} errors=${counts.errors}`;
}

/** One row. Returns what it did, so the caller only counts. */
async function writeRow(doc, write, args, deps, counts) {
  counts.fetched++;
  if (!withinSince(doc, args.since)) { counts.skipped++; return; }
  if (!args.live) { counts.written++; return; }

  try {
    // A mirror answers null when the row's parent is not in DEMI — an unpublished project's
    // comment period, say. That is a skip, not an error: the parent is seed-nosql's to supply.
    const result = await write(doc, deps);
    if (result) counts.written++; else counts.skipped++;
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

/**
 * One page of a period's public comments.
 *
 * `/search` has no Comment dataset, so this is the per-period endpoint instead. `count=true` makes
 * the body a bare array of comments and puts the total in `x-total-count` — it is the only place
 * the total is reported, so the truncation check below has nowhere else to read it.
 */
async function fetchCommentPage(base, periodId, pageNum, deps) {
  const url = `${base}/comment?period=${encodeURIComponent(periodId)}&count=true` +
    `&pageNum=${pageNum}&pageSize=${deps.sources.PAGE_SIZE}` +
    `&fields=${encodeURIComponent(COMMENT_FIELDS.join('|'))}`;
  const { body, headers } = await deps.sources.fetchJsonWithHeaders(url);
  const total = Number(headers.get('x-total-count'));
  return {
    items: (Array.isArray(body) ? body : []).filter(row => row && row._id),
    total: Number.isFinite(total) ? total : null
  };
}

/**
 * Every published comment of one period, page by page. Shared with reconcile-eagle.js, which reads
 * the same pages for their ids.
 *
 * Throws on a short read rather than returning what arrived, for the reason `fetchAllPages` does:
 * a truncated period looks exactly like a period whose comments were withdrawn. The backfill counts
 * the throw as an error and leaves the period out of the checkpoint, so the next run retries it.
 */
async function eachCommentPage(periodId, deps, onPage) {
  const base = deps.sources.EAGLE_API_BASE;
  const pageSize = deps.sources.PAGE_SIZE;
  let fetched = 0;
  let total = null;

  for (let pageNum = 0; ; pageNum++) {
    const page = await fetchCommentPage(base, periodId, pageNum, deps);
    if (total === null) total = page.total;
    fetched += page.items.length;

    await onPage(page.items);

    if (page.items.length < pageSize) break;
    if (total !== null && fetched >= total) break;
  }

  if (total !== null && fetched !== total) {
    throw new Error(`period ${periodId}: fetched ${fetched} comments but eagle-api reports ` +
      `${total} — refusing to treat a truncated read as the whole period`);
  }
  return { count: fetched, total };
}

/**
 * The comment stage: every comment period Eagle publishes, then that period's comments.
 *
 * The period rows come from DEMI rather than from the fetch, because the comment mirror needs the
 * stored period for its ACL ceiling and its `projectId`. A period Eagle publishes that DEMI has
 * not mirrored is skipped whole — run the `commentPeriods` stage first.
 */
async function backfillComments(args, deps, state) {
  const counts = newCounts();
  const periods = await deps.sources.fetchAllPages(deps.sources.EAGLE_API_BASE, 'CommentPeriod');
  const done = new Set((state.comments && state.comments.periods) || []);

  for (const row of periods) {
    const periodId = String(row._id);
    if (done.has(periodId)) continue;

    const period = await deps.commentPeriodsRepo.getById(systemAccess(), periodId);
    if (!period) {
      counts.skipped++;
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
      // Only a period whose every comment landed is checkpointed. `writeRow` swallows a row failure
      // into `counts.errors` rather than throwing, so without this the period would be recorded
      // done, the next run would skip it, and the failed comments would be missing for good.
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
  const summary = { eagle: deps.sources.EAGLE_API_BASE, live: args.live, stages: {}, skipped: [] };

  for (const stage of args.only) {
    // A finished dataset is skipped whole, so an interrupted run resumes where it stopped. NOT
    // when the operator named the stage: `--only` is the repair tool, and a stage that has
    // already completed once is exactly the one a repair is asked for.
    if (!args.onlyExplicit && state[stage] && state[stage].completedAt && stage !== 'comments') {
      summary.skipped.push(stage);
      logger.info(`[backfill] ${stage}: already done at ${state[stage].completedAt}, skipping`);
      continue;
    }

    const counts = stage === 'comments'
      ? await backfillComments(args, deps, state)
      : await backfillDataset(stage, args, deps);

    summary.stages[stage] = counts;
    logger.info(stageLine(stage, counts, args.live));

    // Only a clean stage is checkpointed: a run that logged errors has rows it did not write, and
    // skipping it next time would leave them missing for good.
    if (args.live && counts.errors === 0) {
      // Spread the stage's own entry back in: the comment stage keeps its per-period checkpoint
      // there, and overwriting it would make the next run walk every period again.
      state[stage] = { ...state[stage], completedAt: new Date().toISOString(), ...counts };
      saveState(args.state, state);
    }
  }

  return summary;
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
