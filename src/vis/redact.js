'use strict';

/**
 * The field redactor. One loop, one comparison, applied at the response boundary — never inside a
 * repository read, because eight controller paths read with the caller's access and spread the
 * result back into an upsert (docs/rbac-architecture.md §2 item 1).
 */

const { catalogFor, CATALOGS } = require('./catalog');
const { ANONYMOUS_LEVEL, LEVELS } = require('./level');
const config = require('../config');

// Predicates are Phase 3 (docs/rbac-architecture.md §2 item 7). Throwing at load rather than
// ignoring `when` stops a half-shipped predicate from silently reading as "always visible".
for (const [entity, catalog] of Object.entries(CATALOGS)) {
  for (const [field, entry] of Object.entries(catalog)) {
    if (entry && entry.when !== undefined) {
      throw new Error(`[vis] predicates are not supported yet: ${entity}.${field} declares "when"`);
    }
  }
}

/**
 * The ONLY place the level order is assumed (docs/rbac-architecture.md §2 item 11). Switching to a
 * clearance set changes this function and `levelFromRoles`, nothing else.
 */
function visible(level, effVis) {
  return level <= effVis;
}

/** A dial restricts below `defaultVis` and never above `maxVis`; anything else falls back. */
function effectiveVis(entry, dial) {
  if (!LEVELS.includes(dial)) return entry.defaultVis;
  return Math.min(dial, entry.maxVis);
}

/** `read[]` is authoritative and `isPublished` mirrors it — same rule as repositories/projects.js. */
function derivePublished(doc) {
  if (Array.isArray(doc.read) && doc.read.length) return doc.read.includes('public');
  return doc.isPublished === true;
}

/** The listed children of a dotted catalog key, for a parent the caller cannot see whole. */
function visibleChildren(catalog, dials, level, key, value) {
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
    if (visible(level, effectiveVis(catalog[catalogKey], dials[catalogKey]))) out[child] = value[child];
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

  const level = LEVELS.includes(access && access.level) ? access.level : ANONYMOUS_LEVEL;
  const dials = doc.vis && typeof doc.vis === 'object' ? doc.vis : {};

  const out = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key === 'isPublished') continue;

    const entry = catalog[key];
    if (!entry) continue;

    if (visible(level, effectiveVis(entry, dials[key]))) {
      out[key] = value;
      continue;
    }

    const children = visibleChildren(catalog, dials, level, key, value);
    if (children) out[key] = children;
  }

  if (catalog.isPublished && visible(level, effectiveVis(catalog.isPublished, dials.isPublished))) {
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
  const level = LEVELS.includes(access && access.level) ? access.level : ANONYMOUS_LEVEL;
  return Object.keys(changes).filter(key => key === 'vis' || !catalog[key] ||
    !visible(level, effectiveVis(catalog[key], dials[key])));
}

module.exports = { visible, effectiveVis, redactForAccess, redactAllForAccess, refusedWriteKeys };
