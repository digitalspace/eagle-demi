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
const { eq, inList, selectWhere, countWhere, pageOptions } = require('./_sql');

const CONTAINER = 'documents';
const PARTITION_FIELD = 'projectId';

function buildCriteria({ projectId, extracted, sourceSystem }) {
  const criteria = [];
  // Presence, not truthiness — the same shape fixed in records.js. `''` is a REAL partition, and a
  // falsy test silently turns "the unlinked partition" into "every document in the container".
  // Nothing passes `''` today; aligning now is what keeps that true when something does.
  if (projectId !== undefined && projectId !== null) {
    criteria.push(eq('projectId', String(projectId), '@projectId'));
  }
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
    // Same presence test as buildCriteria. Naming `''` as the partition key is what makes a read of
    // the unlinked partition a single-partition query rather than a cross-partition scan.
    partitionKey: opts.projectId !== undefined && opts.projectId !== null
      ? String(opts.projectId)
      : undefined
  });

  return cosmos.query(CONTAINER, spec, options);
}

async function countVisible(access, opts = {}) {
  const spec = countWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: buildCriteria(opts)
  });
  // The partitionKey ONLY — not the caller's pageSize or continuation token, which mean nothing
  // for a single-row aggregate. Without this a count carrying a projectId still fanned out across
  // every partition while the matching read did not.
  const value = await cosmos.queryValue(CONTAINER, spec, pageOptions({
    partitionKey: opts.projectId !== undefined && opts.projectId !== null
      ? String(opts.projectId)
      : undefined
  }));
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

/**
 * Display metadata for a bounded set of documents, in one query.
 *
 * Chunk search returns rows that carry only ids, so the result set has to be labelled with the
 * parent document's name and type. Passing the project ids as well keeps this targeted at the
 * partitions the hits actually came from instead of fanning out across all 357.
 *
 * Projects only the display fields — a caller that may read a chunk still has no business
 * receiving the whole parent document.
 */
async function listByIds(access, ids, projectIds) {
  const unique = Array.from(new Set((ids || []).map(String)));
  const projects = Array.from(new Set((projectIds || []).map(String)));
  if (unique.length === 0) return [];

  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [
      inList('id', unique, '@did'),
      inList(PARTITION_FIELD, projects, '@dpid')
    ],
    select: 'c.id, c.displayName, c.documentFileName, c.type'
  });

  const { items } = await cosmos.query(CONTAINER, spec, {});
  return items;
}

/** Ids of every document in one project. Single-partition. */
async function idsForProject(access, projectId) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [eq('projectId', String(projectId), '@projectId')],
    select: 'VALUE c.id'
  });
  const { items } = await cosmos.query(CONTAINER, spec, { partitionKey: String(projectId) });
  return items;
}

/**
 * Rewrite the ACL on every document of one project.
 *
 * A document must never out-rank its project. `PUT /documents/:id/published` enforces that on the
 * way up — a 409 stops a document publishing under a private project — but nothing enforced it on
 * the way down: unpublishing a project left every document under it carrying `public`, and
 * `listVisible` filters on the document's own ACL, so they stayed listable and searchable.
 *
 * A bulk PATCH, not an upsert: an upsert would have to read every document back first. All of a
 * project's documents share one partition, so this is normally a single request.
 *
 * @param {string[]} read  the project's new ACL
 * @returns {Promise<object>} the bulk result, plus the `ids` it touched
 */
async function setAclForProject(access, projectId, read) {
  if (!Array.isArray(read) || read.length === 0) {
    throw new TypeError('[documents] setAclForProject requires a non-empty read[] ACL');
  }

  const ids = await idsForProject(access, projectId);
  if (ids.length === 0) {
    return { succeeded: 0, failed: 0, statusCounts: {}, requestCharge: 0, ids: [] };
  }

  const pk = String(projectId);
  const updatedAt = new Date().toISOString();
  const result = await cosmos.bulkVerified(CONTAINER, ids.map(id => ({
    operationType: 'Patch',
    partitionKey: pk,
    id: String(id),
    resourceBody: {
      operations: [
        { op: 'set', path: '/read', value: read },
        { op: 'set', path: '/isPublished', value: read.includes('public') },
        { op: 'set', path: '/updatedAt', value: updatedAt }
      ]
    }
  })));

  return { ...result, ids };
}

async function upsert(document) {
  return cosmos.upsert(CONTAINER, document);
}

/**
 * Record the outcome of an extraction run. Partial update: it must not disturb the ACL,
 * publication state or anything the seeders wrote.
 */
/**
 * Bulk write for the seeder. All documents must belong to the SAME project, since that is the
 * partition key — the seeder groups by project before calling this.
 */
async function bulkUpsertForProject(projectId, docs) {
  const operations = docs.map(resourceBody => ({
    operationType: 'Upsert',
    partitionKey: String(projectId),
    resourceBody
  }));
  return cosmos.bulkVerified(CONTAINER, operations);
}

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
  listByIds,
  idsForProject,
  setAclForProject,
  upsert,
  bulkUpsertForProject,
  patchExtraction,
  setPublished,
  deleteById
};
