'use strict';

/**
 * Translate eagle-public's query string into an Azure AI Search request.
 *
 * The contract belongs to eagle-api, not to us: eagle-public speaks it already and is not changing.
 * `api.ts:160-206` builds every search URL there, and it emits `and[key]=value` repeats, `sortBy`
 * TWICE (often one of them empty), a 0-BASED `pageNum`, and a flat `project=<id>` on the project
 * tabs. Everything in this file exists because of one of those.
 *
 * FIELD METADATA COMES FROM THE COMMITTED INDEX DEFINITIONS, not from a table here. `filterable`,
 * `sortable` and the Edm type are read out of `azure/search/indexes/*.json` at load, so a schema
 * change cannot leave a hand-written copy behind — the same rule `ai-search.js` states about
 * `select`: a name that is not in the index is a 400 on EVERY query, not a missing field.
 *
 * WHAT DEMI'S INDEXES CANNOT EXPRESS, and therefore what this drops:
 *   - `milestone`, `projectPhase`, `documentAuthorType`, `documentSource`, `isFeatured` — no such
 *     field in `documents`. eagle-public's /search filter panel sends all of them.
 *   - any date range (`datePostedStart`, `decisionDateEnd`): there is no `Edm.DateTimeOffset` field
 *     in ANY demi index, so a range term has nothing to compare against. `datePosted` IS stored in
 *     Cosmos — it is the index that has no home for it (`datasources/demi-documents-ds.json`).
 *   - `type` on a Project. eagle stores an EAO project type; DEMI stores a Track `sector`. The
 *     vocabularies are not known to line up, and a wrong mapping filters silently to nothing.
 *   - `centroid`. It is `filterable: true` like every geography field, but `eq` is not an operator
 *     OData defines on one — a spatial filter is `geo.distance(...)`, which nothing on the wire
 *     asks for. See TERM_TYPES: the gate is the field's TYPE, never its `filterable` flag.
 * All of those are DROPPED and logged, never passed through: an unknown field name is an OData 400,
 * and eagle-public swallows a failed search into an empty table (`search.service.ts:64-69`), which
 * is indistinguishable from "no results" for whoever is looking at the screen. Fixing any of them
 * is an index change plus a reindex, not a change here.
 */

const fs = require('fs');
const path = require('path');
const { logger } = require('../utils/logger');

const INDEX_DIR = path.join(__dirname, '..', '..', 'azure', 'search', 'indexes');

/**
 * Dataset → which `azure/search/indexes/*.json` holds its field metadata.
 *
 * THESE ARE SCHEMA NAMES, NOT WIRE NAMES. They match the `name` INSIDE the committed definitions
 * and have nothing to do with `SEARCH_INDEX*`, which name the live indexes `ai-search.js` actually
 * queries. The two are decoupled on purpose: it is what lets the physical indexes be renamed one
 * app setting at a time while the field metadata keeps resolving. Coupling them would mean a
 * half-done cutover silently loses every filter and sort — `fieldsFor` falls back to an empty Map,
 * so an unmatched name here answers 200 with no filters applied rather than failing.
 */
const DATASET_INDEX = {
  Project: 'projects',
  Document: 'documents',
  DocumentChunk: 'chunks'
};

/**
 * Wire key → index field, per dataset.
 *
 * `_id` is the interesting one. eagle-public holds Eagle ObjectIds, and this API answers with them
 * (see the response mappers in `controllers/search.js`), so a filter on `_id` has to land on the
 * field that HOLDS the Eagle id — `legacyEagleId` for a project, and the row key itself for a
 * document or chunk, which are already seeded in Eagle id-space (`seed/transform.js:84-87`).
 *
 * `project` is NOT here for the same reason: the value needs translating from an Eagle ObjectId to
 * a DEMI project id before it can be compared, which is a read, not a rename. See
 * `projectIdsFrom`/`withProjectIds` below and their caller.
 */
const ALIASES = {
  Project: {
    _id: 'legacyEagleId',
    // sortBy forms eagle-public sends for nested columns (project-list.constants.ts:7-38)
    'project.name': 'name',
    'proponent.name': 'proponent'
  },
  Document: {
    _id: 'id',
    project: 'projectId'
  },
  DocumentChunk: {
    _id: 'chunkId',
    project: 'projectId',
    document: 'documentId'
  }
};

/**
 * Order applied when the caller asks for none AND there are no keywords.
 *
 * `search: '*'` has NO stable order in AI Search, so without this, page 2 can repeat and omit rows
 * from page 1 — which reads to a user as data loss, not as a sorting quirk. It must NOT apply to a
 * keyword search: an alphabetical default there sorts the relevance ranking away.
 *
 * No entry for DocumentChunk: EVERY field in `chunks` is `sortable: false`, the key included,
 * so `$orderby` on that index cannot name anything at all. Chunks page in relevance order and a
 * deep chunk page is therefore not stable — the honest statement of what the index supports.
 */
const DEFAULT_ORDER = {
  Project: 'name asc',
  Document: 'displayName asc'
};

/**
 * Query parameters this endpoint understands. Anything else is a 400 rather than a silent no-op.
 *
 * A dropped PARAMETER is the dangerous class: `page=2` instead of `pageNum=1` serves page 1 with a
 * 200, and a filter the server never read returns the whole corpus looking exactly like a match.
 * A dropped FILTER KEY is different — it is named in the response log and the index genuinely
 * cannot express it — which is why that one is dropped and this one is refused.
 */
const KNOWN_PARAMS = new Set([
  // this API's own
  'dataset', 'keywords', 'q', 'fuzzy', 'pageSize', 'includeSeeded',
  // eagle-public's (api.ts:160-206). The last four are read by nobody here and say so at §3.4 of
  // the contract: `fields` is literally `[object Object]` on six call sites.
  'pageNum', 'sortBy', 'project', 'categorized', 'projectLegislation', 'populate', 'fields'
]);

/** Loaded once. A schema change needs a redeploy anyway — the definitions ship in the package. */
const FIELDS = loadFields();

function loadFields() {
  const byIndex = {};
  let files;
  try {
    files = fs.readdirSync(INDEX_DIR);
  } catch (err) {
    // THROWING IS THE CORRECT BEHAVIOUR — the map built below is the type gate, and an empty map
    // would let a `filterable` geography field through to an OData `eq` that AI Search 400s on.
    // What was wrong was the WORDING. This runs at require time and the boot chain reaches it
    // (index.js -> api/index.js -> src/routes/api.js -> src/controllers/search.js -> here), so
    // when `scripts/package-api.py` shipped a package without `azure/search/indexes` the whole
    // API died, and the entire diagnosis on offer was `ENOENT: ... scandir
    // '/home/site/wwwroot/azure/search/indexes'` — a path, with no hint that it is a packaging
    // fault rather than a missing mount, a bad deploy root, or a broken container image.
    throw new Error(
      `search index definitions not found at ${INDEX_DIR} — this deploy package is incomplete; ` +
      'scripts/package-api.py must re-include azure/search/indexes (it excludes azure/ wholesale)',
      { cause: err });
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const def = JSON.parse(fs.readFileSync(path.join(INDEX_DIR, file), 'utf8'));
    const map = new Map();
    for (const f of def.fields) {
      map.set(f.name, {
        type: f.type,
        filterable: f.filterable === true,
        sortable: f.sortable === true,
        collection: f.type.startsWith('Collection(')
      });
    }
    byIndex[def.name] = map;
  }
  return byIndex;
}

function fieldsFor(dataset) {
  return FIELDS[DATASET_INDEX[dataset]] || new Map();
}

/**
 * Yield `[key, value]` for every `and[...]` parameter, whichever shape the query parser produced.
 *
 * BOTH SHAPES, on purpose. Express 5 defaults to the `simple` query parser, which reads
 * `and[type]=x` as the LITERAL key `'and[type]'`; the `extended`/`qs` parser reads the same URL as
 * a NESTED OBJECT, `req.query.and = { type: 'x' }`. eagle-search recorded what handling only one
 * shape costs (`service/query.js:114-126`): every filter silently dropped and 60,560 documents
 * returned where a filtered handful was expected — not an error anyone sees, a page of results that
 * looks fine and is wrong. Reading both removes the dependency on a setting entirely.
 */
function* andParams(query) {
  for (const [rawKey, rawValue] of Object.entries(query)) {
    if (rawKey === 'and' && rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
      for (const [k, v] of Object.entries(rawValue)) yield [k, v];
      continue;
    }
    const m = /^and\[(.+)\]$/.exec(rawKey);
    if (m) yield [m[1], rawValue];
  }
}

/** OData string literals are single-quoted and escape a quote by DOUBLING it. */
function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * The Edm types `term()` has a case for — and therefore the ONLY types this endpoint can filter on.
 *
 * THIS IS THE GATE FOR A FILTER KEY, not `filterable`. `projects.centroid` is an
 * `Edm.GeographyPoint` and is `filterable: true` — geography fields are filterable, just not with
 * `eq` — so a `filterable` gate let it through to the quoted-string default and emitted
 * `centroid eq 'x'`. That is not an operator OData defines on a geography field, so the service
 * answers 400; 400 is deliberately not in RETRY_STATUSES, `request()` throws, and the controller
 * used to log it and fall through to the KEYWORDLESS Cosmos read — which ignores the keywords
 * entirely and answers an arbitrary page of the whole readable corpus. One `and[centroid]=x` from
 * any anonymous caller turned every Project keyword search into that. Rows stayed ACL-gated, so it
 * was never a confidentiality bypass; it is exactly the failure this file's header exists to stop.
 *
 * So a type this cannot express is an UNSUPPORTED KEY, reported through the same `dropped` path as
 * a key the index does not carry, rather than emitted and hoped for.
 *
 * `Collection(Edm.String)` only, for the collections: the collection branch quotes its value, so a
 * `Collection(Edm.Int32)` would emit quoted integers and 400 the same way. `demi-*` has one
 * collection field (`read`) and it is strings; the check is what keeps that true if a second
 * arrives.
 */
const TERM_TYPES = new Set([
  'Edm.String', 'Edm.Int32', 'Edm.Int64', 'Edm.Double', 'Edm.Boolean'
]);

function expressible(meta) {
  return meta.collection ? meta.type === 'Collection(Edm.String)' : TERM_TYPES.has(meta.type);
}

/** Render one `field eq value` term, typed from the index definition. */
function term(field, meta, value) {
  const v = String(value);
  if (meta.collection) return `${field}/any(x: x eq ${quote(v)})`;
  switch (meta.type) {
    case 'Edm.Int32':
    case 'Edm.Int64': {
      // "Does it parse" is the wrong question; "can the field hold it" is the right one. `Number`
      // accepts both `0.5` and `1e21`, and `and[pageNumber]=0.5` emitted `pageNumber eq 0.5` while
      // `1e21` emitted `pageNumber eq 1e+21` — both 400s against the `Edm.Int32` that
      // `chunks.pageNumber` is, and a 400 on this endpoint is the corpus-listing fall-through
      // described above. `Number.isInteger(1e21)` is TRUE, so the range test is not redundant with
      // the integrality test: it is the one that catches that value.
      const n = Number(v);
      if (!Number.isInteger(n)) return null;
      if (meta.type === 'Edm.Int32') return (n >= -2147483648 && n <= 2147483647) ? `${field} eq ${n}` : null;
      // Beyond 2^53 the value has already lost precision before it could be compared, so an Int64
      // term built from it would filter on a number the caller did not send.
      return Number.isSafeInteger(n) ? `${field} eq ${n}` : null;
    }
    case 'Edm.Double':
      return Number.isFinite(Number(v)) ? `${field} eq ${Number(v)}` : null;
    case 'Edm.Boolean':
      // ONLY the two literals OData defines, and everything else is DROPPED rather than coerced.
      // `v === 'true'` alone made every other value mean `eq false`, so `and[isPublished]=True`
      // — or `1`, or `yes` — silently applied the OPPOSITE filter, answered 200, and reported
      // nothing lost. It only ever narrows, so there is no access-control impact; it is the same
      // silently-wrong-filter class this file's header exists to prevent, and the Edm.Int32 branch
      // eight lines up already refuses values it cannot express.
      if (v !== 'true' && v !== 'false') return null;
      return `${field} eq ${v === 'true'}`;
    default:
      return `${field} eq ${quote(v)}`;
  }
}

/** Split one wire value into terms the way both frontends mean it: `a,b` is a multi-select. */
function valuesOf(rawValue) {
  return (Array.isArray(rawValue) ? rawValue : [rawValue])
    .flatMap(v => String(v).split(','))
    .map(v => v.trim())
    .filter(Boolean);
}

/**
 * Every project id the caller asked to filter on, in BOTH wire forms.
 *
 * eagle-public sends two incompatible ones and both are live: `&project=<id>` flat, from `fields[]`
 * (certificates / amendments / application / featured / notifications), and `&and[project]=<id>`
 * from `queryModifier` (the documents tab). Handling only one means half the project tabs return
 * the whole corpus.
 */
function projectIdsFrom(query) {
  const ids = query && query.project ? valuesOf(query.project) : [];
  for (const [key, value] of andParams(query || {})) {
    if (key === 'project') ids.push(...valuesOf(value));
  }
  return Array.from(new Set(ids));
}

/**
 * A copy of `query` with every project key replaced by already-translated DEMI project ids.
 *
 * Returned as the flat `project` key alone, so `buildFilter` has one place to apply it rather than
 * two that can disagree.
 */
function withProjectIds(query, demiIds) {
  const next = {};
  for (const [key, value] of Object.entries(query)) {
    if (key === 'project') continue;
    if (/^and\[project\]$/.test(key)) continue;
    if (key === 'and' && value && typeof value === 'object' && !Array.isArray(value)) {
      const { project: _project, ...rest } = value;
      next.and = rest;
      continue;
    }
    next[key] = value;
  }
  next.project = demiIds.join(',');
  return next;
}

/**
 * Build the `$filter` from `and[key]=value` parameters plus the caller's ACL clause.
 *
 * Repeats of one key are a multi-select and become an OR group; different keys are ANDed — which is
 * what eagle-public means, since it splits its own values on `,` client-side and appends one
 * `and[key]=` per value (`api.ts:179-194`).
 *
 * `acl` IS REQUIRED AND IS THE WHOLE SAFETY ARGUMENT. It is `filterFor()`'s return value, not a
 * string, so this function can refuse the two ways a filter fails OPEN: a missing ACL clause, and
 * an `empty: true` caller — one who may see NOTHING, which OData cannot express as a filter because
 * it has no `false` literal (see access-odata.js). Both throw here rather than emitting a request,
 * because both would answer with the entire corpus and look like a working page.
 *
 * @param {object} query    req.query
 * @param {string} dataset  Project | Document | DocumentChunk
 * @param {{filter: string|null, empty: boolean}} acl  from helpers/access-odata.filterFor()
 * @returns {{filter: string|undefined, dropped: string[]}} filter undefined = unrestricted, which
 *          is reachable ONLY for a privileged caller whose ACL clause is legitimately null.
 */
function buildFilter(query, dataset, acl) {
  if (!acl || typeof acl.empty !== 'boolean') {
    throw new TypeError('[eagle-query] buildFilter requires the access filter from filterFor()');
  }
  if (acl.empty) {
    throw new TypeError('[eagle-query] buildFilter called for a caller scoped to nothing — the ' +
      'route must return [] and issue no request; there is no OData filter that matches nothing');
  }

  const fields = fieldsFor(dataset);
  const aliases = ALIASES[dataset] || {};
  const groups = [];
  const dropped = [];

  for (const [key, rawValue] of andParams(query)) {
    // `project` is translated by the caller before it gets here — an Eagle ObjectId compared
    // against a DEMI project id matches nothing, which reads as an empty tab rather than a bug.
    if (key === 'project') continue;

    const field = aliases[key] || key;
    const meta = fields.get(field);
    // Three ways a key cannot be filtered on, and all three are the same answer: not in the index,
    // not `filterable`, or a TYPE term() has no case for. See TERM_TYPES for why the last one is
    // not covered by the second.
    if (!meta || !meta.filterable || !expressible(meta)) {
      dropped.push(key);
      continue;
    }

    const values = valuesOf(rawValue);
    const terms = values.map(v => term(field, meta, v)).filter(Boolean);
    // Reported whenever ANY value was lost, not only when all of them were: `and[pageNumber]=1,0.5`
    // would otherwise narrow silently to `1` and look like the filter the caller asked for.
    if (terms.length !== values.length) dropped.push(key);
    if (terms.length) groups.push(terms.length === 1 ? terms[0] : `(${terms.join(' or ')})`);
  }

  // Flat `project`, carrying DEMI ids by this point. Named as `dropped` rather than ignored on an
  // index with no project axis — a project filter that quietly does not apply is the difference
  // between one project's documents and all of them.
  const projectIds = query.project ? valuesOf(query.project) : [];
  if (projectIds.length) {
    if (fields.get('projectId')) {
      const terms = projectIds.map(v => `projectId eq ${quote(v)}`);
      groups.push(terms.length === 1 ? terms[0] : `(${terms.join(' or ')})`);
    } else {
      dropped.push('project');
    }
  }

  if (query.categorized !== undefined && fields.has('categorized')) {
    groups.push(`categorized eq ${String(query.categorized) === 'true'}`);
  }

  if (acl.filter) groups.push(acl.filter);
  return { filter: groups.length ? groups.join(' and ') : undefined, dropped };
}

/**
 * Build `$orderby` from `sortBy`, normalising the three shapes on the wire.
 *
 *  - eagle-public appends `sortBy` TWICE (`api.ts:176-177`), the second often an empty string.
 *  - eagle-admin sends one comma-joined value and omits the parameter when it is null.
 *  - `+field` / `-field` carries the direction.
 *
 * RELEVANCE IS ORDERED EXPLICITLY, not by omission. `-score` names no field in any index, so it
 * cannot be passed through; but leaving `$orderby` off entirely leaves ties in whatever order the
 * service happened to compute, and with `$skip` paging that loses and repeats rows across pages.
 * `search.score() desc, id asc` is the same ranking with a deterministic tiebreak.
 *
 * The tiebreak is appended only where the key is sortable, which is why chunks get no `$orderby` at
 * all: nothing in `chunks` is sortable, and naming a non-sortable field is a 400.
 *
 * `$orderby` also OVERRIDES semantic reranking — the L2 order is expressed as the response order
 * and nothing else. That costs nothing today because `chunks` is the only semantic index and
 * it is the one index this cannot emit an order for; if a second index ever gets a semantic
 * configuration, this function has to learn about it.
 */
function buildOrderBy(sortBy, dataset, hasKeywords = false) {
  const fields = fieldsFor(dataset);
  const aliases = ALIASES[dataset] || {};
  const tiebreak = fields.get('id')?.sortable ? 'id asc' : null;

  const raw = (Array.isArray(sortBy) ? sortBy : [sortBy])
    .filter(s => typeof s === 'string' && s.trim() !== '')
    .flatMap(s => s.split(','))
    .map(s => s.trim())
    .filter(Boolean);

  const parts = [];
  const dropped = [];
  for (const entry of raw) {
    const desc = entry.startsWith('-');
    const name = entry.replace(/^[+-]/, '');
    if (name === 'score') continue;
    // The aliases are FILTER redirects — a caller sends an Eagle ObjectId, so `_id` becomes
    // `legacyEagleId`. Sorting is the opposite: fall back to the caller's own name when the
    // redirect target cannot sort but the original can.
    const aliased = aliases[name] || name;
    const field = fields.get(aliased)?.sortable ? aliased : name;
    const meta = fields.get(field);
    if (!meta || !meta.sortable) {
      dropped.push(name);
      continue;
    }
    parts.push(`${field} ${desc ? 'desc' : 'asc'}`);
  }

  if (parts.length === 0) {
    const askedForRelevance = raw.some(e => e.replace(/^[+-]/, '') === 'score');
    if (askedForRelevance || hasKeywords) {
      // Relevance, made explicit so it can be paged. Without a sortable key there is no tiebreak
      // to add, and an `$orderby` of `search.score() desc` alone is what the service already does.
      return { orderby: tiebreak ? `search.score() desc, ${tiebreak}` : undefined, dropped };
    }
    if (!DEFAULT_ORDER[dataset]) return { orderby: undefined, dropped };
    parts.push(DEFAULT_ORDER[dataset]);
  }

  if (tiebreak) parts.push(tiebreak);
  return { orderby: parts.join(', '), dropped };
}

/**
 * Every filter key the caller sent, for the paths that can apply NONE of them.
 *
 * The keywordless list reads answer from Cosmos through `listVisible`, whose criteria are fixed
 * (`repositories/projects.js:26-39`) — no `and[]` filter reaches them at all. Naming the keys in the
 * log is the whole point: a filter panel that quietly does nothing returns the full corpus and
 * looks exactly like a filter that matched everything.
 */
function filterKeysIn(query) {
  const keys = Array.from(andParams(query || {}), ([key]) => key);
  if (query && query.project) keys.push('project');
  if (query && query.categorized !== undefined) keys.push('categorized');
  return Array.from(new Set(keys));
}

/**
 * Parameters this endpoint does not understand. See KNOWN_PARAMS for why this is a 400.
 */
function unknownParams(query) {
  return Object.keys(query || {}).filter(
    key => !KNOWN_PARAMS.has(key) && key !== 'and' && !/^and\[.+\]$/.test(key)
  );
}

/**
 * The `{_id, name}` pair eagle-public's templates expect where eagle-api populated a reference.
 * Ported from eagle-search/service/shape.js, including the reason it returns `undefined` rather
 * than `{}`: the templates read `rowData.proponent?.name || '-'`, so an absent value renders a dash
 * while `{}` renders a blank cell. A dash says "no proponent"; a blank says "this page is broken".
 */
function ref(id, name) {
  if (!id && !name) return undefined;
  return { _id: id, name };
}

/** Count and log dropped keys once per request rather than per key. */
function reportDropped(dataset, kind, dropped) {
  if (!dropped || !dropped.length) return;
  logger.warn(
    `[eagle-query] ${dataset}: dropped ${kind} ${dropped.join(', ')} — ` +
    `not ${kind === 'sort' ? 'sortable' : 'filterable'} in the index`
  );
}

module.exports = {
  // Exported for the guard test only. Nothing in production reads it from outside this module —
  // it is here so a test can assert every value still names a definition file on disk, which is
  // the one failure mode this mapping has and the one that produces a 200 instead of an error.
  DATASET_INDEX,
  buildFilter,
  buildOrderBy,
  unknownParams,
  filterKeysIn,
  projectIdsFrom,
  withProjectIds,
  reportDropped,
  ref,
  quote
};
