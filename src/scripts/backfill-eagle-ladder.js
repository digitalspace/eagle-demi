'use strict';

/**
 * Forward: `ownRead` on Eagle documents lacking one. `--reverse`: undo the dropped 2026-10-05 rule
 * that added `staff` to Eagle reads with no ladder token. Dry run unless `--live`; README "Eagle read
 * ladder backfill" has the rules and counters.
 */

const cosmos = require('../db/cosmos-nosql');
const {
  capRead, levelOfRead, readForLevel, isDemiSeal, LEVEL_TOKENS, SEALED_TOKEN, SECURE_ROLES
} = require('../helpers/access-sql');
const { eagleBaseAcl, eagleReadUnder } = require('../helpers/eagle-acl');
const { inheritsParentRead, updateRead } = require('../helpers/update-parent');
const { DELETED_CEILING } = require('../repositories/documents');
const { logger } = require('../utils/logger');

const PAGE_SIZE = 500;
const TEAM = LEVEL_TOKENS[1];
const STAFF = LEVEL_TOKENS[2];
const LADDER = Object.freeze(Object.values(LEVEL_TOKENS));
const INSPECTION_KINDS = Object.freeze(['Inspection', 'InspectionElement', 'InspectionItem']);

/**
 * Containers in parent-first order, with each one's partition key and parent. Every output of the
 * dropped rule carries `staff` or is `['team']`, so a container is read only where `read` carries
 * one of them, except: `loadAll` containers cap others and are read in full, and Updates
 * (`scanAll`) are read in full because the old cap kept some at their own roles.
 */
const STEPS = Object.freeze([
  { container: 'projects', pk: 'id', loadAll: true },
  { container: 'notifications', pk: 'id', loadAll: true },
  { container: 'lists', pk: 'kind' },
  { container: 'users', pk: 'id', deleteCeiling: true },
  { container: 'commentPeriods', pk: 'projectId', parent: 'project', loadAll: true, deleteCeiling: true },
  // A seed stores a document whose project is not stored uncapped; a push refuses every other orphan.
  { container: 'documents', pk: 'projectId', parent: 'project', deleteCeiling: true, ownWhenParentMissing: true },
  { container: 'groups', pk: 'projectId', parent: 'project', capByNotification: true, deleteCeiling: true },
  { container: 'inspections', pk: 'inspection', parent: 'inspection', loadAll: true, deleteCeiling: true },
  { container: 'comments', pk: 'periodId', parent: 'period', deleteCeiling: true },
  { container: 'updates', pk: 'id', parent: 'eagle', scanAll: true }
]);

/**
 * The rule as it stood before 2026-10-08, frozen here so the reverse recognises what it wrote: the
 * old `eagleBaseAcl` and `capRead` (level-1 reads made only of SECURE_ROLES kept), plus the staff
 * widening. Never call it on a push.
 */
const droppedRule = Object.freeze({
  base(upstreamRead) {
    if (!Array.isArray(upstreamRead) || upstreamRead.length === 0) return readForLevel(2);
    const kept = upstreamRead.filter(r => typeof r === 'string' && r.trim() !== '');
    const open = kept.filter(r => r !== SEALED_TOKEN);
    return open.length === 0 && kept.length > 0 ? ['sysadmin'] : open;
  },
  cap(own, cap) {
    const level = Math.min(levelOfRead(own), levelOfRead(cap));
    if (level !== 1) return readForLevel(level);
    const privilegedOnly = read => Array.isArray(read) && read.every(r => SECURE_ROLES.includes(r));
    if (privilegedOnly(own)) return own;
    if (privilegedOnly(cap) && cap.length > 0) return cap;
    return readForLevel(1);
  },
  widen(read) {
    if (read.includes(SEALED_TOKEN) || read.some(r => LADDER.includes(r))) return read;
    return [...read, STAFF];
  },
  own(eagleRead) {
    return droppedRule.widen(droppedRule.base(eagleRead));
  },
  under(eagleRead, cap, under = droppedRule.cap) {
    const base = droppedRule.base(eagleRead);
    const read = under(droppedRule.widen(base), cap);
    // The dropped rule fell back to the plain cap where the widened read landed at `team`.
    return read.includes(TEAM) ? under(base, cap) : read;
  },
  /** The old `update-parent:updateRead`: capped only where the ceiling's level is lower. */
  update(row, parent, parentRead) {
    const ceiling = () => (levelOfRead(parentRead) !== 0 || parent.sealedAt
      ? parentRead : droppedRule.own(parent.eagleRead));
    const capIfLower = (own, cap) => (levelOfRead(cap) < levelOfRead(own) ? droppedRule.cap(own, cap) : own);
    if (parent && inheritsParentRead(updateSource(row))) return ceiling();
    const own = isNonEmpty(row.eagleRead) ? droppedRule.own(row.eagleRead) : [];
    if (!parent) return own;
    return own.length === 0 ? capIfLower(own, ceiling()) : droppedRule.under(row.eagleRead, ceiling(), capIfLower);
  }
});

/** Eagle's read as DEMI applies it now: the push's own helpers. */
const eagleRule = Object.freeze({
  cap: capRead,
  own: eagleBaseAcl,
  under: eagleReadUnder,
  update(row, parent, parentRead) {
    const stored = parent && {
      read: parentRead, doc: { sealedAt: parent.sealedAt, sources: { eagle: { read: parent.eagleRead } } }
    };
    return updateRead(updateSource(row), stored || null);
  }
});

/** The Eagle record fields an Update's read derives from, as the query projects them. */
function updateSource(row) {
  return { read: row.eagleRead, status: row.eagleStatus, active: row.eagleActive };
}

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
  const touched = step.loadAll || step.scanAll ? ''
    : ` AND (ARRAY_CONTAINS(c.read, '${STAFF}') OR ARRAY_CONTAINS(c.read, '${TEAM}'))`;
  return skip => ({
    query: 'SELECT c.id, c.read, c.ownRead, c.eagleId, c.projectId, c.periodId, c.kind, ' +
      'c.inspection, c.element, c.isDeleted, c.levelHeldAt, c.sealedAt, c._etag, ' +
      'c.sources.eagle.read AS eagleRead, c.sources.eagle.isDeleted AS eagleDeleted, ' +
      'c.sources.eagle.status AS eagleStatus, c.sources.eagle.active AS eagleActive, ' +
      'IS_DEFINED(c.sources.eagle) AS hasEagleSource FROM c ' +
      `WHERE (IS_DEFINED(c.eagleId) OR IS_DEFINED(c.sources.eagle))${touched} ` +
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

/** The read a row gets under `rule` against `parentRead`, before any delete ceiling. */
function derive(step, rule, row, eagleRead, parent, parentRead) {
  if (step.parent === 'eagle') return rule.update(row, parent, parentRead);
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
    pairs.unshift({ dropped: droppedRule.cap(before, DELETED_CEILING), target: eagleRule.cap(after, DELETED_CEILING) });
  }
  return pairs;
}

/**
 * The read a row is patched to, or why not: `{read}`, `{skip: 'held'|'differs'|'noParent'}`, or
 * null when the dropped rule never touched it. A row whose step stores it uncapped when its parent
 * is not stored is planned as having no parent, flagged `parentMissing`.
 */
function planReverse(step, row, parents) {
  const eagleRead = eagleReadOf(step, row);
  if (step.parent !== 'eagle' && eagleRead === undefined) return null;
  const parent = parentOf(step, row, parents);
  if (parent === null && !step.ownWhenParentMissing) return { skip: 'noParent' };
  if (parent === null) return { ...planAgainst(step, row, eagleRead, undefined), parentMissing: true };
  return planAgainst(step, row, eagleRead, parent);
}

function planAgainst(step, row, eagleRead, parent) {
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

/** Record a row's read after this run, where it caps others. Returns the entry, or undefined. */
function rememberParent(step, row, after, parents) {
  const entry = parentEntry(row, after);
  const id = String(row.id);
  if (step.container === 'projects') {
    parents.projects.set(id, entry);
    if (row.eagleId) parents.projectsByEagleId.set(String(row.eagleId), entry);
  } else if (step.container === 'notifications') {
    parents.notifications.set(id, entry);
  } else if (step.container === 'commentPeriods') {
    parents.periods.set(id, entry);
  } else if (row.kind === 'Inspection') {
    parents.inspections.set(id, entry);
  } else if (row.kind === 'InspectionElement') {
    parents.elements.set(id, entry);
  } else {
    return undefined;
  }
  return entry;
}

/** Inspections, elements, then items, each written before the next is planned against it. */
function batches(step, rows) {
  if (step.container !== 'inspections') return [rows];
  return INSPECTION_KINDS.map(kind => rows.filter(row => row.kind === kind));
}

async function runReverse(args, io) {
  const parents = {
    projects: new Map(), projectsByEagleId: new Map(), notifications: new Map(), periods: new Map(),
    inspections: new Map(), elements: new Map()
  };
  const summaries = [];
  for (const step of STEPS) {
    const s = newSummary(step.container, args);
    const rows = await allRows(io.queryPage, step.container, reverseSpec(step));
    for (const batch of batches(step, rows)) {
      const ops = [];
      const remembered = new Map();
      for (const row of batch) {
        if (!row.eagleId && row.hasEagleSource !== true) continue;
        s.scanned++;
        const plan = planReverse(step, row, parents);
        if (plan && plan.skip === 'held') s.skippedHeld++;
        else if (plan && plan.skip === 'differs') s.skippedDiffers++;
        else if (plan && plan.skip === 'noParent') s.noParent++;
        if (plan && plan.parentMissing) s.parentMissing++;
        const read = plan && plan.read;
        // Children are capped by what the parent becomes, so a dry run counts what a live run writes.
        const entry = step.loadAll && rememberParent(step, row, read || row.read, parents);
        if (entry) remembered.set(String(row.id), entry);
        if (!read) continue;
        s.planned++;
        ops.push(reverseOp(step, row, read, io.now));
      }
      if (!args.live) continue;
      // A parent whose patch did not land still caps its children at its stored read.
      for (const id of await writeAll(io.write, step.container, ops, s)) {
        const entry = remembered.get(id);
        if (entry) entry.after = entry.before;
      }
    }
    logger.info(summaryLine(s));
    summaries.push(s);
  }
  return summaries;
}

// ---------------------------------------------------------------------------------------------

function newSummary(container, args) {
  return {
    container, mode: args.live ? 'live' : 'dry-run', direction: args.reverse ? 'reverse' : 'forward',
    scanned: 0, planned: 0, patched: 0, skippedHeld: 0, skippedDiffers: 0, noParent: 0, parentMissing: 0,
    stale: 0, failed: 0
  };
}

/** Write `ops` in bulk batches. Returns the ids that did not land: failed, or 412. */
async function writeAll(write, container, ops, s) {
  const missed = [];
  for (let i = 0; i < ops.length; i += cosmos.BULK_MAX_OPERATIONS) {
    const result = await write(container, ops.slice(i, i + cosmos.BULK_MAX_OPERATIONS));
    s.patched += result.succeeded || 0;
    s.failed += result.failed || 0;
    s.stale += (result.skippedIds || []).length;
    missed.push(...(result.failedIds || []), ...(result.skippedIds || []));
  }
  return missed.map(String);
}

function summaryLine(s) {
  return `[eagle-ladder] container=${s.container} direction=${s.direction} mode=${s.mode} ` +
    `scanned=${s.scanned} planned=${s.planned} patched=${s.patched} skippedHeld=${s.skippedHeld} ` +
    `skippedDiffers=${s.skippedDiffers} noParent=${s.noParent} parentMissing=${s.parentMissing} ` +
    `stale=${s.stale} failed=${s.failed}`;
}

/**
 * @param {string[]} argv
 * @param {object} [deps] test seam: {queryPage, bulkVerified, now}
 * @returns {Promise<object[]>} one summary per container processed, in order
 */
async function backfillEagleLadder(argv = [], deps = {}) {
  const args = parseArgs(argv);
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
  parseArgs, backfillEagleLadder, exitCodeFor, summaryLine, STEPS
};

if (require.main === module) {
  cosmos.initCosmosClient();

  backfillEagleLadder(process.argv.slice(2))
    .then(summaries => process.exit(exitCodeFor(summaries)))
    .catch(err => {
      logger.error('[eagle-ladder] Fatal', { error: err.message, stack: err.stack });
      process.exit(1);
    });
}
