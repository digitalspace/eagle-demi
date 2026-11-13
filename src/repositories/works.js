'use strict';

// Container `works`, no `read[]`: gated by the parent project's read; only files named in works.test.js require it.
// Writes refused on another owner's document are an authorization check only where the caller fixes the owner.

const cosmos = require('../db/cosmos-nosql');
const { upsertWithEtag, createItem, eq, fetchAll } = require('./_sql');

const CONTAINER = 'works';
const PARTITION_FIELD = 'projectId';
const LABEL = 'works';

const FOREIGN = Object.freeze({ status: 'foreign' });
const WRITTEN = 'written';
const TRACK = 'track';
const TRACK_PREFIX = `${TRACK}-`;
const ADOPT_FIELDS = ['adoptedBy', 'adoptedAt'];
// Private to the loader and the parity checks; a reader of works never needs them.
const PRIVATE_KEYS = new Set(['sourceKey', 'sourceRef', 'provenance']);

const named = (value) => (typeof value === 'string' ? value : null);

/** Who may write the document now: its `owner`, else its `source`, else `track` for a `track-` id; null never matches. */
function ownerOf(doc) {
  if (!doc) return null;
  return named(doc.owner) ?? named(doc.source) ?? (String(doc.id).startsWith(TRACK_PREFIX) ? TRACK : null);
}

const mayWrite = (owner) => typeof owner === 'string' && owner !== '';

/** A create: the id prefix, `source` and `owner` all name the writer. */
const mayCreate = (doc, owner) => mayWrite(owner) && String(doc.id).startsWith(`${owner}-`) &&
  doc.source === owner && doc.owner === owner;

/** An update: `doc` replaces the writer's own `existing`, the revision the etag names. */
const mayUpdate = (doc, existing, etag, owner) => mayWrite(owner) && existing._etag === etag &&
  ownerOf(existing) === owner && doc.id === existing.id && String(doc.projectId) === String(existing.projectId);

/** `provenance` with its adopt fields as `existing` holds them, so no rebuild can adopt or release a document. */
function withAdoptOf(provenance, existing) {
  const held = (existing && existing.provenance) || {};
  if (provenance === undefined && !ADOPT_FIELDS.some(key => key in held)) return undefined;
  const next = { ...(provenance || {}) };
  for (const key of ADOPT_FIELDS) {
    if (key in held) next[key] = held[key];
    else delete next[key];
  }
  return next;
}

/** `doc` with `source`, `owner` and the adopt fields of `provenance` taken from `existing`. */
function keptFrom(doc, existing, owner) {
  const next = { ...doc, source: existing.source ?? owner, owner: existing.owner ?? owner };
  const provenance = withAdoptOf(doc.provenance, existing);
  if (provenance === undefined) delete next.provenance;
  else next.provenance = provenance;
  return next;
}

// `IS_BOOL` first: a document with no `deleted` flag is live.
const LIVE = 'NOT (IS_BOOL(c.deleted) AND c.deleted = true)';

/** The SQL twin of `ownerOf(c) = owner`. */
function ownerClause(owner) {
  const byId = owner === TRACK ? ' OR (NOT IS_STRING(c.source) AND STARTSWITH(c.id, @trackPrefix))' : '';
  return {
    clause: `(c.owner = @owner OR (NOT IS_STRING(c.owner) AND (c.source = @owner${byId})))`,
    params: [{ name: '@owner', value: owner }, ...(byId ? [{ name: '@trackPrefix', value: TRACK_PREFIX }] : [])]
  };
}

/**
 * Every work of one project, one single-partition query, override marker (any `kind`) left out.
 * A tombstone is left out unless asked for; `owner` keeps only that owner's documents.
 */
async function listByProject(projectId, { includeDeleted = false, owner } = {}) {
  const partition = eq(PARTITION_FIELD, String(projectId), '@projectId');
  const terms = [partition.clause, 'NOT IS_DEFINED(c.kind)'];
  const parameters = [...partition.params];
  if (!includeDeleted) terms.push(LIVE);
  if (owner !== undefined) {
    if (!mayWrite(owner)) throw new TypeError(`[works] owner filter must be a name, got ${owner}`);
    const byOwner = ownerClause(owner);
    terms.push(byOwner.clause);
    parameters.push(...byOwner.params);
  }
  // Not selectWhere(systemAccess()): its seal term is undefined on a row with no read[], so Cosmos would drop every work.
  return fetchAll(CONTAINER, { query: `SELECT * FROM c WHERE ${terms.join(' AND ')}`, parameters },
    { partitionKey: String(projectId) });
}

/** The `projectId` of each live work in every project, one per work; `owner` keeps only that owner's. */
async function liveProjectIds({ owner } = {}) {
  const terms = [LIVE, 'NOT IS_DEFINED(c.kind)'];
  if (owner !== undefined && !mayWrite(owner)) throw new TypeError(`[works] owner filter must be a name, got ${owner}`);
  const byOwner = owner === undefined ? { params: [] } : ownerClause(owner);
  if (byOwner.clause) terms.push(byOwner.clause);
  return fetchAll(CONTAINER, { query: `SELECT VALUE c.projectId FROM c WHERE ${terms.join(' AND ')}`, parameters: byOwner.params });
}

function withoutPrivate(value) {
  if (Array.isArray(value)) return value.map(withoutPrivate);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_KEYS.has(key))
    .map(([key, inner]) => [key, withoutPrivate(inner)]));
}

/** The live works of one project for a reader: no `sourceKey`, `provenance` or `sourceRef` at any depth. */
async function listForRead(projectId) {
  return (await listByProject(projectId)).map(withoutPrivate);
}

/** Point read, tombstone and marker included, with its `_etag`; null when absent. */
async function get(projectId, workId) {
  return cosmos.readItem(CONTAINER, String(workId), String(projectId));
}

/** The one document of the project holding `sourceKey`, tombstone included; null when none. */
async function findBySourceKey(projectId, sourceKey) {
  if (sourceKey === undefined || sourceKey === null || sourceKey === '') {
    throw new TypeError(`[works] findBySourceKey needs a sourceKey, got ${JSON.stringify(sourceKey)}`);
  }
  const partition = eq(PARTITION_FIELD, String(projectId), '@projectId');
  const key = eq('sourceKey', String(sourceKey), '@sourceKey');
  const rows = await fetchAll(CONTAINER, {
    query: `SELECT * FROM c WHERE ${partition.clause} AND ${key.clause}`,
    parameters: [...partition.params, ...key.params]
  }, { partitionKey: String(projectId) });
  if (rows.length > 1) {
    throw Object.assign(new Error(`[works] ${rows.length} documents in ${projectId} hold one sourceKey`),
      { code: 'DUPLICATE_SOURCE_KEY' });
  }
  return rows[0] || null;
}

/**
 * Write for `owner` guarded on `etag` of `existing` (412), or a create (409); run inside `writeGuarded`.
 * `{ status: 'foreign' }`, never thrown, when the document is not `owner`'s; else `{ status: 'written' }`.
 */
async function save(doc, { owner, etag, existing } = {}) {
  if (!etag) {
    if (!mayCreate(doc, owner)) return FOREIGN;
    await createItem(CONTAINER, doc, LABEL);
    return { status: WRITTEN };
  }
  if (!existing) throw new TypeError(`[works] save of ${doc.id} with an etag needs the existing document`);
  if (!mayUpdate(doc, existing, etag, owner)) return FOREIGN;
  await upsertWithEtag(CONTAINER, keptFrom(doc, existing, owner), { etag, label: LABEL });
  return { status: WRITTEN };
}

/** Replaces a deleted work with its stamps and who wrote it, so an older PUT for it is still seen as stale. */
async function tombstone(current, { owner, etag } = {}) {
  const { id, projectId, pushStamps, source, sourceKey, provenance } = current;
  const doc = { id, projectId, deleted: true, pushStamps, source, owner: current.owner, sourceKey, provenance };
  for (const key of Object.keys(doc)) if (doc[key] === undefined) delete doc[key];
  return save(doc, { owner, etag, existing: current });
}

/** Hard delete, only to undo a create; refused on a foreign document, Cosmos' 412 on a stale `etag`. */
async function remove({ projectId, id }, { owner, etag } = {}) {
  const current = await get(projectId, id);
  if (!current) return { status: 'gone' };
  if (!etag || !mayWrite(owner) || ownerOf(current) !== owner) return FOREIGN;
  return { status: (await cosmos.remove(CONTAINER, String(id), String(projectId), { etag })) ? 'removed' : 'gone' };
}

module.exports = {
  CONTAINER, PARTITION_FIELD, PRIVATE_KEYS, ownerOf, listByProject, listForRead, liveProjectIds, get, findBySourceKey,
  save, tombstone, remove
};
