'use strict';

// The phase catalog: per Act, one entry per phase, Eagle's name winning over Track's. A catalog is
// `{ [year]: entries[] }`; an Act with no stored item is absent, and every lookup on it answers null.

const { LEGISLATIONS } = require('./project-legislation');
const listsRepository = require('../repositories/lists');

const GROUPS = Object.freeze({ ASSESSMENT: 'assessment', POST_DECISION: 'postDecision' });
const CATALOG_YEARS = Object.freeze(Object.keys(LEGISLATIONS).map(Number));

/** Folds case, punctuation and `&` against `and`, so names match as Track and Eagle write them. */
const normalizeName = (name) =>
  String(name).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

/** A `phaseHistory` or `currentPhaseName` entry as its List id: eagle-admin writes bare ids and `{_id, name}` refs. */
function phaseIdOf(entry) {
  if (entry === null || entry === undefined) return null;
  const id = typeof entry === 'object' ? entry._id ?? entry.id ?? null : entry;
  return id === null || id === '' ? null : String(id);
}

const phaseHistoryIds = (history) =>
  (Array.isArray(history) ? history : []).map(phaseIdOf).filter(id => id !== null);

const entriesOf = (catalog, year) =>
  (catalog && Array.isArray(catalog[year]) ? catalog[year] : []);

function entryForTrackCode(catalog, year, phaseCodeId) {
  const id = Number(phaseCodeId);
  if (!Number.isFinite(id)) return null;
  return entriesOf(catalog, year).find(entry => (entry.trackPhaseCodeIds || []).includes(id)) || null;
}

/** By the entry's Eagle List id; `listId` may be a bare id or a `{_id, name}` ref. */
function entryForEagleId(catalog, year, listId) {
  const id = phaseIdOf(listId);
  if (id === null) return null;
  return entriesOf(catalog, year).find(entry => entry.eagleListId === id) || null;
}

/** By name or alias, for a phase that carries no id yet. */
function entryForName(catalog, year, name) {
  if (typeof name !== 'string' || !name) return null;
  const key = normalizeName(name);
  return entriesOf(catalog, year).find(entry =>
    [entry.name, ...(entry.aliases || [])].some(one => normalizeName(one) === key)) || null;
}

/**
 * The stage row a phase sits on under `year`, tried by Track code, then List id, then name. A name
 * that is itself a stage row of the Act, such as "Post Decision", is that row.
 */
function stageOf(catalog, year, { phaseCodeId, listId, name } = {}) {
  const entry = (phaseCodeId !== undefined && entryForTrackCode(catalog, year, phaseCodeId)) ||
    (listId !== undefined && entryForEagleId(catalog, year, listId)) ||
    entryForName(catalog, year, name);
  if (entry) return entry.stage ?? null;
  if (typeof name !== 'string' || !name) return null;
  const key = normalizeName(name);
  const row = entriesOf(catalog, year).find(one => one.stage && normalizeName(one.stage) === key);
  return row ? row.stage : null;
}

const loaded = new WeakMap();

/**
 * Every Act's stored catalog, read once per repository object and held for the life of the
 * instance. A failed read is not held, so the next call retries.
 */
function load(repository = listsRepository) {
  if (!loaded.has(repository)) {
    const pending = Promise.all(CATALOG_YEARS.map(year => repository.readCatalog(year)))
      .then(items => Object.fromEntries(CATALOG_YEARS.flatMap((year, index) =>
        items[index] && Array.isArray(items[index].entries) ? [[year, items[index].entries]] : [])));
    pending.catch(() => loaded.delete(repository));
    loaded.set(repository, pending);
  }
  return loaded.get(repository);
}

module.exports = {
  GROUPS,
  CATALOG_YEARS,
  normalizeName,
  phaseIdOf,
  phaseHistoryIds,
  entryForTrackCode,
  entryForEagleId,
  entryForName,
  stageOf,
  load
};
