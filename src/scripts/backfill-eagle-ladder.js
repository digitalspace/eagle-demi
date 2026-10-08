'use strict';

/**
 * Forward: `ownRead` on Eagle documents lacking one. `--reverse`: undo the dropped 2026-10-05 rule
 * that added `staff` to Eagle reads with no ladder token. Dry run unless `--live`; README "Eagle read
 * ladder backfill" has the rules and counters.
 */

const cosmos = require('../db/cosmos-nosql');
const { capRead, levelOfRead, isDemiSeal, LEVEL_TOKENS, SEALED_TOKEN } = require('../helpers/access-sql');
const eagleAcl = require('../helpers/eagle-acl');

const { eagleBaseAcl } = eagleAcl;
const { DELETED_CEILING } = require('../repositories/documents');
const { logger } = require('../utils/logger');

const PAGE_SIZE = 500;
const STAFF = LEVEL_TOKENS[2];
const LADDER = Object.freeze(Object.values(LEVEL_TOKENS));
const INSPECTION_KINDS = Object.freeze(['Inspection', 'InspectionElement', 'InspectionItem']);

/**
 * Containers in parent-first order, with each one's partition key and parent. `loadAll` marks a
 * container whose every row is read because it caps another container's rows; the rest are read
 * only where `read` carries `staff`, which every output of the dropped rule does.
 */
const STEPS = Object.freeze([
  { container: 'projects', pk: 'id', loadAll: true },
  { container: 'notifications', pk: 'id', loadAll: true },
  { container: 'lists', pk: 'kind' },
  { container: 'users', pk: 'id', deleteCeiling: true },
  { container: 'commentPeriods', pk: 'projectId', parent: 'project', loadAll: true, deleteCeiling: true },
  { container: 'documents', pk: 'projectId', parent: 'project', deleteCeiling: true },
  { container: 'groups', pk: 'projectId', parent: 'project', capByNotification: true, deleteCeiling: true },
  { container: 'inspections', pk: 'inspection', parent: 'inspection', loadAll: true, deleteCeiling: true },
  { container: 'comments', pk: 'periodId', parent: 'period', deleteCeiling: true },
  { container: 'updates', pk: 'id', parent: 'eagle' }
]);

/** The dropped rule, frozen here so the reverse can recognise what it wrote. Never call it on a push. */
const droppedRule = Object.freeze({
  widen(read) {
    if (read.includes(SEALED_TOKEN) || read.some(r => LADDER.includes(r))) return read;
    return [...read, STAFF];
  },
  own(eagleRead) {
    return droppedRule.widen(eagleBaseAcl(eagleRead));
  },
  under(eagleRead, cap, under = capRead) {
    const base = eagleBaseAcl(eagleRead);
    const read = under(droppedRule.widen(base), cap);
    // The dropped rule fell back to the plain cap where the widened read landed at `team`.
    return read.includes(LEVEL_TOKENS[1]) ? under(base, cap) : read;
  }
});

/** Eagle's read as DEMI applies it now. */
const eagleRule = Object.freeze({
  own: eagleRead => eagleBaseAcl(eagleRead),
  under: (eagleRead, cap, under = capRead) => under(eagleBaseAcl(eagleRead), cap)
});

function parseArgs(argv) {
  const args = { live: false, reverse: false };
  for (const a of argv) {
    if (a === '--live') args.live = true;
    else if (a === '--dry-run') args.live = false;
    else if (a === '--reverse') args.reverse = true;
    else throw new Error(`[eagle-ladder] unknown argument: ${a}`);
  }
  return args;
}

const isNonEmpty = read => Array.isArray(read) && read.length > 0;
const sameRead = (a, b) => Array.isArray(a) && Array.isArray(b) &&
  a.length === b.length && a.every((r, i) => r === b[i]);

async function allRows(queryPage, container, spec) {
  const rows = [];
  for (let skip = 0; ; skip += PAGE_SIZE) {
    const page = await queryPage(container, spec(skip), { size: PAGE_SIZE, skip });
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function pageParams(skip) {
  return [{ name: '@skip', value: skip }, { name: '@size', value: PAGE_SIZE }];
}

// ---------------------------------------------------------------------------------------------
// Forward: `ownRead` on documents that lack one.
// ---------------------------------------------------------------------------------------------

const NO_OWN_READ_SQL = 'NOT (IS_ARRAY(c.ownRead) AND ARRAY_LENGTH(c.ownRead) > 0)';

function forwardSpec(skip) {
  return {
    query: 'SELECT c.id, c.read, c.ownRead, c.projectId FROM c ' +
      `WHERE (IS_DEFINED(c.eagleId) OR IS_DEFINED(c.sources.eagle)) AND ${NO_OWN_READ_SQL} ` +
      'ORDER BY c.id OFFSET @skip LIMIT @size',
    parameters: pageParams(skip)
  };
}

/** A document's missing `ownRead`: its stored `read`, or null when it has one or has no `read`. */
function ownReadPlan(row) {
  if (isNonEmpty(row.ownRead) || !isNonEmpty(row.read)) return null;
  return row.read;
}

function forwardOp(row, ownRead, now) {
  return {
    operationType: 'Patch',
    partitionKey: row.projectId,
    id: String(row.id),
    resourceBody: {
      operations: [
        { op: 'set', path: '/updatedAt', value: now },
        { op: 'set', path: '/ownRead', value: ownRead }
      ],
      condition: `FROM c WHERE ${NO_OWN_READ_SQL}`
    }
  };
}

async function runForward(args, io) {
  const s = newSummary('documents', args);
  const ops = [];
  for (const row of await allRows(io.queryPage, 'documents', forwardSpec)) {
    s.scanned++;
    const ownRead = ownReadPlan(row);
    if (!ownRead) continue;
    s.planned++;
    ops.push(forwardOp(row, ownRead, io.now));
  }
  if (args.live) await writeAll(io.write, 'documents', ops, s);
  logger.info(summaryLine(s));
  return [s];
}

// ---------------------------------------------------------------------------------------------
// Reverse.
// ---------------------------------------------------------------------------------------------

function reverseSpec(step) {
  const staffOnly = step.loadAll ? '' : ` AND ARRAY_CONTAINS(c.read, '${STAFF}')`;
  return skip => ({
    query: 'SELECT c.id, c.read, c.ownRead, c.eagleId, c.projectId, c.periodId, c.kind, ' +
      'c.inspection, c.element, c.isDeleted, c.levelHeldAt, c.sealedAt, c._etag, ' +
      'c.sources.eagle.read AS eagleRead, c.sources.eagle.isDeleted AS eagleDeleted, ' +
      'c.sources.eagle.status AS eagleStatus, c.sources.eagle.active AS eagleActive, ' +
      'IS_DEFINED(c.sources.eagle) AS hasEagleSource FROM c ' +
      `WHERE (IS_DEFINED(c.eagleId) OR IS_DEFINED(c.sources.eagle))${staffOnly} ` +
      'ORDER BY c.id OFFSET @skip LIMIT @size',
    parameters: pageParams(skip)
  });
}

/**
 * Eagle's own read for a row: a document's `ownRead`, every other mirror's `sources.eagle.read`.
 * `undefined` when the row keeps none, which leaves it alone.
 */
function eagleReadOf(step, row) {
  if (step.container === 'documents') return isNonEmpty(row.ownRead) ? row.ownRead : undefined;
  return row.eagleRead;
}

const isDeletedRow = row => row.isDeleted === true || row.eagleDeleted === true;

/** A stored parent: its read before this run, after it, and what an Update's ceiling needs. */
function parentEntry(row, after) {
  return { before: row.read, after, sealedAt: row.sealedAt, eagleRead: row.eagleRead };
}

/**
 * The parent that caps a row, `undefined` for none, `null` when the parent is not stored. A
 * notification wins its id over a project (`parent-admit:pickParent`); it caps only groups,
 * inspections and Updates.
 */
function parentOf(step, row, parents) {
  const lookup = (map, ref) => (map.has(String(ref)) ? map.get(String(ref)) : null);
  if (step.parent === 'period') return lookup(parents.periods, row.periodId);
  if (step.parent === 'eagle') {
    if (!row.projectId) return undefined;
    if (parents.notifications.has(String(row.projectId))) return parents.notifications.get(String(row.projectId));
    // A missing parent caps nothing on a push either (`update-parent:readParent`).
    return parents.projectsByEagleId.get(String(row.projectId));
  }
  if (step.parent === 'inspection' && row.kind === 'InspectionElement') {
    return lookup(parents.inspections, row.inspection);
  }
  if (step.parent === 'inspection' && row.kind === 'InspectionItem') return lookup(parents.elements, row.element);
  if (!step.parent || !row.projectId) return undefined;
  if (parents.notifications.has(String(row.projectId))) {
    const capsUnderNotification = step.capByNotification || step.container === 'inspections';
    return capsUnderNotification ? parents.notifications.get(String(row.projectId)) : undefined;
  }
  return lookup(parents.projects, row.projectId);
}

/** `update-parent:updateRead`, under either rule. */
function updateRead(rule, row, parent, parentRead) {
  const ceiling = () => (levelOfRead(parentRead) !== 0 || parent.sealedAt ? parentRead : rule.own(parent.eagleRead));
  const capIfLower = (own, cap) => (levelOfRead(cap) < levelOfRead(own) ? capRead(own, cap) : own);
  const noRead = row.eagleRead === undefined || row.eagleRead === null;
  const noStatus = row.eagleStatus === undefined || row.eagleStatus === null;
  if (parent && noRead && noStatus && row.eagleActive === true) return ceiling();
  const own = isNonEmpty(row.eagleRead) ? rule.own(row.eagleRead) : [];
  if (!parent) return own;
  return own.length === 0 ? capIfLower(own, ceiling()) : rule.under(row.eagleRead, ceiling(), capIfLower);
}

/** The read a row gets under `rule` against `parentRead`, before any delete ceiling. */
function derive(step, rule, row, eagleRead, parent, parentRead) {
  if (step.parent === 'eagle') return updateRead(rule, row, parent, parentRead);
  return parent === undefined ? rule.own(eagleRead) : rule.under(eagleRead, parentRead);
}

/**
 * What the dropped rule and Eagle's rule give for one row, as pairs. A deleted row may hold either
 * pair: a push or cascade applies the delete ceiling, an inspection push does not.
 */
function candidates(step, row, eagleRead, parent) {
  const before = derive(step, droppedRule, row, eagleRead, parent, parent && parent.before);
  const after = derive(step, eagleRule, row, eagleRead, parent, parent && parent.after);
  const pairs = [{ dropped: before, target: after }];
  if (step.deleteCeiling && isDeletedRow(row)) {
    pairs.unshift({ dropped: capRead(before, DELETED_CEILING), target: capRead(after, DELETED_CEILING) });
  }
  return pairs;
}

/**
 * The read a row is patched to, or why not: `{read}`, `{skip: 'held'|'differs'|'noParent'}`, or
 * null when the dropped rule never touched it.
 */
function planReverse(step, row, parents) {
  const eagleRead = eagleReadOf(step, row);
  if (step.parent !== 'eagle' && eagleRead === undefined) return null;
  const parent = parentOf(step, row, parents);
  if (parent === null) return { skip: 'noParent' };
  const pairs = candidates(step, row, eagleRead, parent).filter(p => !sameRead(p.dropped, p.target));
  if (pairs.length === 0 || pairs.some(p => sameRead(row.read, p.target))) return null;
  if (row.levelHeldAt || (levelOfRead(row.read) === 0 && isDemiSeal(row))) return { skip: 'held' };
  const match = pairs.find(p => sameRead(row.read, p.dropped));
  return match ? { read: match.target } : { skip: 'differs' };
}

function reverseOp(step, row, read, now) {
  return {
    operationType: 'Patch',
    partitionKey: row[step.pk],
    id: String(row.id),
    ifMatch: row._etag,
    resourceBody: {
      operations: [
        { op: 'set', path: '/updatedAt', value: now },
        { op: 'set', path: '/read', value: read },
        { op: 'set', path: '/isPublished', value: read.includes('public') }
      ]
    }
  };
}

/** Record a row's read after this run, where it caps others. */
function rememberParent(step, row, after, parents) {
  const entry = parentEntry(row, after);
  if (step.container === 'projects') {
    parents.projects.set(String(row.id), entry);
    if (row.eagleId) parents.projectsByEagleId.set(String(row.eagleId), entry);
  } else if (step.container === 'notifications') {
    parents.notifications.set(String(row.id), entry);
  } else if (step.container === 'commentPeriods') {
    parents.periods.set(String(row.id), entry);
  } else if (row.kind === 'Inspection') {
    parents.inspections.set(String(row.id), entry);
  } else if (row.kind === 'InspectionElement') {
    parents.elements.set(String(row.id), entry);
  }
}

/** Inspections, elements, then items: each kind is capped by the one before it. */
function parentFirst(step, rows) {
  if (step.container !== 'inspections') return rows;
  const rank = row => INSPECTION_KINDS.indexOf(row.kind);
  return [...rows].sort((a, b) => rank(a) - rank(b));
}

async function runReverse(args, io) {
  const parents = {
    projects: new Map(), projectsByEagleId: new Map(), notifications: new Map(), periods: new Map(),
    inspections: new Map(), elements: new Map()
  };
  const summaries = [];
  for (const step of STEPS) {
    const s = newSummary(step.container, args);
    const ops = [];
    const rows = await allRows(io.queryPage, step.container, reverseSpec(step));
    for (const row of parentFirst(step, rows)) {
      if (!row.eagleId && row.hasEagleSource !== true) continue;
      s.scanned++;
      const plan = planReverse(step, row, parents);
      if (plan && plan.skip === 'held') s.skippedHeld++;
      else if (plan && plan.skip === 'differs') s.skippedDiffers++;
      else if (plan && plan.skip === 'noParent') s.noParent++;
      const read = plan && plan.read;
      // Children are capped by what the parent becomes, so a dry run counts what a live run writes.
      if (step.loadAll) rememberParent(step, row, read || row.read, parents);
      if (!read) continue;
      s.planned++;
      ops.push(reverseOp(step, row, read, io.now));
    }
    if (args.live) await writeAll(io.write, step.container, ops, s);
    logger.info(summaryLine(s));
    summaries.push(s);
  }
  return summaries;
}

// ---------------------------------------------------------------------------------------------

function newSummary(container, args) {
  return {
    container, mode: args.live ? 'live' : 'dry-run', direction: args.reverse ? 'reverse' : 'forward',
    scanned: 0, planned: 0, patched: 0, skippedHeld: 0, skippedDiffers: 0, noParent: 0, stale: 0, failed: 0
  };
}

async function writeAll(write, container, ops, s) {
  for (let i = 0; i < ops.length; i += cosmos.BULK_MAX_OPERATIONS) {
    const result = await write(container, ops.slice(i, i + cosmos.BULK_MAX_OPERATIONS));
    s.patched += result.succeeded || 0;
    s.failed += result.failed || 0;
    s.stale += (result.skippedIds || []).length;
  }
}

function summaryLine(s) {
  return `[eagle-ladder] container=${s.container} direction=${s.direction} mode=${s.mode} ` +
    `scanned=${s.scanned} planned=${s.planned} patched=${s.patched} skippedHeld=${s.skippedHeld} ` +
    `skippedDiffers=${s.skippedDiffers} noParent=${s.noParent} stale=${s.stale} failed=${s.failed}`;
}

/** Exit code for a reverse run refused because the rule it undoes is still in this build. */
const RULE_LIVE_EXIT = 2;

/** A reverse run under a build that still widens would be undone by the next push. */
function assertRuleRemoved(acl) {
  const live = ['withEagleStaff', 'seedAcl'].filter(name => name in acl);
  if (live.length === 0) return;
  throw Object.assign(new Error(`[eagle-ladder] --reverse refused: helpers/eagle-acl still exports ` +
    `${live.join(', ')}, so the staff rule is live and the next push would undo this run. ` +
    'Deploy a build without it first.'), { exitCode: RULE_LIVE_EXIT });
}

/**
 * @param {string[]} argv
 * @param {object} [deps] test seam: {queryPage, bulkVerified, now}
 * @returns {Promise<object[]>} one summary per container processed, in order
 */
async function backfillEagleLadder(argv = [], deps = {}) {
  const args = parseArgs(argv);
  if (args.reverse) assertRuleRemoved(deps.eagleAcl || eagleAcl);
  const io = {
    queryPage: deps.queryPage || cosmos.queryPage,
    write: deps.bulkVerified || cosmos.bulkVerified,
    now: deps.now || new Date().toISOString()
  };
  return args.reverse ? runReverse(args, io) : runForward(args, io);
}

/** A rejected write exits 1; a 412 is a row that changed meanwhile, not a failure. */
function exitCodeFor(summaries) {
  return summaries.some(s => s.failed > 0) ? 1 : 0;
}

module.exports = {
  parseArgs, planReverse, backfillEagleLadder, exitCodeFor, summaryLine, STEPS, droppedRule, RULE_LIVE_EXIT
};

if (require.main === module) {
  cosmos.initCosmosClient();

  backfillEagleLadder(process.argv.slice(2))
    .then(summaries => process.exit(exitCodeFor(summaries)))
    .catch(err => {
      logger.error('[eagle-ladder] Fatal', { error: err.message, stack: err.stack });
      process.exit(err.exitCode || 1);
    });
}
