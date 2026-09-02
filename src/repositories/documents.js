'use strict';

/**
 * Documents repository — Cosmos NoSQL.
 *
 * Container `documents`, partitioned by `/projectId`. `GET /documents?project=X` is the
 * dominant list, so that becomes a single-partition query. Reads by document id have no
 * project context and are cross-partition, but return one item — a few RU, not a scan.
 */

const cosmos = require('../db/cosmos-nosql');
const { canRead, readForLevel, levelOfRead, SEALED_TOKEN } = require('../helpers/access-sql');
const { eq, inList, isDefinedAndNotNull, selectWhere, selectFor, countWhere, pageOptions, fetchAll } = require('./_sql');

const CONTAINER = 'documents';
const PARTITION_FIELD = 'projectId';

/** Extraction state, which belongs to DEMI and has no upstream counterpart. */
const EXTRACTION_FIELDS = [
  'contentExtracted', 'contentExtractedAt', 'contentPageCount', 'contentExtractionError'
];

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

function buildCriteria({ projectId, extracted, sourceSystem, extractionError }) {
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

  // NOT IS_NULL carries this: a successful extraction writes the field back as an explicit null.
  if (extractionError === true) criteria.push(isDefinedAndNotNull('contentExtractionError'));

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
    // getById keeps the raw point read: canRead needs the whole row, downloadDocument reads
    // `s3Key` off it, and the controllers upsert what they read.
    select: selectFor('documents', access, PARTITION_FIELD),
    orderBy: 'c.id ASC'
  });

  const options = pageOptions({
    ...opts,
    partitionKey: partitionKeyFor(opts.projectId)
  });

  return cosmos.query(CONTAINER, spec, options);
}

/**
 * Sealed documents only — level 0, the compliance compartment.
 *
 * The criterion NARROWS; the visibility predicate is still composed first, so this returns nothing
 * at all to a caller without `compliance`. The token is our own literal, never a caller value, and
 * is written inline for the same reason `readClause` writes it inline.
 *
 * Projected to the four columns `GET /api/sealed` answers with: a list is for finding a sealed
 * record, not for reading one.
 */
async function listSealed(access, opts = {}) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [{ clause: `ARRAY_CONTAINS(c.read, '${SEALED_TOKEN}')`, params: [] }],
    select: 'c.id, c.projectId, c.sealedAt, c.displayName',
    orderBy: 'c.id ASC'
  });

  return cosmos.query(CONTAINER, spec, pageOptions(opts));
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
 *
 * `milestone`, `milestoneId` and `datePosted` are in that set because the chunk card renders a date
 * chip and a milestone chip beside the title and NEITHER value exists on a chunk row — the chunks
 * index carries no document metadata at all, so the parent is the only place they can come from.
 * They are the only columns the card draws beyond name and type; the rest of the document stays
 * unprojected because Cosmos loads the whole item either way, so what a wider projection costs is
 * response bytes and disclosure surface, not item load — the same reasoning `aclRowsForProject`
 * states twenty lines down, and the two must not disagree about the cost model.
 *
 * BOTH the label and the id, which is what prod emits on a chunk row (`milestone: 'Other'` beside
 * `milestoneId: '5d0d212c7d50161b92a80eed'`) and is NOT what the Document dataset emits. There the
 * wire field called `milestone` is the ObjectId, because every component rendering a Document row
 * resolves it through `idToList()`. The chunk card does not — it binds `{{result().milestone}}`
 * raw and has no `lists` input — so the id alone would put a GUID on screen. Carrying both is one
 * column and removes the need for either consumer to special-case the other.
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
    select: 'c.id, c.displayName, c.documentFileName, c.type, c.milestone, c.milestoneId, c.datePosted'
  });

  const { items } = await cosmos.query(CONTAINER, spec, {});
  return items;
}

/**
 * Every document in one project, with the two ACL fields. Single-partition.
 *
 * `c.read` and `c.ownRead` rather than `VALUE c.id`, because the cascade takes the lower of the two
 * levels and cannot do that without the document's own ACL. Cosmos loads the whole item to project
 * any field — no index-only path for this filter — so the extra columns cost response bytes only.
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
 * The LOWER of the two ladder levels, which cannot widen either side by construction. A missing or
 * empty ACL reads as level 1 (`levelOfRead([])`), so an unknown on either side fails closed to
 * `team` rather than to a fixed level 2 a level-1 project never allowed.
 */
function constrainToProject(ownRead, projectRead) {
  return readForLevel(Math.min(levelOfRead(ownRead), levelOfRead(projectRead)));
}

/**
 * Re-derive every document's ACL from its own and its project's.
 *
 * A document must never out-rank its project. `PUT /documents/:id/published` enforces that on the
 * way up — a 409 stops a document publishing under a private project — but nothing enforced it on
 * the way down: unpublishing a project left every document under it carrying `public`, and
 * `listVisible` filters on the document's own ACL, so they stayed listable and searchable.
 *
 * IT NARROWS, IT DOES NOT ASSIGN. Stamping the project's array over each document destroyed any
 * narrower ACL the seed preserved from Eagle (`seed/transform.js` keeps roles like `project-team`
 * verbatim), and once destroyed there was nothing to restore on re-publish. `constrainToProject`
 * takes the lower of the two levels, so no cascade in either direction can raise a document.
 *
 * `ownRead` IS CAPTURED HERE, LAZILY, and that is why no backfill is needed. The first cascade over
 * a document reads the value the seed wrote and stores it alongside; every later cascade re-derives
 * from that snapshot rather than from a value a previous cascade already narrowed. Writing it at
 * seed time instead would mean the same semantics plus a ~60,578-document backfill computing
 * exactly what this derives for free.
 *
 * The one lossy set is documents a PREVIOUS cascade already flattened: their Eagle ACL is gone, so
 * capture records the flattened value and a re-publish leaves them private. Fail-closed, bounded,
 * and enumerable from audit rows (`record.narrow` / `record.takedown` from `setLevel`, project
 * controller) — recovery is a re-seed of that project, which rewrites `read` and drops `ownRead`.
 *
 * A bulk PATCH, not an upsert: an upsert would have to read every document back first. All of a
 * project's documents share one partition, so this is normally a single request.
 *
 * @param {string[]} read  the project's new ACL
 * @returns {Promise<object>} the bulk result, plus the `ids` it touched and each row's
 *                            derived `{id, read, isPublished}`
 */
async function setAclForProject(access, projectId, read) {
  if (!Array.isArray(read) || read.length === 0) {
    throw new TypeError('[documents] setAclForProject requires a non-empty read[] ACL');
  }

  const rows = await aclRowsForProject(access, projectId);
  if (rows.length === 0) {
    return { succeeded: 0, failed: 0, statusCounts: {}, requestCharge: 0, ids: [], rows: [] };
  }

  const pk = String(projectId);
  const updatedAt = new Date().toISOString();
  // Each row's derived ACL, kept so the caller can write the same values into the search index
  // without re-deriving the rule a second way.
  const derived = [];
  const result = await cosmos.bulkVerified(CONTAINER, rows.map(row => {
    // The snapshot if there is one, otherwise what the row carries today — which on a first
    // cascade IS the seeded Eagle ACL, the value the snapshot exists to preserve.
    //
    // `: []` and not `: row.read`, because a row with NO `read` field would put `undefined` in a
    // `set` op, and Cosmos rejects a `set` with no value. Patch ops are atomic per item, so that
    // 400 would take the `/read` narrowing down with it — the row keeps its old ACL and the failure
    // is counted, but the effect is fail-OPEN for exactly the row that had no ACL to begin with.
    // `[]` fails closed to level 1 instead. No current write path produces such a row (all
    // four write an explicit `read[]`, and `seedAcl` fails closed), so this guards a legacy row
    // nobody can rule out from outside the private endpoint.
    const own = Array.isArray(row.ownRead) && row.ownRead.length > 0 ? row.ownRead
      : (Array.isArray(row.read) ? row.read : []);
    const next = constrainToProject(own, read);
    derived.push({ id: String(row.id), read: next, isPublished: next.includes('public') });
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

  return { ...result, ids: derived.map(row => row.id), rows: derived };
}

/**
 * Extraction state of every document in one partition, for the seeder.
 *
 * A Cosmos upsert REPLACES the item, so a re-seed that does not carry these forward marks the
 * whole corpus unextracted while its chunks stay behind. Paged: the largest project holds 2,488
 * documents and a single page caps at 1,000.
 */
async function extractionRowsForProject(access, projectId) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [eq('projectId', String(projectId), '@projectId')],
    select: ['c.id', ...EXTRACTION_FIELDS.map(f => `c.${f}`)].join(', '),
    orderBy: 'c.id ASC'
  });
  return fetchAll(CONTAINER, spec, { partitionKey: String(projectId) });
}

/** The reconcile predicate, shared so the enumeration and its COUNT cannot drift apart. */
const seededCriteria = () => [eq('sourceSystem', 'eagle', '@sourceSystem')];

/**
 * `{id, projectId}` for every Eagle-seeded document in the container — the seeder's reconcile
 * set, ~61k rows. Scoped to `sourceSystem: 'eagle'` so a row this seed never produced (an
 * epic.submit upload) can never be computed as surplus and deleted.
 *
 * NO ORDER BY: a cross-partition sort takes the SDK's query-plan path, whose mergeHeaders never
 * copies `x-ms-continuation`, so fetchAll saw no token and stopped at 1,000 of 60,578 rows.
 */
async function listSeededIds(access) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: seededCriteria(),
    select: 'c.id, c.projectId'
  });
  return fetchAll(CONTAINER, spec);
}

/** COUNT of exactly what listSeededIds reads — the reconcile's proof that it ran to the end. */
async function countSeededIds(access) {
  const spec = countWhere({ access, partitionField: PARTITION_FIELD, criteria: seededCriteria() });
  const value = await cosmos.queryValue(CONTAINER, spec);
  return value || 0;
}

/**
 * Every `projectId` value actually present in this container — the true partition set, one row
 * per partition rather than one per document.
 *
 * `projects.listVisible()` is NOT this list: an Eagle-only project (no Track counterpart, retained
 * and flagged per workspace CLAUDE.md §DFL) has documents but no row in `projects`, so a caller
 * that walked project ids instead would never enumerate — and never scan — that partition. See
 * backfill-display-name-sort.js.
 *
 * NO ORDER BY, same reason listSeededIds has none: DISTINCT VALUE is cross-partition regardless.
 */
async function listDistinctProjectIds(access) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    select: 'DISTINCT VALUE c.projectId'
  });
  return fetchAll(CONTAINER, spec);
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
 * Move a document to a ladder level. This — NOT deletion — is how a document is hidden from the
 * public and from proponents.
 *
 * `read[]` is authoritative and `isPublished` mirrors it: only level 4 carries `public`.
 * Privileged roles retain access at every level.
 */
async function setPublished(id, projectId, level) {
  const read = readForLevel(level);
  return cosmos.patch(CONTAINER, String(id), String(projectId), [
    { op: 'set', path: '/isPublished', value: read.includes('public') },
    { op: 'set', path: '/read', value: read },
    // `ownRead` MOVES WITH IT. This is a deliberate per-document decision about that document, so
    // it becomes the document's own ACL — the thing `setAclForProject` narrows against. Without
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
 * Deliberately does NOT touch the stored blob. Hiding a document is `setPublished(id, pid, 2)`;
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

/**
 * Fields `listByIdsUnscoped` may project. The projection is interpolated into the SQL text, so it
 * is an allowlist rather than a validation: a caller cannot widen the read to `*` and ship `read[]`
 * to a bulk manifest, and cannot smuggle a clause in through the column list.
 */
// `vis` is here for `redactForAccess` on the entry names, never for the caller.
const MANIFEST_FIELDS = [
  'id', 'projectId', 'fileSize', 'isPublished',
  'displayName', 'documentFileName', 's3Key', 'fileExt', 'mimeType', 'vis'
];

/**
 * The documents of a bounded id set with NO project context — cross-partition by necessity, so the
 * CALLER batches (≤200 ids per call).
 *
 * `listByIds` cannot serve this: it also demands the project ids, and a bulk download request
 * carries none. `access` is composed exactly as everywhere else, sealed-compartment exclusion
 * included — never pass a compartment here.
 *
 * @param {string} select comma-separated `c.<field>`, each field one of MANIFEST_FIELDS
 */
async function listByIdsUnscoped(access, ids, select) {
  const unique = Array.from(new Set((ids || []).map(String)));
  if (unique.length === 0) return [];

  const unknown = String(select).split(',')
    .map(field => field.trim().replace(/^c\./, ''))
    .filter(field => !MANIFEST_FIELDS.includes(field));
  if (unknown.length > 0) {
    throw new Error(`[documents] projection not allowed here: ${unknown.join(', ')}`);
  }

  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [inList('id', unique, '@bid')],
    select
  });

  const { items } = await cosmos.query(CONTAINER, spec, {});
  return items;
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  EXTRACTION_FIELDS,
  MANIFEST_FIELDS,
  buildCriteria,
  listVisible,
  listSealed,
  countVisible,
  getById,
  listByIds,
  listByIdsUnscoped,
  aclRowsForProject,
  constrainToProject,
  setAclForProject,
  extractionRowsForProject,
  listSeededIds,
  countSeededIds,
  listDistinctProjectIds,
  upsert,
  bulkUpsertForProject,
  patchExtraction,
  setPublished,
  deleteById
};
