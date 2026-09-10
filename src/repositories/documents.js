'use strict';

/**
 * Documents repository — Cosmos NoSQL.
 *
 * Container `documents`, partitioned by `/projectId`. `GET /documents?project=X` is the
 * dominant list, so that becomes a single-partition query. Reads by document id have no
 * project context and are cross-partition, but return one item — a few RU, not a scan.
 */

const cosmos = require('../db/cosmos-nosql');
const { canRead, readForLevel, levelOfRead, systemAccess, SEALED_TOKEN } = require('../helpers/access-sql');
const { eq, inList, isDefinedAndNotNull, selectWhere, selectFor, countWhere, pageOptions, fetchAll } = require('./_sql');
// The fields the chunks carry a copy of, read from the one list that owns them.
const { CHUNK_PARENT_FIELDS } = require('./chunks');

const CONTAINER = 'documents';
const PARTITION_FIELD = 'projectId';

/** Extraction state, which belongs to DEMI and has no upstream counterpart. */
const EXTRACTION_FIELDS = [
  'contentExtracted', 'contentExtractedAt', 'contentPageCount', 'contentExtractionError'
];

/**
 * The "this document's chunks did not get the new parent fields" flag and when it was raised
 * (`setParentFieldsPending`). Named as a pair because both have to survive a write that rebuilds
 * the row from upstream — a re-seed or an Eagle push — or the flag is dropped and the missed
 * re-stamp goes back to being invisible.
 */
const PARENT_PENDING_FIELDS = ['parentFieldsPending', 'parentFieldsPendingAt'];

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

function buildCriteria({ projectId, extracted, sourceSystem, extractionError, hasProjectId,
  parentFieldsPending }) {
  const criteria = [];
  const projectIds = projectIdList(projectId);
  if (projectIds.length === 1) criteria.push(eq('projectId', projectIds[0], '@projectId'));
  else if (projectIds.length > 1) criteria.push(inList('projectId', projectIds, '@projectId'));
  if (sourceSystem) criteria.push(eq('sourceSystem', sourceSystem, '@sourceSystem'));

  // A JSON null `projectId` and an ABSENT one are two different partitions, and neither is listed
  // by `listDistinctProjectIds`, so a per-partition walk enumerates both together
  // (`parentFieldRowsWithNoProject`) and the two predicates must stay complements. `''` is a real
  // partition and belongs to the `true` side.
  if (hasProjectId === true) criteria.push(isDefinedAndNotNull('projectId'));
  if (hasProjectId === false) {
    const defined = isDefinedAndNotNull('projectId');
    criteria.push({ clause: `NOT ${defined.clause}`, params: defined.params });
  }

  // Set when the re-stamp could not be queued or was skipped, cleared when one lands. An
  // undefined property never equals `true` in Cosmos SQL, so unflagged rows need no IS_DEFINED.
  if (parentFieldsPending === true) criteria.push(eq('parentFieldsPending', true, '@pending'));

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
 * than a cross-partition scan. JSON `null` is the same kind of value: Cosmos serialises it as the
 * partition key `[null]` and addresses it like any other, so a row whose stored `projectId` is null
 * is point-readable. It is NOT the same partition as a row with no `projectId` property at all —
 * that one is `PartitionKey.None`, serialised `[{}]` — and the two must never be conflated.
 *
 * So only `undefined` means "the partition is unknown", and only `undefined` fans out. Two or more
 * projects cannot be pinned to one partition either, so those queries fan out and the `IN` clause is
 * what narrows them.
 */
function partitionKeyFor(projectId) {
  // Before `projectIdList`, which drops null along with undefined — the distinction this makes is
  // the whole point, and `String(null)` would give the partition `'null'`, where nothing lives.
  if (projectId === null) return null;
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
  // PRESENCE, not truthiness, and through the same helper the reads use: `''` is a real partition,
  // and a falsy test sent it down the cross-partition branch below — whose single page can come
  // back empty, which the caller reads as "the document is gone".
  const partitionKey = partitionKeyFor(projectId);
  if (partitionKey !== undefined) {
    const doc = await cosmos.readItem(CONTAINER, String(id), partitionKey);
    if (!doc) return null;
    return canRead(doc, access, PARTITION_FIELD) ? doc : null;
  }

  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [eq('id', String(id), '@id')]
  });
  // Pages are DRAINED, not sampled: one page of a cross-partition lookup comes back empty
  // whenever the partitions it reached first do not hold the id, and reading only that page
  // reports a document that exists as deleted.
  return await cosmos.queryFirst(CONTAINER, spec, {});
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
 *
 * `c.isDeleted` rides along because `ownRead` outlives the record: a document Eagle deleted was
 * published right up to the delete, so its snapshot still says `public`.
 */
async function aclRowsForProject(access, projectId) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [eq('projectId', String(projectId), '@projectId')],
    select: 'c.id, c.read, c.ownRead, c.isDeleted'
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
 * The widest a row Eagle has deleted may be stored at, and the ceiling a cascade may derive it
 * back to — staff, the same level a takedown narrows to. Beside `constrainToProject` because every
 * holder of the flag applies it through that function; `helpers/acl-cascade` and both Eagle
 * mirrors read it from here so the level is stated once.
 */
const DELETED_CEILING = readForLevel(2);

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
    // Both ceilings, lower wins: the project's, and level 2 once Eagle has deleted the record —
    // without the second, the next project publish would republish a document Eagle no longer has.
    const next = row.isDeleted === true
      ? constrainToProject(constrainToProject(own, read), DELETED_CEILING)
      : constrainToProject(own, read);
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
 * Extraction state of every document in one partition, for the seeder, PLUS the four parent fields
 * whose copies live on the chunks and the pending-re-stamp flag.
 *
 * A Cosmos upsert REPLACES the item, so a re-seed that does not carry the extraction state forward
 * marks the whole corpus unextracted while its chunks stay behind. The parent fields ride the same
 * read for the mirror-image reason: the seeder has to know whether a re-seed MOVED one, because
 * nothing else refreshes the copy each chunk carries and a chunk search would keep filtering on the
 * old value. The pending flag rides it so a re-seed can carry a raised flag forward instead of
 * clearing a re-stamp nothing has done yet. Short strings per row against a read the seeder
 * already makes once per project.
 * Paged: the largest project holds 2,488 documents and a single page caps at 1,000.
 */
async function extractionRowsForProject(access, projectId) {
  return projectedRowsForProject(access, projectId,
    [...EXTRACTION_FIELDS, ...CHUNK_PARENT_FIELDS, ...PARENT_PENDING_FIELDS]);
}

/**
 * `c.id`, `c._etag` and the named columns. `_etag` rides along so a caller that decides something
 * from these values can write it back conditionally and lose the race rather than overwrite it.
 */
function projectedSelect(fields) {
  return ['c.id', 'c._etag', ...fields.map(f => `c.${f}`)].join(', ');
}

/** One partition, `c.id` plus the named columns and nothing else. Paged, ordered by id. */
async function projectedRowsForProject(access, projectId, fields) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [eq('projectId', String(projectId), '@projectId')],
    select: projectedSelect(fields),
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
 * Partitions come from the documents themselves, not `projects.listVisible()`, since an
 * Eagle-only project's documents may have no row there. NO ORDER BY: cross-partition DISTINCT rejects it.
 *
 * A row whose `projectId` is JSON null is left out rather than folded into `''`: they are two
 * different partitions, and a walk that reads `''` reports having covered the null rows it never
 * saw. Callers that need the excluded ones counted use `countVisible` with the same flag.
 */
async function listDistinctProjectIds(access) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: buildCriteria({ hasProjectId: true }),
    select: 'DISTINCT VALUE c.projectId'
  });
  return fetchAll(CONTAINER, spec);
}

/**
 * The rows `listDistinctProjectIds` cannot enumerate. Each is individually addressable — null is
 * the partition `[null]`, absent is `PartitionKey.None` — but they are two DIFFERENT partitions and
 * this reads the union, so it is cross-partition or nothing. Left out of a walk their
 * chunks stay unstamped and an unscoped chunk-stamp count never reaches zero, and their
 * `displayNameSort` is never written.
 *
 * NO ORDER BY: a cross-partition sort takes the SDK's query-plan path, which drops the
 * continuation token — the same trap `listSeededIds` documents.
 */
async function projectedRowsWithNoProject(access, fields) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: buildCriteria({ hasProjectId: false }),
    select: projectedSelect(fields)
  });
  return fetchAll(CONTAINER, spec);
}

/**
 * `{id, …CHUNK_PARENT_FIELDS, …PARENT_PENDING_FIELDS}` for every document in one partition. The
 * projection is the point: `listVisible` selects the whole row, and the backfill walks ~61k
 * documents to compare five short strings.
 *
 * The pending pair rides along because the same walk is what clears the flag: which rows carry one
 * (`parentFieldsPending`) and the token a clear is guarded on (`parentFieldsPendingAt`) are not
 * knowable from a second read, since the row can be written again between the two.
 */
async function parentFieldRowsForProject(access, projectId) {
  return projectedRowsForProject(access, projectId,
    [...CHUNK_PARENT_FIELDS, ...PARENT_PENDING_FIELDS]);
}

/** The same columns for the no-project bucket. */
async function parentFieldRowsWithNoProject(access) {
  return projectedRowsWithNoProject(access, [...CHUNK_PARENT_FIELDS, ...PARENT_PENDING_FIELDS]);
}

/** `{id, projectId, displayName, displayNameSort}` for that bucket — the sort-key backfill's walk. */
async function displayNameRowsWithNoProject(access) {
  return projectedRowsWithNoProject(access, ['projectId', 'displayName', 'displayNameSort']);
}

/**
 * Every document flagged `parentFieldsPending`, `{id, projectId}` only. Cross-partition on
 * purpose: which partitions they sit in is what is not known in advance, and the set is small.
 */
async function listParentFieldsPending(access) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: buildCriteria({ parentFieldsPending: true }),
    select: 'c.id, c.projectId'
  });
  return fetchAll(CONTAINER, spec);
}

/** COUNT of exactly what `listParentFieldsPending` reads — the number the drift alert matches on. */
async function countParentFieldsPending(access) {
  const spec = countWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: buildCriteria({ parentFieldsPending: true })
  });
  const value = await cosmos.queryValue(CONTAINER, spec);
  return value || 0;
}

/** Exactly what `Date.prototype.toISOString` emits, and the only shape allowed into a patch
 * condition — the SDK's condition is a raw string with no parameter binding, so the value has to
 * be one this repository minted rather than anything a caller composed. */
const PENDING_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Mint the `parentFieldsPendingAt` token for a raise.
 *
 * The timestamp doubles as the outbox token a later clear is guarded on, so it must never repeat
 * the value already on the row: two raises inside the same millisecond would otherwise let the
 * first one's clear take the second one's flag down, losing the drift. Strictly greater, by a
 * millisecond when the clock cannot supply it.
 *
 * Exported so a writer that sets the flag inline on an upsert — the document controller, the
 * offline seeders — mints the same token as `setParentFieldsPending`.
 *
 * @param {string} [existingPendingAt] the row's current value, if it has one
 * @returns {string} ISO-8601 instant, strictly later than `existingPendingAt`
 */
function freshPendingAt(existingPendingAt) {
  const existing = Date.parse(existingPendingAt);
  const now = Date.now();
  return new Date(Number.isNaN(existing) ? now : Math.max(now, existing + 1)).toISOString();
}

/**
 * The `parentFieldsPending` pair a raise writes, for a writer that sets the flag INLINE on the row
 * it is already upserting — the document controller, the offline seeders — rather than through
 * `setParentFieldsPending`.
 *
 * That path CANNOT carry the patch condition `setParentFieldsPending` raises with, because an upsert
 * replaces the whole item instead of testing one of its values. So a writer using this MUST pass the
 * row's `_etag` to `upsert(row, { etag })` and handle the 412. Without that guard two writers who
 * read the same row mint the same token from the same `existingPendingAt`, and then the first one's
 * clear takes the second one's flag down and the drift it recorded is lost.
 *
 * @param {string} [existingPendingAt] the row's current value, if it has one
 */
function pendingRaiseOps(existingPendingAt) {
  return {
    parentFieldsPending: true,
    parentFieldsPendingAt: freshPendingAt(existingPendingAt)
  };
}

/** The only shape allowed into a patch condition, guard token or minted token alike. */
function assertPendingToken(token) {
  if (!PENDING_AT_PATTERN.test(token)) {
    throw new TypeError(`[documents] parentFieldsPendingAt is not an ISO instant: ${token}`);
  }
  return token;
}

/**
 * The condition that makes a raise a test-and-set: write this token only while the row carries
 * nothing that already beats it.
 *
 * `NOT IS_STRING`, not `NOT IS_DEFINED`: a cleared row carries `parentFieldsPendingAt: null` — the
 * clear writes null rather than removing the path, because Cosmos rejects a `remove` of a path an
 * item does not hold — and in Cosmos SQL `null < "2026-…"` is undefined, not true. An
 * IS_DEFINED-only guard would therefore 412 every raise that follows a clear, which is every raise
 * after the first one.
 */
function raiseCondition(token) {
  return 'FROM c WHERE NOT IS_STRING(c.parentFieldsPendingAt) ' +
    `OR c.parentFieldsPendingAt < ${JSON.stringify(assertPendingToken(token))}`;
}

/**
 * How many times a raise re-reads and re-mints after losing to a concurrent raiser.
 *
 * Each loss means another raiser wrote a token this one does not beat, so the answer is a fresher
 * token off the value that actually landed. Three is a bound, not a tuning knob: a fourth loss means
 * something is raising in a loop, and a throw is a truer answer than a flag whose token nobody owns.
 */
const RAISE_MAX_TRIES = 3;

/**
 * Flag or clear "this document's chunks did not get the new parent fields". Cleared by writing
 * `false`, not by removing the path: Cosmos rejects a `remove` of a path an item does not hold.
 *
 * The partition key is the row's own `projectId`, passed through untouched: `String(null)` is
 * `'null'`, a partition no document lives in, so the flag 404'd on exactly the documents whose
 * drift nothing else would notice. With no project to pin, the row is read cross-partition first.
 *
 * A clear is guarded on the TOKEN, not on the row revision, because the two ask different
 * questions. An etag asks "has anything written this row since I read it", which any unrelated
 * write — an extraction patch, a display-name push — answers yes to, and the clear then 412s
 * forever while the flag stays raised. The token asks the only question that matters: is the flag
 * still the one this run was raised for.
 *
 * A RAISE is conditional too, on the stored token rather than on a caller's. An unconditional raise
 * let two raisers that read the same row mint the same `freshPendingAt` value, and the first one's
 * clear then took the second one's flag down and lost its drift. The condition writes the new token
 * only while nothing that already beats it is stored; a 412 means a concurrent raiser got there, so
 * this re-reads and re-mints off the value that landed.
 *
 * @param {{pendingAt: string}} [guard] a CLEAR only. Absent: unconditional. `{pendingAt}`: token
 *   form, no throw — a mismatch comes back as `conflict`. A raise ignores it: it has a condition of
 *   its own, and no caller is entitled to name the token a raise writes.
 * @returns {Promise<{status: string, pendingAt?: string|null, reason?: string}>}
 *   `raised` with the token now stored; `cleared` with `null`; `conflict` with the token that no
 *   longer matches; `missing` with `reason` `lookup` (no row to patch) or `patch` (404 on write).
 * @throws when a raise loses `RAISE_MAX_TRIES` races — at that point nothing is known about which
 *   token is stored, and returning a token the caller would later clear on would be a lie.
 */
async function setParentFieldsPending(id, projectId, pending, guard) {
  if (guard !== undefined && (typeof guard !== 'object' || guard === null)) {
    throw new TypeError(`[documents] parentFieldsPending guard must be an object: ${guard}`);
  }

  let partitionKey = partitionKeyFor(projectId);
  let row = null;
  if (partitionKey === undefined) {
    row = await getById(systemAccess(), id);
    if (!row) return { status: 'missing', reason: 'lookup' };
    partitionKey = row.projectId;
  }

  return pending === true
    ? raisePending(id, partitionKey, row)
    : clearPending(id, partitionKey, guard);
}

/** Test-and-set the flag, re-minting off the stored token each time a concurrent raiser wins. */
async function raisePending(id, partitionKey, known) {
  // The stored value is what the new token has to beat, so a raise on a pinned partition still
  // costs the point read the lookup above skipped.
  let row = known;

  for (let attempt = 1; attempt <= RAISE_MAX_TRIES; attempt++) {
    if (!row) row = await cosmos.readItem(CONTAINER, String(id), partitionKey);
    const { parentFieldsPending, parentFieldsPendingAt } =
      pendingRaiseOps(row && row.parentFieldsPendingAt);

    try {
      await cosmos.patch(CONTAINER, String(id), partitionKey, [
        { op: 'set', path: '/parentFieldsPending', value: parentFieldsPending },
        { op: 'set', path: '/parentFieldsPendingAt', value: parentFieldsPendingAt }
      ], raiseCondition(parentFieldsPendingAt));
      return { status: 'raised', pendingAt: parentFieldsPendingAt };
    } catch (err) {
      if (err.code === 404) return { status: 'missing', reason: 'patch' };
      if (err.code !== 412) throw err;
      // Somebody else's token is on the row now. Drop the stale copy so the next mint beats THAT.
      row = null;
    }
  }

  throw new Error(
    `[documents] parentFieldsPending raise for ${id} lost ${RAISE_MAX_TRIES} races; ` +
    'the stored token is not this run\'s and clearing on one would take another raise down');
}

/** Write the flag down, optionally only while the row still carries the token it was raised with. */
async function clearPending(id, partitionKey, guard) {
  const token = guard ? guard.pendingAt : undefined;
  const condition = token === undefined
    ? undefined
    : `FROM c WHERE c.parentFieldsPendingAt = ${JSON.stringify(assertPendingToken(token))}`;

  try {
    await cosmos.patch(CONTAINER, String(id), partitionKey, [
      { op: 'set', path: '/parentFieldsPending', value: false },
      { op: 'set', path: '/parentFieldsPendingAt', value: null }
    ], condition);
  } catch (err) {
    if (err.code === 404) return { status: 'missing', reason: 'patch' };
    if (err.code !== 412 || condition === undefined) throw err;
    return { status: 'conflict', pendingAt: token };
  }

  return { status: 'cleared', pendingAt: null };
}

/**
 * Whole-item write.
 *
 * `etag` makes it optimistic: the write lands only while the row is still the revision the caller
 * read, and a loser gets a 412 instead of silently overwriting the winner. That is what a writer
 * setting `parentFieldsPending` inline (`pendingRaiseOps`) needs, since an upsert cannot carry the
 * patch condition `setParentFieldsPending` raises with.
 *
 * @param {object} document
 * @param {{etag?: string}} [options] `etag` is the `_etag` the caller read off the row
 * @throws an error with `code === 412` when the row moved under the caller
 */
async function upsert(document, { etag } = {}) {
  try {
    return await cosmos.upsert(CONTAINER, document, { etag });
  } catch (err) {
    // The SDK reports a failed access condition on `code` or on `statusCode` depending on the path
    // that raised it; a caller retrying a lost write should not have to know which.
    if ((err.code || err.statusCode) !== 412) throw err;
    throw Object.assign(
      new Error(`[documents] upsert of ${document && document.id} lost its etag race`,
        { cause: err }),
      { code: 412 });
  }
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
  PARENT_PENDING_FIELDS,
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
  DELETED_CEILING,
  setAclForProject,
  extractionRowsForProject,
  parentFieldRowsForProject,
  parentFieldRowsWithNoProject,
  displayNameRowsWithNoProject,
  listSeededIds,
  countSeededIds,
  listDistinctProjectIds,
  listParentFieldsPending,
  countParentFieldsPending,
  setParentFieldsPending,
  freshPendingAt,
  pendingRaiseOps,
  RAISE_MAX_TRIES,
  upsert,
  bulkUpsertForProject,
  patchExtraction,
  setPublished,
  deleteById
};
