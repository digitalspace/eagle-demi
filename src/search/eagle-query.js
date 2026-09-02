'use strict';

/**
 * Translate eagle-public's query string into an Azure AI Search request.
 *
 * The contract belongs to eagle-api, not to us: `api.ts:160-206` emits `and[key]=value` repeats,
 * `sortBy` TWICE (often one of them empty), a 0-BASED `pageNum`, and a flat `project=<id>` on the
 * project tabs. Everything in this file exists because of one of those.
 *
 * Field metadata is read from `azure/search/indexes/*.json` at load, never from a table here, and a
 * key the indexes cannot express is DROPPED and logged rather than emitted — an unknown field name
 * is an OData 400, which eagle-public renders as an empty table. See
 * wiki Search-Index-Reference#field-metadata-comes-from-the-committed-index-definitions and
 * #what-demis-indexes-cannot-express.
 */

const fs = require('fs');
const path = require('path');
const { logger } = require('../utils/logger');
const { catalogFor } = require('../vis/catalog');
const { visible } = require('../vis/redact');
const { levelOf } = require('../vis/level');

const INDEX_DIR = path.join(__dirname, '..', '..', 'azure', 'search', 'indexes');

/**
 * Dataset → which `azure/search/indexes/*.json` holds its field metadata.
 *
 * SCHEMA NAMES, NOT WIRE NAMES: decoupled from `SEARCH_INDEX*` on purpose, so the physical indexes
 * can be renamed one app setting at a time. An unmatched name falls back to an empty Map, which
 * answers 200 with no filters applied rather than failing.
 */
const DATASET_INDEX = {
  Project: 'projects',
  Document: 'documents',
  DocumentChunk: 'chunks'
};

/**
 * Wire key → index field, per dataset.
 *
 * `_id` lands on whichever field holds the EAGLE id — `legacyEagleId` for a project, the row key
 * itself for a document or chunk. `project` is deliberately absent: its value needs translating
 * from an Eagle ObjectId to a DEMI project id, which is a read, not a rename. See
 * `projectIdsFrom`/`withProjectIds`.
 */
const ALIASES = {
  Project: {
    _id: 'legacyEagleId',
    // sortBy forms eagle-public sends for nested columns (project-list.constants.ts:7-38)
    'project.name': 'name',
    'proponent.name': 'proponent',
    // The filter panel sends List ObjectIds for these three while the columns render the LABEL, so
    // the wire name resolves to the id column. Same split eagle-search uses: an id is unambiguous.
    eacDecision: 'eacDecisionId',
    currentPhaseName: 'currentPhaseNameId',
    CEAAInvolvement: 'ceaaInvolvementId'
  },
  Document: {
    _id: 'id',
    project: 'projectId',
    // The four document facets send List ObjectIds, never labels. Copied from eagle-search's own
    // map rather than invented — a flip changes what a saved filter URL means.
    type: 'typeId',
    milestone: 'milestoneId',
    projectPhase: 'projectPhaseId',
    documentAuthorType: 'documentAuthorTypeId'
  },
  DocumentChunk: {
    _id: 'chunkId',
    project: 'projectId',
    document: 'documentId'
  }
};

/**
 * Wire keys that name a REAL field of the index and must still never be filtered on.
 *
 * `proponent` is the whole reason this exists: it passes every gate in `buildFilter` and emits
 * `proponent eq '<ObjectId>'` against a field holding a NAME, matching 0 of 382 rows under a 200.
 * NOT a general deny list — a key naming no field, or an unfilterable one, is already dropped
 * below. See wiki Search-Index-Reference#what-demis-indexes-cannot-express.
 */
const EMPTY_SET = new Set();

const UNMAPPED_KEYS = {
  Project: new Set(['proponent'])
};

/**
 * Wire VALUE -> the OTHER spelling the corpus may hold it under. Both are matched, never swapped,
 * because both are stored. An unlisted value is matched as sent: Track can add a type without
 * asking us. See wiki Search-Index-Reference#project-type-spellings.
 */
const VALUE_ALIASES = {
  Project: {
    type: {
      'Energy-Electricity': 'Energy - Electricity',
      'Energy-Petroleum & Natural Gas': 'Energy - Petroleum & Natural Gas',
      'Tourist Destination Resorts': 'Tourist Destination Resort'
    }
  }
};

/**
 * Order applied when the caller asks for none AND there are no keywords: `search: '*'` has no stable
 * order, so without this page 2 repeats and omits rows from page 1. No entry for DocumentChunk —
 * every field in `chunks` is `sortable: false`. See
 * wiki Search-Query-Construction#default-order-and-relevance.
 */
const DEFAULT_ORDER = {
  Project: 'name asc',
  Document: 'displayName asc'
};

/**
 * Query parameters this endpoint understands. Anything else is a 400 rather than a silent no-op —
 * see wiki Search-Query-Construction#unsupported-parameters-400-inexpressible-filter-keys-drop.
 */
const KNOWN_PARAMS = new Set([
  // this API's own
  'dataset', 'keywords', 'q', 'fuzzy', 'pageSize',
  // eagle-public's (api.ts:160-206). The last four are read by nobody here.
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
    // THROWING IS CORRECT: the map built below is the type gate, and an empty one would let a
    // `filterable` geography field through to an OData `eq` the service 400s on. The message names
    // the packaging fault because this runs at require time, where a bare ENOENT reads as a bad
    // mount or a broken image.
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
 * Dataset -> the catalog that classifies its INDEX field names (docs/rbac-architecture.md section 2
 * item 9). No entry for DocumentChunk: the chunks catalog classifies the STORED chunk, not index
 * field names, so chunk query keys stay ungated.
 */
const DATASET_CATALOG = {
  Project: 'index-projects',
  Document: 'index-documents'
};

/**
 * May this caller filter or sort on this index field? A field they cannot READ they cannot QUERY
 * either — a row count over a hidden value answers what the value is.
 *
 * Uncatalogued is a drop, not a pass: an index field with no policy has no answer here.
 */
function fieldVisible(dataset, field, access) {
  const entity = DATASET_CATALOG[dataset];
  if (!entity) return true;
  const entry = catalogFor(entity)[field];
  return Boolean(entry) && visible(levelOf(access), entry.defaultVis);
}

/**
 * Yield `[key, value]` for every `and[...]` parameter, whichever shape the query parser produced.
 * BOTH SHAPES, on purpose — see wiki Search-Query-Construction#query-parser-shapes.
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
 * The Edm types `term()` has a case for — and THE GATE FOR A FILTER KEY, not `filterable`. A type
 * this cannot express is an UNSUPPORTED KEY, reported through the same `dropped` path as a key the
 * index does not carry. See wiki Search-Index-Reference#type-gates-not-filterable-and-sortable-flags.
 *
 * `Collection(Edm.String)` only: the collection branch quotes its value, so a `Collection(Edm.Int32)`
 * would emit quoted integers and 400 the same way.
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
      // "Can the field hold it", not "does it parse": `Number` accepts `0.5` and `1e21`, and both
      // 400 against an `Edm.Int32`. `Number.isInteger(1e21)` is TRUE, so the range test is not
      // redundant with the integrality one — it is what catches that value.
      const n = Number(v);
      if (!Number.isInteger(n)) return null;
      if (meta.type === 'Edm.Int32') return (n >= -2147483648 && n <= 2147483647) ? `${field} eq ${n}` : null;
      // Beyond 2^53 the value lost precision before it could be compared.
      return Number.isSafeInteger(n) ? `${field} eq ${n}` : null;
    }
    case 'Edm.Double':
      return Number.isFinite(Number(v)) ? `${field} eq ${Number(v)}` : null;
    case 'Edm.Boolean':
      // ONLY the two literals OData defines. `v === 'true'` alone made every other value mean
      // `eq false`, so `True`, `1` or `yes` silently applied the OPPOSITE filter under a 200.
      if (v !== 'true' && v !== 'false') return null;
      return `${field} eq ${v === 'true'}`;
    default:
      return `${field} eq ${quote(v)}`;
  }
}

/**
 * Render one edge of a date range as `field ge|lt <instant>`.
 *
 * DAY GRANULARITY, and the asymmetry is the point: the wire carries a calendar day while the field
 * is an instant, so `End` becomes `lt <next day>` — `le <that day>` would exclude a document posted
 * at 09:00 on the end date. Ported from eagle-search; both services must answer the same question
 * for the same URL. Anything that is not a datetime returns null and lands in `dropped`.
 */
function rangeTerm(field, meta, value, edge) {
  if (meta.type !== 'Edm.DateTimeOffset') return null;
  const d = new Date(String(value));
  if (isNaN(d.getTime())) return null;

  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return edge === 'Start'
    ? `${field} ge ${new Date(day).toISOString()}`
    : `${field} lt ${new Date(day + 86400000).toISOString()}`;
}

/** Split one wire value into terms the way both frontends mean it: `a,b` is a multi-select. */
function valuesOf(rawValue) {
  return (Array.isArray(rawValue) ? rawValue : [rawValue])
    .flatMap(v => String(v).split(','))
    .map(v => v.trim())
    .filter(Boolean);
}

/**
 * Every project id the caller asked to filter on, in BOTH wire forms: `&project=<id>` flat from
 * `fields[]`, and `&and[project]=<id>` from `queryModifier`. Both are live, and handling only one
 * means half the project tabs return the whole corpus.
 */
function projectIdsFrom(query) {
  const ids = query && query.project ? valuesOf(query.project) : [];
  for (const [key, value] of andParams(query || {})) {
    if (key === 'project') ids.push(...valuesOf(value));
  }
  return Array.from(new Set(ids));
}

/**
 * A copy of `query` with every project key replaced by already-translated DEMI project ids, flattened
 * onto `project` alone so `buildFilter` has one place to apply it rather than two that can disagree.
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
 * Repeats of one key are a multi-select and become an OR group; different keys are ANDed, which is
 * what eagle-public means — it splits on `,` client-side and appends one `and[key]=` per value.
 *
 * `acl` IS REQUIRED AND IS THE WHOLE SAFETY ARGUMENT. It is `filterFor()`'s return value, not a
 * string, so this can refuse the two ways a filter fails OPEN: a missing ACL clause, and an
 * `empty: true` caller, whom OData cannot express because it has no `false` literal.
 *
 * @param {object} query    req.query
 * @param {string} dataset  Project | Document | DocumentChunk
 * @param {{filter: string|null, empty: boolean}} acl  from helpers/access-odata.filterFor()
 * @param {object} access  from helpers/access-sql.resolveAccess(); absent reads as anonymous
 * @returns {{filter: string|undefined, dropped: string[]}} filter undefined = unrestricted, which
 *          is reachable ONLY for a privileged caller whose ACL clause is legitimately null.
 */
function buildFilter(query, dataset, acl, access) {
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

    // A `Start`/`End` suffix is a RANGE on the base field, not a field of its own. Resolved against
    // the committed definition, so a suffixed name no index carries still falls through to
    // `dropped` instead of becoming a 400.
    const edge = /(Start|End)$/.exec(key)?.[1];
    const base = edge ? key.slice(0, -edge.length) : key;

    // Before the field lookup, because this key DOES resolve to a field — see UNMAPPED_KEYS.
    if ((UNMAPPED_KEYS[dataset] || EMPTY_SET).has(base)) {
      dropped.push(key);
      continue;
    }

    const field = aliases[base] || base;
    if (!fieldVisible(dataset, field, access)) {
      dropped.push(key);
      continue;
    }

    const meta = fields.get(field);
    // Three ways a key cannot be filtered on, all the same answer: not in the index, not
    // `filterable`, or a TYPE the term builder has no case for. The edge branch gates on `rangeTerm`
    // returning something instead — a range asks a different question of the type than an `eq`.
    if (!meta || !meta.filterable || (!edge && !expressible(meta))) {
      dropped.push(key);
      continue;
    }

    const valueMap = (VALUE_ALIASES[dataset] || {})[base] || {};
    const values = valuesOf(rawValue);
    // ONE ENTRY PER WIRE VALUE, whatever it expands to, so the report below counts values that
    // produced no term rather than the spellings each was tried under.
    const terms = values.flatMap((v) => {
      const spellings = valueMap[v] && valueMap[v] !== v ? [v, valueMap[v]] : [v];
      const built = spellings
        .map(spelling => (edge ? rangeTerm(field, meta, spelling, edge) : term(field, meta, spelling)))
        .filter(Boolean);
      if (built.length === 0) return [];
      return [built.length === 1 ? built[0] : `(${built.join(' or ')})`];
    });
    // Reported whenever ANY value was lost, not only when all of them were: `and[pageNumber]=1,0.5`
    // would otherwise narrow silently to `1` and look like the filter the caller asked for.
    if (terms.length !== values.length) dropped.push(key);
    if (terms.length) groups.push(terms.length === 1 ? terms[0] : `(${terms.join(' or ')})`);
  }

  // Flat `project`, carrying DEMI ids by this point. Named as `dropped` on an index with no project
  // axis: a project filter that quietly does not apply widens one project's rows to all of them.
  const projectIds = query.project ? valuesOf(query.project) : [];
  if (projectIds.length) {
    if (fields.get('projectId')) {
      const terms = projectIds.map(v => `projectId eq ${quote(v)}`);
      groups.push(terms.length === 1 ? terms[0] : `(${terms.join(' or ')})`);
    } else {
      dropped.push('project');
    }
  }

  if (query.categorized !== undefined) {
    if (fields.has('categorized')) {
      groups.push(`categorized eq ${String(query.categorized) === 'true'}`);
    } else {
      // Named, not silently ignored: `categorized` counts as criteria and routes the caller to the
      // index, and no demi index carries the field.
      dropped.push('categorized');
    }
  }

  if (acl.filter) groups.push(acl.filter);
  return { filter: groups.length ? groups.join(' and ') : undefined, dropped };
}

/**
 * The Edm types `$orderby` can name. Same gate as TERM_TYPES, one type wider: `Edm.DateTimeOffset`
 * has no `eq` case but sorts fine, and `documents.datePosted` is eagle-public's DEFAULT document
 * sort. `meta.type` keeps the whole `Collection(...)` string, so membership alone rejects
 * collections and geographies however their `sortable` flag reads.
 */
const ORDER_TYPES = new Set([...TERM_TYPES, 'Edm.DateTimeOffset']);

function orderable(meta) {
  return ORDER_TYPES.has(meta.type);
}

/**
 * The sort keys a `sortBy` actually carries, whichever of the three wire shapes it arrived in.
 *
 * SEPARATE FROM `buildOrderBy` BECAUSE THE ROUTER ASKS THE SAME QUESTION: the projects map sends
 * `sortBy=&sortBy=` on every call, and a truthiness test would read that as "the caller asked for an
 * order" and move a million-row list read onto the AI Search path.
 */
function sortEntries(sortBy) {
  return (Array.isArray(sortBy) ? sortBy : [sortBy])
    .filter(s => typeof s === 'string' && s.trim() !== '')
    .flatMap(s => s.split(','))
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Did the caller ask for anything only the INDEX can answer — a filter or a sort?
 *
 * THIS IS THE ROUTING TEST: the Cosmos list reads take fixed criteria in a fixed order, so a request
 * carrying either would be answered with the whole corpus under a 200.
 *
 * `project` IS DELIBERATELY NOT CRITERIA, and this is a PROJECT-dataset test only — the `Document`
 * branch no longer consults it. See wiki Search-Query-Construction#every-document-read-goes-to-the-index.
 */
function hasCriteria(query) {
  if (filterKeysIn(query).some(key => key !== 'project')) return true;
  return sortEntries(query && query.sortBy).length > 0;
}

/**
 * Build `$orderby` from `sortBy`, normalising the three shapes on the wire: eagle-public appends
 * `sortBy` TWICE (the second often empty), eagle-admin sends one comma-joined value, and `+`/`-`
 * carries the direction.
 *
 * RELEVANCE IS ORDERED EXPLICITLY as `search.score() desc, id asc` — leaving `$orderby` off leaves
 * ties in whatever order the service computed, which `$skip` paging then loses and repeats. The gate
 * for a sort key is the field's TYPE, not `sortable`. `$orderby` also overrides semantic reranking,
 * which costs nothing while `chunks` is both the only semantic index and the one that can carry no
 * order at all. See wiki Search-Query-Construction#default-order-and-relevance and
 * #type-gates-not-filterable-and-sortable-flags.
 */
function buildOrderBy(sortBy, dataset, hasKeywords = false, access) {
  const fields = fieldsFor(dataset);
  const aliases = ALIASES[dataset] || {};
  const tiebreak = fields.get('id')?.sortable ? 'id asc' : null;

  const raw = sortEntries(sortBy);

  const parts = [];
  const dropped = [];
  const seen = new Set();
  for (const entry of raw) {
    const desc = entry.startsWith('-');
    const name = entry.replace(/^[+-]/, '');
    if (name === 'score') continue;
    // The aliases are FILTER redirects (`_id` → `legacyEagleId`). Sorting is the opposite: fall back
    // to the caller's own name when the redirect target cannot sort but the original can.
    const aliased = aliases[name] || name;
    const aliasMeta = fields.get(aliased);
    const field = aliasMeta && aliasMeta.sortable ? aliased : name;
    if (!fieldVisible(dataset, field, access)) {
      dropped.push(name);
      continue;
    }

    const meta = fields.get(field);
    // Three ways a key cannot be ordered by, all the same answer: not in the index, not `sortable`,
    // or a TYPE `$orderby` cannot name — `centroid` is `sortable: true` and is still a 400.
    if (!meta || !meta.sortable || !orderable(meta)) {
      dropped.push(name);
      continue;
    }
    // ONE CLAUSE PER FIELD: a repeated field cannot change the order, so the second clause is at
    // best noise and at worst a 400. No clause cap beside it — Azure's limit is 32 and `documents`,
    // the widest index, has 17 fields in total, so one could never fire. Add it here if that changes.
    if (seen.has(field)) continue;
    seen.add(field);
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
    // The default sort goes through the SAME visibility gate as the caller's own keys: a field this
    // caller cannot read cannot order their page either.
    if (fieldVisible(dataset, DEFAULT_ORDER[dataset].split(' ')[0], access)) {
      parts.push(DEFAULT_ORDER[dataset]);
    }
  }

  // The tiebreak goes through the SAME dedupe as the caller's clauses, or `sortBy=id` emits
  // `id asc, id asc`. `_id` reaches here as `id` too, through the alias table.
  if (tiebreak && !seen.has(tiebreak.split(' ')[0])) parts.push(tiebreak);
  return { orderby: parts.join(', ') || undefined, dropped };
}

/**
 * Can a `project` filter be EXPRESSED against this dataset's index at all?
 *
 * `documents` and `chunks` carry `projectId`; `projects` does not, because a project IS its own
 * scope. A dropped project filter is the one drop a route must never simply answer around: the
 * difference between one project's rows and every project's rows is the whole request.
 */
function canScopeToProject(dataset) {
  return Boolean(fieldsFor(dataset).get('projectId'));
}

/**
 * Every filter key the caller sent, for the paths that can apply NONE of them — the keywordless
 * Cosmos list reads, whose criteria are fixed. Naming the keys in the log is the whole point: a
 * filter panel that quietly does nothing returns the full corpus and looks like a filter that
 * matched everything.
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
 * `undefined` rather than `{}`, because the templates read `?.name || '-'`: an absent value renders
 * a dash, while `{}` renders a blank cell. A dash says "no proponent", a blank says "this is broken".
 */
function ref(id, name) {
  if (!id && !name) return undefined;
  return { _id: id, name };
}

/** Count and log dropped keys once per request rather than per key. */
function reportDropped(dataset, kind, dropped) {
  if (!dropped || !dropped.length) return;
  // "not expressible" rather than "not sortable"/"not filterable": the commonest drop is a field
  // the index DOES flag `sortable: true` whose TYPE cannot be ordered (`centroid`).
  logger.warn(
    `[eagle-query] ${dataset}: dropped ${kind} ${dropped.join(', ')} — ` +
    `not expressible as ${kind === 'sort' ? 'an $orderby' : 'a $filter'} against this index`
  );
}

module.exports = {
  // Exported for the guard test only: it asserts every value still names a definition file on disk,
  // which is this mapping's one failure mode and the one that produces a 200 instead of an error.
  DATASET_INDEX,
  // Exported for the ratchet tests: an alias or a default sort naming a restricted field would
  // filter and order over something the caller cannot see.
  ALIASES,
  DEFAULT_ORDER,
  buildFilter,
  buildOrderBy,
  hasCriteria,
  unknownParams,
  filterKeysIn,
  canScopeToProject,
  andParams,
  projectIdsFrom,
  withProjectIds,
  reportDropped,
  ref,
  quote
};
