'use strict';

// `node src/scripts/build-phase-catalog.js [--dry-run]`. Ids differ per environment, so the map is
// keyed by name and resolved here against DEMI `List` rows and Track phase codes.

const config = require('../config');
const MAP = require('../data/phase-catalog-map.json');
const { LEGISLATIONS } = require('../domain/project-legislation');
const { CATALOG_YEARS, GROUPS, normalizeName } = require('../domain/phase-catalog');
const { systemAccess } = require('../helpers/access-sql');
const listsRepository = require('../repositories/lists');
const { clientToken, fetchJson, trackFeedConfigured } = require('../seed/sources');
const { logger } = require('../utils/logger');

const PHASE_LIST_TYPE = 'projectPhase';

function parseArgs(argv) {
  const args = { dryRun: false };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else throw new Error(`[phase-catalog] unknown argument: ${arg}`);
  }
  return args;
}

/** The Act a Track phase code belongs to, from its `ea_act` name such as "EA Act (2018)". */
function trackActYear(code) {
  const year = Number((/\b(19|20)\d{2}\b/.exec((code.ea_act || {}).name || '') || [])[0]);
  return CATALOG_YEARS.includes(year) ? year : null;
}

const workTypeOf = (code) => Number(code.work_type_id ?? (code.work_type || {}).id);
const unique = (values) => [...new Set(values)];

/** Name-keyed lookups for one Act; a name held by two rows stays out, so it reports as missing. */
function indexByName(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(normalizeName(row.name), (counts.get(normalizeName(row.name)) || 0) + 1);
  return new Map(rows.filter(row => counts.get(normalizeName(row.name)) === 1)
    .map(row => [normalizeName(row.name), row]));
}

/** The Track codes an entry's `track` names, plus each name no code matched. */
function trackCodesFor(mapped, codesByWorkType) {
  const codes = [];
  const missing = [];
  for (const [workTypeId, names] of Object.entries(mapped.track || {})) {
    const byName = codesByWorkType.get(Number(workTypeId)) || new Map();
    for (const name of names) {
      const code = byName.get(normalizeName(name));
      if (code) codes.push(code);
      else missing.push(`track ${workTypeId} "${name}"`);
    }
  }
  return { codes, missing };
}

function entryFor(mapped, eagleRow, codes) {
  const isEagle = mapped.eagle !== false;
  const name = isEagle ? eagleRow.name : codes[0].name;
  const key = normalizeName(name);
  const aliases = unique([...(mapped.aliases || []), ...codes.map(code => code.name)])
    .filter(alias => normalizeName(alias) !== key);
  return {
    catalogId: isEagle ? String(eagleRow.id) : `track-${codes[0].id}`,
    group: mapped.group,
    eagleListId: isEagle ? String(eagleRow.id) : null,
    name,
    stage: mapped.stage ?? null,
    order: (isEagle ? eagleRow.listOrder : codes[0].sort_order) ?? null,
    trackPhaseCodeIds: codes.map(code => Number(code.id)),
    workTypeIds: unique(codes.map(workTypeOf)),
    aliases
  };
}

function mintedEntry(code) {
  return {
    catalogId: `track-${code.id}`, group: GROUPS.ASSESSMENT, eagleListId: null, name: code.name, stage: null,
    order: code.sort_order ?? null, trackPhaseCodeIds: [Number(code.id)], workTypeIds: [workTypeOf(code)], aliases: []
  };
}

const byOrder = (a, b) =>
  (a.order ?? Infinity) - (b.order ?? Infinity) || String(a.catalogId).localeCompare(String(b.catalogId));

/** One Act's entries, and what of its map or sources found no partner. */
function resolveAct(year, mappedEntries, listRows, trackCodes) {
  const listYear = LEGISLATIONS[year].phaseRowsYear ?? year;
  const eagleByName = indexByName(listRows.filter(row =>
    row && row.type === PHASE_LIST_TYPE && Number(row.legislation) === listYear));
  const yearCodes = trackCodes.filter(code => code && trackActYear(code) === year);
  const codesByWorkType = new Map(unique(yearCodes.map(workTypeOf)).map(workTypeId =>
    [workTypeId, indexByName(yearCodes.filter(code => workTypeOf(code) === workTypeId))]));

  const entries = [];
  const missing = [];
  for (const mapped of mappedEntries) {
    const eagleRow = mapped.eagle === false ? null : eagleByName.get(normalizeName(mapped.name));
    const { codes, missing: lost } = trackCodesFor(mapped, codesByWorkType);
    missing.push(...lost.map(what => `${year} "${mapped.name}": ${what}`));
    if (mapped.eagle !== false && !eagleRow) missing.push(`${year} "${mapped.name}": Eagle List row`);
    else if (mapped.eagle === false && codes.length !== 1) missing.push(`${year} "${mapped.name}": one Track code`);
    else entries.push(entryFor(mapped, eagleRow, codes));
  }

  const used = new Set(entries.flatMap(entry => entry.trackPhaseCodeIds));
  const unmapped = yearCodes.filter(code => !used.has(Number(code.id)));
  const minted = unmapped.filter(code => MAP.mintTrackWorkTypeIds.includes(workTypeOf(code)));
  const skipped = unmapped.filter(code => !MAP.mintTrackWorkTypeIds.includes(workTypeOf(code)))
    .map(code => `${year} track ${workTypeOf(code)} "${code.name}"`);
  return {
    entries: [...entries, ...minted.map(mintedEntry)].sort(byOrder),
    missing,
    minted: minted.map(code => `${year} track ${workTypeOf(code)} "${code.name}"`),
    skipped
  };
}

/**
 * The stored items from `map`, DEMI `List` rows and Track phase codes (`GET /api/v1/phases/`).
 * Pure. `missing` names each map entry that did not resolve; `minted` the Track-only entries.
 */
function resolveCatalog(map, { listRows = [], trackCodes = [] } = {}) {
  const report = { missing: [], minted: [], skipped: [] };
  const items = CATALOG_YEARS.map((year) => {
    const act = resolveAct(year, (map.acts || {})[year] || [], listRows, trackCodes);
    report.missing.push(...act.missing);
    report.minted.push(...act.minted);
    report.skipped.push(...act.skipped);
    return {
      id: listsRepository.catalogItemId(year),
      kind: listsRepository.KINDS.PHASE_CATALOG,
      legislationYear: year,
      entries: act.entries
    };
  });
  return { items, ...report };
}

async function fetchTrackCodes() {
  if (!trackFeedConfigured()) throw new Error('[phase-catalog] TRACK_API_BASE and the Track client are not set');
  const token = await clientToken(config.trackClientId, config.trackClientSecret);
  return fetchJson(`${config.trackApiBase}/api/v1/phases/`, { Authorization: `Bearer ${token}` });
}

const summaryLine = (s) => `[phase-catalog] mode=${s.mode} written=${s.written} unchanged=${s.unchanged} ` +
  `missing=${s.missing} minted=${s.minted} skipped=${s.skipped}`;

/**
 * Resolves and, unless `dryRun`, upserts each changed item. A map entry that does not resolve stops
 * the write: an Act's catalog missing a phase would hide it from every lookup.
 * @param {object} [opts] {dryRun}, {deps} test seam {lists, trackCodes}
 */
async function run({ dryRun = false, deps = {} } = {}) {
  const lists = deps.lists || listsRepository;
  const listRows = await lists.listEveryOfKind(listsRepository.KINDS.LIST, systemAccess());
  const trackCodes = await (deps.trackCodes || fetchTrackCodes)();
  const resolved = resolveCatalog(MAP, { listRows, trackCodes: Array.isArray(trackCodes) ? trackCodes : [] });
  const summary = { mode: dryRun ? 'dry-run' : 'write', written: 0, unchanged: 0,
    missing: resolved.missing.length, minted: resolved.minted.length, skipped: resolved.skipped.length };

  for (const line of resolved.missing) logger.warn(`[phase-catalog] missing ${line}`);
  for (const line of resolved.minted) logger.info(`[phase-catalog] Track-only ${line}`);
  for (const line of resolved.skipped) logger.info(`[phase-catalog] skipped ${line}`);

  if (dryRun) {
    logger.info(`[phase-catalog] resolved ${JSON.stringify(resolved.items, null, 2)}`);
  } else if (resolved.missing.length === 0) {
    for (const item of resolved.items) {
      const existing = await lists.readCatalog(item.legislationYear);
      if (existing && JSON.stringify(existing.entries) === JSON.stringify(item.entries)) {
        summary.unchanged++;
        continue;
      }
      await lists.upsert(item, existing);
      summary.written++;
    }
  }
  logger.info(summaryLine(summary));
  return summary;
}

module.exports = { parseArgs, resolveCatalog, run };

if (require.main === module) {
  run(parseArgs(process.argv.slice(2)))
    .then(summary => process.exit(summary.missing > 0 ? 1 : 0))
    .catch((err) => {
      logger.error(`[phase-catalog] ${err.stack || err.message}`);
      process.exit(1);
    });
}
