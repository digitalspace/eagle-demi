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

/**
 * The projects a caller asked for, as a list, from either wire shape.
 *
 * Presence, not truthiness — `''` is a REAL partition, and a falsy test silently turns "the
 * unlinked partition" into "every document in the container".
 *
 * A LIST as well as a single value because `GET /search?dataset=Document&project=a,b` is one
 * request naming two projects, and the search controller has to be able to hand both here. Keeping
 * one option name rather than adding a second is deliberate: `projectId` and a parallel
 * `projectIds` would be two ways to say the same thing, and the count and the read would eventually
 * be built from different ones — which leaks the size of a set the caller cannot see.
 */
function projectIdList(projectId) {
  if (projectId === undefined || projectId === null) return [];
  return (Array.isArray(projectId) ? projectId : [projectId]).map(String);
}

function buildCriteria({ projectId, extracted, sourceSystem }) {
  const criteria = [];
  const projectIds = projectIdList(projectId);
  if (projectIds.length === 1) criteria.push(eq('projectId', projectIds[0], '@projectId'));
  else if (projectIds.length > 1) criteria.push(inList('projectId', projectIds, '@projectId'));
  if (sourceSystem) criteria.push(eq('sourceSystem', sourceSystem, '@sourceSystem'));

  // Defaults are written on every document, so this is a plain equality. The Mongo original
  // was `contentExtracted: {$ne: true}`, which in SQL would EXCLUDE rows missing the field —
  // the single most dangerous translation in the migration, silently skipping every document.
  if (extracted === true) criteria.push(eq('contentExtracted', true, '@extracted'));
  if (extracted === false) criteria.push(eq('contentExtracted', false, '@extracted'));

  return criteria;
}

/**
 * The partition to pin this query to, when there is exactly one.
 *
 * Naming `''` here is what makes a read of the unlinked partition a single-partition query rather
 * than a cross-partition scan. Two or more projects cannot be pinned to one partition, so those
 * queries fan out and the `IN` clause is what narrows them.
 */
function partitionKeyFor(projectId) {
  const ids = projectIdList(projectId);
  return ids.length === 1 ? ids[0] : undefined;
}

/**
 * List documents visible to this caller.
 * When a project is supplied the query is scoped to that partition — the fast path.
 *
 * ORDER BY c.id ASC is not cosmetic: WITHOUT it the SQL API gives no order guarantee at all, and
 * the search controller pages this list by re-running it and slicing, so two requests could return
 * the same row twice and never return another — the same failure `DEFAULT_ORDER` in
 * `search/eagle-query.js` exists to prevent on the AI Search side. `id` rather than a display field
 * because it is the one path that is always present and always indexed (Cosmos REJECTS `/id/?` in
 * an indexing policy precisely because it is never optional), and a single-property ORDER BY drops
 * every row that lacks the property — sorting on `displayName` would silently hide untitled
 * documents instead of ordering them.
 */
async function listVisible(access, opts = {}) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: buildCriteria(opts),
    orderBy: 'c.id ASC'
  });

  const options = pageOptions({
    ...opts,
    partitionKey: partitionKeyFor(opts.projectId)
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
    partitionKey: partitionKeyFor(opts.projectId)
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

/**
 * Every document in one project, with the two ACL fields. Single-partition.
 *
 * `c.read` and `c.ownRead` rather than `VALUE c.id`, because the cascade INTERSECTS and cannot do
 * that without the document's own ACL. Cosmos loads the whole item to project any field — there is
 * no index-only path for this filter — so the extra columns change response bytes, not item load.
 */
async function aclRowsForProject(access, projectId) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [eq('projectId', String(projectId), '@projectId')],
    select: 'c.id, c.read, c.ownRead'
  });
  const { items } = await cosmos.query(CONTAINER, spec, { partitionKey: String(projectId) });
  return items;
}

/**
 * The document's ACL narrowed by its project's — never widened by it.
 *
 * The rule is `eagle-search/worker/transform.js`'s `constrainToProject`, which is the intersecting
 * version of what this file used to do by assignment. Three fail-closed branches: no project ACL,
 * an empty one, or an empty intersection all collapse to `['sysadmin']` rather than to the wider
 * of the two.
 */
function constrainToProject(ownRead, projectRead) {
  if (!Array.isArray(projectRead) || projectRead.length === 0) return ['sysadmin'];
  if (!Array.isArray(ownRead) || ownRead.length === 0) return ['sysadmin'];
  const allowed = new Set(projectRead);
  const kept = ownRead.filter(role => allowed.has(role));
  return kept.length > 0 ? kept : ['sysadmin'];
}

/**
 * Re-derive every document's ACL from its own and its project's.
 *
 * A document must never out-rank its project. `PUT /documents/:id/published` enforces that on the
 * way up — a 409 stops a document publishing under a private project — but nothing enforced it on
 * the way down: unpublishing a project left every document under it carrying `public`, and
 * `listVisible` filters on the document's own ACL, so they stayed listable and searchable.
 *
 * IT INTERSECTS, IT DOES NOT ASSIGN. Stamping the project's array over each document destroyed any
 * narrower ACL the seed preserved from Eagle (`seed/transform.js` keeps roles like `project-team`
 * verbatim), and once destroyed there was nothing to restore on re-publish and nothing to intersect
 * against next time. That could not WIDEN anything while the only caller passed `[...SECURE_ROLES]`
 * — every role in that set short-circuits `readClause` to `true`, so the added ones granted nobody
 * anything — but it widens the moment a re-publish cascade passes an ACL containing `public`, which
 * is exactly what this change adds. The two fixes are one fix.
 *
 * `ownRead` IS CAPTURED HERE, LAZILY, and that is why no backfill is needed. The first cascade over
 * a document reads the value the seed wrote and stores it alongside; every later cascade re-derives
 * from that snapshot rather than from a value a previous cascade already narrowed. Writing it at
 * seed time instead would mean the same semantics plus a ~60,578-document backfill computing
 * exactly what this derives for free.
 *
 * The one lossy set is documents a PREVIOUS cascade already flattened: their Eagle ACL is gone, so
 * capture records the flattened value and a re-publish leaves them private. Fail-closed, bounded,
 * and enumerable from audit rows (`project.update` with `isPublishedTo: false`) — recovery is a
 * re-seed of that project, which rewrites `read` and drops `ownRead`.
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

  const rows = await aclRowsForProject(access, projectId);
  if (rows.length === 0) {
    return { succeeded: 0, failed: 0, statusCounts: {}, requestCharge: 0, ids: [] };
  }

  const pk = String(projectId);
  const updatedAt = new Date().toISOString();
  const result = await cosmos.bulkVerified(CONTAINER, rows.map(row => {
    // The snapshot if there is one, otherwise what the row carries today — which on a first
    // cascade IS the seeded Eagle ACL, the value the snapshot exists to preserve.
    //
    // `: []` and not `: row.read`, because a row with NO `read` field would put `undefined` in a
    // `set` op, and Cosmos rejects a `set` with no value. Patch ops are atomic per item, so that
    // 400 would take the `/read` narrowing down with it — the row keeps its old ACL and the failure
    // is counted, but the effect is fail-OPEN for exactly the row that had no ACL to begin with.
    // `[]` intersects to `['sysadmin']` instead. No current write path produces such a row (all
    // four write an explicit `read[]`, and `seedAcl` fails closed), so this guards a legacy row
    // nobody can rule out from outside the private endpoint.
    const own = Array.isArray(row.ownRead) && row.ownRead.length > 0 ? row.ownRead
      : (Array.isArray(row.read) ? row.read : []);
    const next = constrainToProject(own, read);
    return {
      operationType: 'Patch',
      partitionKey: pk,
      id: String(row.id),
      resourceBody: {
        operations: [
          { op: 'set', path: '/ownRead', value: own },
          { op: 'set', path: '/read', value: next },
          { op: 'set', path: '/isPublished', value: next.includes('public') },
          { op: 'set', path: '/updatedAt', value: updatedAt }
        ]
      }
    };
  }));

  return { ...result, ids: rows.map(row => String(row.id)) };
}

async function upsert(document) {
  return cosmos.upsert(CONTAINER, document);
}

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
    // `ownRead` MOVES WITH IT. This is a deliberate per-document decision about that document, so
    // it becomes the document's own ACL — the thing `setAclForProject` intersects against. Without
    // this line the snapshot still holds whatever the row carried before, and the next time the
    // project is re-published the cascade re-derives from that stale value and RESURRECTS a
    // document an operator had individually unpublished.
    { op: 'set', path: '/ownRead', value: read },
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
  aclRowsForProject,
  constrainToProject,
  setAclForProject,
  upsert,
  bulkUpsertForProject,
  patchExtraction,
  setPublished,
  deleteById
};
