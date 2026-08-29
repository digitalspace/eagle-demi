'use strict';

/**
 * The field redactor. One loop, one comparison, applied at the response boundary — never inside a
 * repository read, because eight controller paths read with the caller's access and spread the
 * result back into an upsert (docs/rbac-architecture.md §2 item 1).
 */

const { catalogFor, CATALOGS } = require('./catalog');
const { LEVELS, levelOf } = require('./level');
const PREDICATES = require('./predicates');
const config = require('../config');

// A `when` naming a predicate that does not exist would widen nothing and say nothing. Throwing at
// load stops a renamed or half-shipped predicate from silently pinning a field to `defaultVis`.
for (const [entity, catalog] of Object.entries(CATALOGS)) {
  for (const [field, entry] of Object.entries(catalog)) {
    if (entry && entry.when !== undefined && !Object.hasOwn(PREDICATES, entry.when)) {
      throw new Error(`[vis] unknown predicate "${entry.when}" on ${entity}.${field}`);
    }
  }
}

/**
 * The ONLY place the level order is assumed (docs/rbac-architecture.md §2 item 11).
 */
function visible(level, effVis) {
  return level <= effVis;
}

/**
 * A dial restricts below `defaultVis` and never above `maxVis`; anything else falls back. A dial
 * beats the predicate: a classified field stays classified whatever the record says.
 */
function effectiveVis(entry, dial, record) {
  if (LEVELS.includes(dial)) return Math.min(dial, entry.maxVis);
  if (entry.when && PREDICATES[entry.when](record || {})) return entry.maxVis;
  return entry.defaultVis;
}

/** `read[]` is authoritative and `isPublished` mirrors it — same rule as repositories/projects.js. */
function derivePublished(doc) {
  if (Array.isArray(doc.read) && doc.read.length) return doc.read.includes('public');
  return doc.isPublished === true;
}

/** The listed children of a dotted catalog key, for a parent the caller cannot see whole. */
function visibleChildren(catalog, dials, level, key, value, record) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const prefix = `${key}.`;
  const out = {};
  for (const catalogKey of Object.keys(catalog)) {
    if (!catalogKey.startsWith(prefix)) continue;
    const child = catalogKey.slice(prefix.length);
    if (!(child in value)) continue;
    // `sources.*` leaves the API only for the keys ENRICHMENT_SOURCES names (empty in prod) — the
    // allowlist publicView held before this replaced it.
    if (key === 'sources' && !config.enrichmentSources.includes(child)) continue;
    if (visible(level, effectiveVis(catalog[catalogKey], dials[catalogKey], record))) out[child] = value[child];
  }

  return Object.keys(out).length ? out : null;
}

/**
 * One record as this caller may see it. `catalogFor` runs first for EVERY caller, level 0 included,
 * so an unknown entity throws instead of returning an unfiltered record.
 */
function redactForAccess(entity, doc, access) {
  const catalog = catalogFor(entity);
  if (!doc || typeof doc !== 'object') return doc;

  const level = levelOf(access);
  const dials = doc.vis && typeof doc.vis === 'object' ? doc.vis : {};

  const out = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key === 'isPublished') continue;

    // Object.hasOwn: a stored key named constructor/toString must not hit Object.prototype.
    const entry = Object.hasOwn(catalog, key) ? catalog[key] : undefined;
    if (!entry) continue;

    if (visible(level, effectiveVis(entry, dials[key], doc))) {
      out[key] = value;
      continue;
    }

    const children = visibleChildren(catalog, dials, level, key, value, doc);
    if (children) out[key] = children;
  }

  if (catalog.isPublished && visible(level, effectiveVis(catalog.isPublished, dials.isPublished, doc))) {
    out.isPublished = derivePublished(doc);
  }

  return out;
}

function redactAllForAccess(entity, docs, access) {
  if (!Array.isArray(docs)) return docs;
  return docs.map(doc => redactForAccess(entity, doc, access));
}

/**
 * Body keys a caller may not write: `vis` at every level, anything uncatalogued, anything the
 * caller cannot see on the existing row (docs/rbac-architecture.md §2 item 1).
 */
function refusedWriteKeys(entity, changes, access, existing) {
  const catalog = catalogFor(entity);
  const dials = existing && existing.vis && typeof existing.vis === 'object' ? existing.vis : {};
  const level = levelOf(access);
  return Object.keys(changes).filter(key => key === 'vis' || !Object.hasOwn(catalog, key) ||
    !visible(level, effectiveVis(catalog[key], dials[key], existing)));
}

module.exports = { visible, effectiveVis, redactForAccess, redactAllForAccess, refusedWriteKeys };
