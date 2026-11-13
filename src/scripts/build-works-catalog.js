'use strict';

// `node src/scripts/build-works-catalog.js [--dry-run]`. Eagle List ids and phase catalog ids differ
// per environment, so the map names Eagle rows and phases, resolved here against DEMI's stored rows.

const MAP = require('../data/works-catalog-map.json');
const phaseCatalogs = require('../domain/phase-catalog');
const { LISTS } = require('../domain/works-catalog');
const { TRACK_WORK_TYPE_CODES } = require('../domain/work-model');
const { systemAccess } = require('../helpers/access-sql');
const listsRepository = require('../repositories/lists');
const { logger } = require('../utils/logger');
const { parseDryRunArgs, runWhenMain } = require('./catalog-cli');

const { normalizeName } = phaseCatalogs;
const APPLIED_TO = 'appliedTo';

const parseArgs = (argv) => parseDryRunArgs('works-catalog', argv);

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

/** Each `[label, owner]` claim whose normalised label has more than one owner. */
function conflictsOf(list, claims) {
  const owners = new Map();
  for (const [label, owner] of claims) {
    const key = normalizeName(label);
    owners.set(key, new Set([...(owners.get(key) || []), owner]));
  }
  return [...owners].filter(([, held]) => held.size > 1)
    .map(([label, held]) => `${list} "${label}": held by ${[...held].join(', ')}`);
}

function duplicateCodes(list, entries) {
  const codes = entries.map(entry => entry.code);
  return [...new Set(codes.filter((code, index) => codes.indexOf(code) !== index))]
    .map(code => `${list} "${code}": duplicate code`);
}

function resolveList(list, map, context) {
  const resolved = (map[list] || []).map(mapped => resolveEntry(list, mapped, context));
  const entries = resolved.map(one => one.entry);
  const claims = [...entries.flatMap(entry => [entry.code, entry.name, ...entry.aliases].map(label => [label, entry.code])),
    ...((map.skip2018 || {})[list] || []).map(label => [label, 'skip2018'])];
  return { entries, missing: [...resolved.flatMap(one => one.missing), ...duplicateCodes(list, entries),
    ...conflictsOf(list, claims)] };
}

/** Each Applied-To label as the phase catalog id it names under each of its Acts. */
function resolveAppliedTo(map, phaseCatalog) {
  const missing = [];
  const entries = (map[APPLIED_TO] || []).map(({ label, phase, acts = [] }) => {
    const catalogIds = {};
    for (const year of acts) {
      const entry = phaseCatalogs.entryForName(phaseCatalog, year, phase);
      if (entry) catalogIds[year] = entry.catalogId;
      else missing.push(`${APPLIED_TO} "${label}": ${year} phase "${phase}"`);
    }
    return { label, phase, acts, catalogIds };
  });
  const claims = [...entries.map(entry => [entry.label, entry.label]),
    ...((map.skip2018 || {})[APPLIED_TO] || []).map(label => [label, 'skip2018'])];
  return { entries, missing: [...missing, ...conflictsOf(APPLIED_TO, claims)] };
}

/**
 * The stored item from `map`, DEMI `List` rows and the stored phase catalog (`{[year]: entries}`).
 * Pure; `missing` names everything that did not resolve or that two owners claim.
 */
function resolveWorksCatalog(map, { listRows = [], phaseCatalog = {} } = {}) {
  const context = { workTypeIds: trackWorkTypeIds() };
  const item = { id: listsRepository.WORKS_CATALOG_ID, kind: listsRepository.KINDS.WORKS_CATALOG };
  const missing = [];
  for (const list of LISTS) {
    const resolved = resolveList(list, map, { ...context, eagleIdOf: eagleIdFinder(listRows, (map.eagleLists || {})[list]) });
    item[list] = resolved.entries;
    missing.push(...resolved.missing);
  }
  const appliedTo = resolveAppliedTo(map, phaseCatalog);
  item[APPLIED_TO] = appliedTo.entries;
  missing.push(...appliedTo.missing);
  item.skip2018 = map.skip2018 || {};

  const mapped = new Set(item.workTypes.map(entry => entry.code));
  for (const [id, code] of Object.entries(TRACK_WORK_TYPE_CODES)) {
    if (!mapped.has(code)) missing.push(`workTypes: no entry for Track work type ${id} "${code}"`);
  }
  for (const key of Object.keys(item.skip2018)) {
    if (![...LISTS, APPLIED_TO].includes(key)) missing.push(`skip2018 "${key}": not a catalog list`);
  }
  return { item, missing };
}

const summaryLine = (s) =>
  `[works-catalog] mode=${s.mode} written=${s.written} unchanged=${s.unchanged} missing=${s.missing}`;

const contentOf = (item) =>
  JSON.stringify(Object.fromEntries([...LISTS, APPLIED_TO, 'skip2018'].map(key => [key, item[key]])));

/**
 * Resolves and, unless `dryRun`, upserts the item when it changed. Anything missing stops the
 * write: a catalog short an entry would leave sheet labels with no code.
 * @param {object} [opts] {dryRun}, {deps} test seam {lists}
 */
async function run({ dryRun = false, deps = {} } = {}) {
  const lists = deps.lists || listsRepository;
  const listRows = await lists.listEveryOfKind(listsRepository.KINDS.LIST, systemAccess());
  const phaseCatalog = await phaseCatalogs.load(lists);
  const { item, missing } = resolveWorksCatalog(MAP, { listRows, phaseCatalog });
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

runWhenMain(module, 'works-catalog', run);
