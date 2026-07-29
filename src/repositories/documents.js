'use strict';

/**
 * Documents repository — Cosmos NoSQL.
 *
 * Container `documents`, partitioned by `/projectId`. `GET /documents?project=X` is the
 * dominant list, so that becomes a single-partition query. Reads by document id have no
 * project context and are cross-partition, but return one item — a few RU, not a scan.
 */

const cosmos = require('../db/cosmos-nosql');
const { canRead } = require('../helpers/access-sql');
const { eq, selectWhere, countWhere, pageOptions } = require('./_sql');

const CONTAINER = 'documents';
const PARTITION_FIELD = 'projectId';

function buildCriteria({ projectId, extracted, sourceSystem }) {
  const criteria = [];
  if (projectId) criteria.push(eq('projectId', String(projectId), '@projectId'));
  if (sourceSystem) criteria.push(eq('sourceSystem', sourceSystem, '@sourceSystem'));

  // Defaults are written on every document, so this is a plain equality. The Mongo original
  // was `contentExtracted: {$ne: true}`, which in SQL would EXCLUDE rows missing the field —
  // the single most dangerous translation in the migration, silently skipping every document.
  if (extracted === true) criteria.push(eq('contentExtracted', true, '@extracted'));
  if (extracted === false) criteria.push(eq('contentExtracted', false, '@extracted'));

  return criteria;
}

/**
 * List documents visible to this caller.
 * When a project is supplied the query is scoped to that partition — the fast path.
 */
async function listVisible(access, opts = {}) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: buildCriteria(opts)
  });

  const options = pageOptions({
    ...opts,
    partitionKey: opts.projectId ? String(opts.projectId) : undefined
  });

  return cosmos.query(CONTAINER, spec, options);
}

async function countVisible(access, opts = {}) {
  const spec = countWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: buildCriteria(opts)
  });
  const value = await cosmos.queryValue(CONTAINER, spec);
  return value || 0;
}

/**
 * Fetch by document id.
 *
 * The visibility predicate is applied IN the query rather than fetched-then-filtered, so a
 * document the caller may not see is never returned to this process. When the project is
 * known, pass it to turn this into a single-partition read.
 */
async function getById(access, id, projectId) {
  if (projectId) {
    const doc = await cosmos.readItem(CONTAINER, String(id), String(projectId));
    if (!doc) return null;
    return canRead(doc, access, PARTITION_FIELD) ? doc : null;
  }

  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [eq('id', String(id), '@id')]
  });
  const { items } = await cosmos.query(CONTAINER, spec, { maxItemCount: 1 });
  return items[0] || null;
}

async function upsert(document) {
  return cosmos.upsert(CONTAINER, document);
}

/**
 * Record the outcome of an extraction run. Partial update: it must not disturb the ACL,
 * publication state or anything the seeders wrote.
 */
async function patchExtraction(id, projectId, fields) {
  const ops = Object.entries(fields).map(([key, value]) => ({
    op: 'set',
    path: `/${key}`,
    value
  }));
  return cosmos.patch(CONTAINER, String(id), String(projectId), ops);
}

/**
 * Set publication state. This — NOT deletion — is how a document is hidden from the public
 * and from proponents.
 *
 * `read[]` is authoritative, so publishing/unpublishing means adding or removing 'public'
 * from it; `isPublished` is kept as the mirror. Privileged roles retain access either way.
 *
 * @param {string[]} secureRoles  roles that keep access when unpublished
 */
async function setPublished(id, projectId, published, secureRoles) {
  const read = published ? ['public', ...secureRoles] : [...secureRoles];
  return cosmos.patch(CONTAINER, String(id), String(projectId), [
    { op: 'set', path: '/isPublished', value: Boolean(published) },
    { op: 'set', path: '/read', value: read },
    { op: 'set', path: '/updatedAt', value: new Date().toISOString() }
  ]);
}

/**
 * Permanently remove the document record.
 *
 * Deliberately does NOT touch the stored blob. Hiding a document is `setPublished(false)`;
 * this is for genuine removal of the record, and no request path is allowed to destroy a
 * source file. Orphaned blobs are reclaimed by a separate audited job.
 *
 * The caller is responsible for removing the search-index entry — see
 * controllers/nosql/document.js. That is done explicitly rather than via the change feed,
 * which emits no deletes in latest-version mode.
 */
async function deleteById(id, projectId) {
  return cosmos.remove(CONTAINER, String(id), String(projectId));
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  buildCriteria,
  listVisible,
  countVisible,
  getById,
  upsert,
  patchExtraction,
  setPublished,
  deleteById
};
