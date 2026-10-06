'use strict';

/**
 * Give `staff` to the Eagle-mirrored rows already in Cosmos whose `read[]` carries no ladder token,
 * by the rule the mirrors now apply on every push (`helpers/eagle-acl.js:withEagleStaff`).
 *
 * In DEMI, no ladder token means privileged callers only. In Eagle, `staff` skips every read
 * check, so those rows (for example `['sysadmin']` or `['sysadmin','inspector']`) are visible to
 * every staff user there. This rewrites them in DEMI itself: no re-push from Eagle, no chunk scan.
 *
 *   node src/scripts/backfill-eagle-ladder.js [--live]
 *
 * **DRY RUN BY DEFAULT**: prints per-container counts and writes nothing. `--live` writes. Cosmos is
 * private-endpoint-only and keyless, so a live run executes on the devbox via `demi-run` (README
 * "Running anything against the database").
 *
 * What it never widens:
 * - sealed rows (`compliance`) and any row with a ladder token. A DEMI takedown or narrow writes
 *   `readForLevel(level)`, which always carries one, so those rows are never candidates;
 * - a row whose parent caps it below level 2. The cap is the push's own, `helpers/eagle-acl:
 *   eagleReadUnder` (through `update-parent:readUnder` for Updates), against the parent's stored
 *   read, a DEMI narrow or takedown included: the rule a push applies, so the two agree. Only a
 *   level-2 result is written, so nothing lands at `team` or `public`;
 * - a row whose parent is not in DEMI.
 *
 * A document with no `ownRead` also gains one, in the same patch: its `read` before this run, which
 * on a row written before the rule is Eagle's own read. `setAclForProject` re-derives an Eagle row
 * from `ownRead` only, and a stored `read` holding `staff` may carry the token the rule added, so
 * such a row is counted (`staffNoOwnRead`) and not written.
 *
 * Parents are planned first and children are capped by the parent's planned read, so a dry run
 * counts what a live run writes. Each patch is conditioned on the row still having no ladder token,
 * and on a document still having no `ownRead`, so a push or a level change that lands meanwhile wins.
 */

const cosmos = require('../db/cosmos-nosql');
const { readUnder } = require('../helpers/update-parent');
const { levelOfRead, LEVEL_TOKENS, SEALED_TOKEN } = require('../helpers/access-sql');
const { seedAcl, eagleReadUnder } = require('../seed/transform');
const { logger } = require('../utils/logger');

const PAGE_SIZE = 500;

/** Containers in parent-first order. `parent` names how a row finds the read that caps it. */
const STEPS = Object.freeze([
  { container: 'projects', pk: 'id' },
  { container: 'notifications', pk: 'id' },
  { container: 'lists', pk: 'kind' },
  { container: 'updates', pk: 'id', parent: 'eagle' },
  { container: 'commentPeriods', pk: 'projectId', parent: 'project' },
  { container: 'documents', pk: 'projectId', parent: 'project' },
  { container: 'comments', pk: 'periodId', parent: 'period' }
]);

/** Containers whose every row is loaded, because they cap other containers' rows. */
const PARENT_CONTAINERS = new Set(['projects', 'notifications', 'commentPeriods']);

const BLOCKING = [...Object.values(LEVEL_TOKENS), SEALED_TOKEN];
const NO_LADDER_SQL = field => `(IS_ARRAY(${field}) AND ARRAY_LENGTH(${field}) > 0 AND ` +
  `NOT EXISTS(SELECT VALUE r FROM r IN ${field} WHERE ARRAY_CONTAINS(@blocking, r)))`;
// Patch conditions take no parameters; the tokens are constants, never input.
const NO_LADDER_PREDICATE = field => `NOT EXISTS(SELECT VALUE r FROM r IN ${field} ` +
  `WHERE r IN (${BLOCKING.map(t => `'${t}'`).join(', ')}))`;
const NO_OWN_READ_SQL = 'NOT (IS_ARRAY(c.ownRead) AND ARRAY_LENGTH(c.ownRead) > 0)';

function parseArgs(argv) {
  const args = { live: false };
  for (const a of argv) {
    if (a === '--live') args.live = true;
    else if (a === '--dry-run') args.live = false;
    else throw new Error(`[eagle-ladder] unknown argument: ${a}`);
  }
  return args;
}

function rowsSpec(container, skip) {
  const candidates = container === 'documents'
    ? `(${NO_LADDER_SQL('c.read')} OR ${NO_OWN_READ_SQL})` : NO_LADDER_SQL('c.read');
  const candidatesOnly = PARENT_CONTAINERS.has(container) ? '' : ` AND ${candidates}`;
  return {
    query: 'SELECT c.id, c.read, c.ownRead, c.eagleId, c.projectId, c.periodId, c.kind, ' +
      'IS_DEFINED(c.sources.eagle) AS hasEagleSource FROM c ' +
      `WHERE (IS_DEFINED(c.eagleId) OR IS_DEFINED(c.sources.eagle))${candidatesOnly} ` +
      'ORDER BY c.id OFFSET @skip LIMIT @size',
    parameters: [
      { name: '@blocking', value: BLOCKING },
      { name: '@skip', value: skip },
      { name: '@size', value: PAGE_SIZE }
    ]
  };
}

async function allRows(queryPage, container) {
  const rows = [];
  for (let skip = 0; ; skip += PAGE_SIZE) {
    const page = await queryPage(container, rowsSpec(container, skip), { size: PAGE_SIZE, skip });
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

const hasNoLadder = read => Array.isArray(read) && read.length > 0 &&
  !read.some(r => BLOCKING.includes(r));
const isNonEmpty = read => Array.isArray(read) && read.length > 0;

/**
 * The parent read a row is capped by: `undefined` for no cap, `null` when the parent is missing.
 * A notification wins over a project, as `parent-admit:pickParent` says, and caps nothing except
 * an Update.
 */
function parentReadOf(step, row, parents) {
  if (!step.parent) return undefined;
  const ref = String(step.parent === 'period' ? row.periodId : row.projectId);
  if (step.parent === 'period') return parents.periods.has(ref) ? parents.periods.get(ref) : null;
  if (parents.notifications.has(ref)) {
    return step.parent === 'eagle' ? parents.notifications.get(ref) : undefined;
  }
  const project = step.parent === 'eagle' ? parents.projectsByEagleId.get(ref) : parents.projects.get(ref);
  return project === undefined ? null : project;
}

/**
 * The `read` one row is patched to, or null. Only a level-2 `read` is written. A document's
 * `ownRead` stays Eagle's read without `staff`: the project cascade adds it through `eagleReadUnder`.
 */
function planRow(step, row, parentRead) {
  if (!hasNoLadder(row.read) || parentRead === null) return null;
  const next = step.parent === 'eagle'
    ? readUnder(row.read, parentRead === undefined ? null : { read: parentRead })
    : (parentRead === undefined ? seedAcl(row.read) : eagleReadUnder(row.read, parentRead));
  if (levelOfRead(next) !== 2) return null;
  return { read: next };
}

/**
 * A document's missing `ownRead`: its stored `read`, or null when it has one, has no `read`, or is
 * not a document. `ambiguous` when that `read` holds `staff`, which the rule may have added.
 */
function ownReadPlan(step, row) {
  if (step.container !== 'documents' || isNonEmpty(row.ownRead) || !isNonEmpty(row.read)) return null;
  return row.read.includes(LEVEL_TOKENS[2]) ? { ambiguous: true } : { ownRead: row.read };
}

function patchOp(step, row, plan, ownRead, now) {
  const operations = [{ op: 'set', path: '/updatedAt', value: now }];
  const guards = [];
  if (plan) {
    operations.push(
      { op: 'set', path: '/read', value: plan.read },
      { op: 'set', path: '/isPublished', value: plan.read.includes('public') });
    guards.push(NO_LADDER_PREDICATE('c.read'));
  }
  if (ownRead) {
    operations.push({ op: 'set', path: '/ownRead', value: ownRead });
    guards.push(NO_OWN_READ_SQL);
  }
  return {
    operationType: 'Patch',
    partitionKey: row[step.pk],
    id: String(row.id),
    resourceBody: { operations, condition: `FROM c WHERE ${guards.join(' AND ')}` }
  };
}

function summaryLine(s) {
  return `[eagle-ladder] container=${s.container} mode=${s.mode} scanned=${s.scanned} ` +
    `planned=${s.planned} heldByParent=${s.heldByParent} ` +
    `noParent=${s.noParent} ownRead=${s.ownRead} staffNoOwnRead=${s.staffNoOwnRead} ` +
    `patched=${s.patched} skipped=${s.skipped} failed=${s.failed}`;
}

/**
 * @param {string[]} argv
 * @param {object} [deps] test seam: {queryPage, bulkVerified, now}
 * @returns {Promise<object[]>} one summary per container, in `STEPS` order
 */
async function backfillEagleLadder(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const queryPage = deps.queryPage || cosmos.queryPage;
  const write = deps.bulkVerified || cosmos.bulkVerified;
  const now = deps.now || new Date().toISOString();
  const parents = {
    projects: new Map(), projectsByEagleId: new Map(), notifications: new Map(), periods: new Map()
  };
  const summaries = [];

  for (const step of STEPS) {
    const s = {
      container: step.container, mode: args.live ? 'live' : 'dry-run',
      scanned: 0, planned: 0, heldByParent: 0, noParent: 0, ownRead: 0, staffNoOwnRead: 0,
      patched: 0, skipped: 0, failed: 0
    };
    const ops = [];
    for (const row of await allRows(queryPage, step.container)) {
      if (!row.eagleId && row.hasEagleSource !== true) continue;
      s.scanned++;
      const parentRead = parentReadOf(step, row, parents);
      const plan = planRow(step, row, parentRead);
      if (hasNoLadder(row.read) && !plan) {
        if (parentRead === null) s.noParent++;
        else s.heldByParent++;
      }
      // Children are capped by what the parent becomes, so the dry run counts the live result.
      const read = plan ? plan.read : row.read;
      if (step.container === 'projects') {
        parents.projects.set(String(row.id), read);
        if (row.eagleId) parents.projectsByEagleId.set(String(row.eagleId), read);
      } else if (step.container === 'notifications') {
        parents.notifications.set(String(row.id), read);
      } else if (step.container === 'commentPeriods') {
        parents.periods.set(String(row.id), read);
      }
      const own = ownReadPlan(step, row);
      if (own && own.ambiguous) s.staffNoOwnRead++;
      const ownRead = own && own.ownRead;
      if (ownRead) s.ownRead++;
      if (!plan && !ownRead) continue;
      s.planned++;
      ops.push(patchOp(step, row, plan, ownRead, now));
    }

    if (args.live) {
      for (let i = 0; i < ops.length; i += cosmos.BULK_MAX_OPERATIONS) {
        const result = await write(step.container, ops.slice(i, i + cosmos.BULK_MAX_OPERATIONS));
        s.patched += result.succeeded || 0;
        s.failed += result.failed || 0;
        s.skipped += (result.skippedIds || []).length;
      }
    }
    logger.info(summaryLine(s));
    summaries.push(s);
  }
  return summaries;
}

/** A rejected write exits 1; a 412 is a row that changed meanwhile, not a failure. */
function exitCodeFor(summaries) {
  return summaries.some(s => s.failed > 0) ? 1 : 0;
}

module.exports = { parseArgs, planRow, backfillEagleLadder, exitCodeFor, summaryLine, STEPS };

if (require.main === module) {
  cosmos.initCosmosClient();

  backfillEagleLadder(process.argv.slice(2))
    .then(summaries => process.exit(exitCodeFor(summaries)))
    .catch(err => {
      logger.error('[eagle-ladder] Fatal', { error: err.message, stack: err.stack });
      process.exit(1);
    });
}
