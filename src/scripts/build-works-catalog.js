'use strict';

// `node src/scripts/build-works-catalog.js [--dry-run]`. Eagle List ids differ per environment, so
// the map names Eagle rows and they are resolved here against DEMI `List` rows.

const MAP = require('../data/works-catalog-map.json');
const { normalizeName } = require('../domain/phase-catalog');
const { LISTS } = require('../domain/works-catalog');
const { TRACK_WORK_TYPE_CODES } = require('../domain/work-model');
const { systemAccess } = require('../helpers/access-sql');
const listsRepository = require('../repositories/lists');
const { logger } = require('../utils/logger');

function parseArgs(argv) {
  const args = { dryRun: false };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else throw new Error(`[works-catalog] unknown argument: ${arg}`);
  }
  return args;
}

/** Track work type ids per catalog code; TRACK_WORK_TYPE_CODES is the one source. */
function trackWorkTypeIds() {
  const byCode = new Map();
  for (const [id, code] of Object.entries(TRACK_WORK_TYPE_CODES)) {
    byCode.set(code, [...(byCode.get(code) || []), Number(id)]);
  }
  return byCode;
}

/** An Eagle List row id by name; a name held by two rows resolves to none. */
function eagleIdFinder(listRows, spec) {
  const rows = spec ? listRows.filter(row => row && row.type === spec.type &&
    Number(row.legislation) === spec.legislation) : [];
  return (name) => {
    const hits = rows.filter(row => normalizeName(row.name) === normalizeName(name));
    return hits.length === 1 ? String(hits[0].id) : null;
  };
}

function resolveEntry(list, mapped, { eagleIdOf, workTypeIds }) {
  const { eagle, trackIds, aliases, acts, ...rest } = mapped;
  const eagleListId = eagle ? eagleIdOf(eagle) : null;
  const entry = {
    ...rest,
    aliases: aliases || [],
    acts: acts || [],
    trackIds: list === 'workTypes' ? workTypeIds.get(mapped.code) || [] : trackIds || [],
    eagleListId
  };
  return { entry, missing: eagle && !eagleListId ? [`${list} "${mapped.code}": Eagle List row "${eagle}"`] : [] };
}

/** Each label, normalised, held by more than one entry or also listed as skipped. */
function conflictsOf(list, entries, skipped) {
  const owners = new Map();
  const claim = (label, owner) => {
    const key = normalizeName(label);
    owners.set(key, new Set([...(owners.get(key) || []), owner]));
  };
  for (const entry of entries) {
    for (const label of [entry.code, entry.name, ...entry.aliases]) claim(label, entry.code);
  }
  for (const label of skipped) claim(label, 'skip2018');
  return [...owners].filter(([, held]) => held.size > 1)
    .map(([label, held]) => `${list} "${label}": held by ${[...held].join(', ')}`);
}

/**
 * The stored item from `map` and DEMI `List` rows. Pure. `missing` names each Eagle row that did not
 * resolve, each Track work type with no entry, and each label two entries claim.
 */
function resolveWorksCatalog(map, { listRows = [] } = {}) {
  const workTypeIds = trackWorkTypeIds();
  const skip2018 = map.skip2018 || {};
  const item = { id: listsRepository.WORKS_CATALOG_ID, kind: listsRepository.KINDS.WORKS_CATALOG };
  const missing = [];
  for (const list of LISTS) {
    const context = { eagleIdOf: eagleIdFinder(listRows, (map.eagleLists || {})[list]), workTypeIds };
    const resolved = (map[list] || []).map(mapped => resolveEntry(list, mapped, context));
    item[list] = resolved.map(one => one.entry);
    missing.push(...resolved.flatMap(one => one.missing), ...conflictsOf(list, item[list], skip2018[list] || []));
  }
  item.skip2018 = skip2018;
  const mapped = new Set(item.workTypes.map(entry => entry.code));
  for (const [id, code] of Object.entries(TRACK_WORK_TYPE_CODES)) {
    if (!mapped.has(code)) missing.push(`workTypes: no entry for Track work type ${id} "${code}"`);
  }
  return { item, missing };
}

const summaryLine = (s) =>
  `[works-catalog] mode=${s.mode} written=${s.written} unchanged=${s.unchanged} missing=${s.missing}`;

const contentOf = (item) =>
  JSON.stringify(Object.fromEntries([...LISTS, 'skip2018'].map(key => [key, item[key]])));

/**
 * Resolves and, unless `dryRun`, upserts the item when it changed. Anything missing stops the
 * write: a catalog short an entry would leave sheet labels with no code.
 * @param {object} [opts] {dryRun}, {deps} test seam {lists}
 */
async function run({ dryRun = false, deps = {} } = {}) {
  const lists = deps.lists || listsRepository;
  const listRows = await lists.listEveryOfKind(listsRepository.KINDS.LIST, systemAccess());
  const { item, missing } = resolveWorksCatalog(MAP, { listRows });
  const summary = { mode: dryRun ? 'dry-run' : 'write', written: 0, unchanged: 0, missing: missing.length };

  for (const line of missing) logger.warn(`[works-catalog] missing ${line}`);
  if (dryRun) {
    logger.info(`[works-catalog] resolved ${JSON.stringify(item, null, 2)}`);
  } else if (missing.length === 0) {
    const existing = await lists.readWorksCatalog();
    if (existing && contentOf(existing) === contentOf(item)) summary.unchanged++;
    else {
      await lists.upsert(item, existing);
      summary.written++;
    }
  }
  logger.info(summaryLine(summary));
  return summary;
}

module.exports = { parseArgs, resolveWorksCatalog, run };

if (require.main === module) {
  run(parseArgs(process.argv.slice(2)))
    .then(summary => process.exit(summary.missing > 0 ? 1 : 0))
    .catch((err) => {
      logger.error(`[works-catalog] ${err.stack || err.message}`);
      process.exit(1);
    });
}
