'use strict';

/**
 * eagle-public's query string (eagle-api's contract, api.ts:160-206) as an Azure AI Search request.
 * A key the committed index JSON cannot express is dropped, never sent: OData 400s on it (wiki Search-Index-Reference).
 */

const fs = require('fs');
const path = require('path');
const { logger } = require('../utils/logger');
const { buildContainsQuery } = require('./ai-search');
const { sortEntries } = require('./sort-entries');
const { subTypeSources } = require('./sub-type');
const { PROJECT_TYPE_SPELLINGS, spellingsOf } = require('../helpers/spellings');
const { catalogFor } = require('../vis/catalog');
const { visible } = require('../vis/redact');
const { levelOf } = require('../vis/level');

const INDEX_DIR = path.join(__dirname, '..', '..', 'azure', 'search', 'indexes');

/**
 * Dataset → its `azure/search/indexes/*.json` SCHEMA name, decoupled from `SEARCH_INDEX*` so an index
 * can be renamed one app setting at a time. Unmatched = empty Map: 200 with no filters applied.
 */
const DATASET_INDEX = {
  Project: 'projects',
  Document: 'documents',
  DocumentChunk: 'chunks',
  // KEYWORD SEARCHES ONLY; Cosmos serves these without keywords, so a field both paths filter on
  // has to mean the same thing in both.
  RecentActivity: 'activities',
  ProjectNotification: 'project-notifications'
};

/**
 * Filter-panel facets → List ObjectId field. ONE table for documents and chunks: a chunk copies these
 * ids from its parent (chunks.js CHUNK_PARENT_FIELDS, pinned by a test), so a saved URL means one thing.
 */
const DOCUMENT_FACETS = Object.freeze({
  type: 'typeId',
  milestone: 'milestoneId',
  projectPhase: 'projectPhaseId',
  documentAuthorType: 'documentAuthorTypeId'
});

/**
 * Wire key → index field, per dataset; `_id` lands on the field holding the Eagle id. A `project`
 * VALUE is translated elsewhere: Eagle ObjectId → DEMI id is a read, not a rename (`withProjectIds`).
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
    CEAAInvolvement: 'ceaaInvolvementId',
    // Same split: the facet filters by Organization ObjectId; sorting stays on the name, because
    // `proponentId` is `sortable: false` and `sortFieldFor` falls back.
    proponent: 'proponentId'
  },
  Document: {
    _id: 'id',
    project: 'projectId',
    ...DOCUMENT_FACETS
  },
  DocumentChunk: {
    _id: 'chunkId',
    project: 'projectId',
    document: 'documentId',
    // The chunk's OWN copy of its parent's ids, so one clause on one index: scoping by a documents
    // query first is capped at one page of ids, and real facets match thousands of documents.
    ...DOCUMENT_FACETS
  }
};

/**
 * Wire key → field to ORDER BY instead; sort only, as a filter alias would match no value (zero rows).
 * `displayNameSort` is zero-padded (helpers/natural-sort) so "Item 2" sorts before "Item 10".
 */
const SORT_KEYS = {
  Document: { displayName: 'displayNameSort' },
  // As notifications.js SORT_ALIASES: eagle-public's `-_id` was an arrival-order proxy, and these
  // rows carry the received date itself.
  ProjectNotification: { _id: 'notificationReceivedDate' }
};

/**
 * Wire keys naming a real, filterable field of the WRONG value space (an id sent against a name
 * column): the one gate that refuses those. Not a deny list; empty for now.
 */
const EMPTY_SET = new Set();

const UNMAPPED_KEYS = {};

/**
 * Keys that ask WHETHER a field is filled (`and[documentUrl]=true|false`, "Documents attached"); any
 * other value drops. Empty string and absent both mean none: updates rows store either.
 */
const PRESENCE_KEYS = {
  RecentActivity: new Set(['documentUrl'])
};

/** `field is filled` / `field is empty`, the only two questions a PRESENCE_KEYS key can ask. */
function presenceTerm(field, values) {
  if (values.length !== 1) return null;
  if (values[0] === 'true') return `(${field} ne null and ${field} ne '')`;
  if (values[0] === 'false') return `(${field} eq null or ${field} eq '')`;
  return null;
}

/**
 * Wire key -> the spelling pairs the corpus may hold its values under, per dataset. Both are
 * matched, never swapped, because both are stored (see `helpers/spellings.js`).
 */
const VALUE_ALIASES = {
  Project: { type: PROJECT_TYPE_SPELLINGS }
};

/**
 * `and[sector]=X` also matches a no-sector row whose sub-type shows as X (controllers/search.js wireSector).
 * Null when none does or the caller may not query its fields; adds those fields to `read` if used.
 */
function sectorFallbackTerm(value, access, read) {
  const fields = fieldsFor('Project');
  const reads = ['projectSubType', 'legislationYear'];
  if (!reads.every(f => fields.get(f)?.filterable && fieldVisible('Project', f, access))) return null;
  const sources = subTypeSources(value).map(({ name, under2002, under2018 }) => {
    const eq = `projectSubType eq ${quote(name)}`;
    if (under2002 && under2018) return eq;
    return under2002
      ? `(${eq} and legislationYear le 2002)`
      : `(${eq} and (legislationYear eq null or legislationYear gt 2002))`;
  });
  if (sources.length === 0) return null;
  reads.forEach(f => read.add(f));
  const any = sources.length === 1 ? sources[0] : `(${sources.join(' or ')})`;
  return `((sector eq null or sector eq '') and ${any})`;
}

/** Wire key -> a term for the rows whose shown value comes from a fallback field, per dataset. */
const FALLBACK_TERMS = {
  Project: { sector: sectorFallbackTerm }
};

/**
 * Order when the caller asks for none and has no keywords: `search: '*'` has no stable order, so paging
 * would repeat and omit rows. No DocumentChunk entry: nothing in `chunks` is sortable.
 */
const DEFAULT_ORDER = {
  Project: 'name asc',
  Document: 'displayName asc'
};

/**
 * Bare filter keys eagle-public sends flat, not under `and[...]`. `filterKeysIn` reads them too, so a
 * dataset that ignores one reports it dropped instead of answering as if it applied.
 */
const BARE_FILTER_KEYS = ['top', 'docIds', 'period', 'companyType', '_id'];

/** Every other query parameter is a 400, never a silent no-op (wiki Search-Query-Construction). */
const KNOWN_PARAMS = new Set([
  // this API's own
  'dataset', 'keywords', 'q', 'fuzzy', 'prefix', 'pageSize',
  // eagle-public's (api.ts:160-206). The last four are read by nobody here.
  'pageNum', 'sortBy', 'project', 'categorized', 'projectLegislation', 'populate', 'fields',
  // eagle-admin's: the model `dataset=Item` reads one record from.
  '_schemaName',
  ...BARE_FILTER_KEYS
]);

/** Loaded once. A schema change needs a redeploy anyway — the definitions ship in the package. */
const FIELDS = loadFields();

function loadFields() {
  const byIndex = {};
  let files;
  try {
    files = fs.readdirSync(INDEX_DIR);
  } catch (err) {
    // THROW: this map is the type gate, and an empty one lets geography fields through to a 400.
    // The message names the packaging fault, since a bare ENOENT at require time reads as a bad mount.
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
 * Dataset -> the catalog for its INDEX field names (docs/rbac-architecture.md 2.9). No DocumentChunk:
 * its catalog classifies the stored chunk, so chunk query keys stay ungated.
 */
const DATASET_CATALOG = {
  Project: 'index-projects',
  Document: 'index-documents',
  // Stored-row catalogs fit: these data sources rename nothing. `read` is 0/0 in both, so no caller
  // can count rows by `and[read]=…`.
  RecentActivity: 'updates',
  ProjectNotification: 'notifications'
};

/**
 * May this caller filter or sort on this field? Not if they cannot READ it: a row count over a hidden
 * value answers what it is. Uncatalogued is a drop, not a pass.
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
 * The Edm types `term()` handles: THE filter-key gate, not `filterable` (wiki Search-Index-Reference
 * #type-gates-not-filterable-and-sortable-flags). Collections: String only, as that branch quotes.
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
      // "Can the field hold it", not "does it parse": `Number.isInteger(1e21)` is true, and only the
      // range test stops it reaching an `Edm.Int32` as a 400.
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
 * One date-range edge, by day: `End` is `lt <next day>`, as `le <day>` loses rows posted later that
 * day. Same answer as eagle-search gave for one URL; a non-date is null, so dropped.
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
 * `and[nameContains]` fields; `and[name]` keeps meaning exact match. The `*Tokens` twins use the
 * `filename` analyzer, which keeps stopwords like 'mine' that `en.microsoft` strips (ai-search.js).
 */
const NAME_CONTAINS_FIELDS = Object.freeze({
  Project: Object.freeze(['name', 'nameTokens']),
  Document: Object.freeze(['displayName', 'documentFileName', 'fileNameTokens'])
});

const NAME_CONTAINS_KEY = 'nameContains';

/** Free text spliced into a query; past a full name a longer value is a caller fault, not a filter. */
const MAX_NAME_CONTAINS = 200;

/**
 * The text of `and[nameContains]`. NOT `valuesOf`: a comma separates words here, not alternatives,
 * and a repeated key joins with a space so it narrows.
 */
function nameContainsText(rawValue) {
  return (Array.isArray(rawValue) ? rawValue : [rawValue])
    .map(v => (v === undefined || v === null ? '' : String(v)))
    .join(' ')
    .trim();
}

/**
 * `'full'` syntax, as under simple syntax the query's `AND` matches the word "and". A word may match in
 * ANY listed field, so one the prose analyzer strips still lands on its `filename` twin.
 */
function nameContainsClause(fields, lucene) {
  return `search.ismatch(${quote(lucene)}, ${quote(fields.join(','))}, 'full', 'any')`;
}

/**
 * The 400 message for an `and[nameContains]` the caller built wrong, or null. Refused, not dropped:
 * a dropped one would serve the unfiltered corpus under a 200.
 */
function nameContainsError(query, dataset) {
  for (const [key, rawValue] of andParams(query || {})) {
    if (key !== NAME_CONTAINS_KEY) continue;
    if (!NAME_CONTAINS_FIELDS[dataset]) {
      return `and[${NAME_CONTAINS_KEY}] applies to ${
        Object.keys(NAME_CONTAINS_FIELDS).map(d => `dataset=${d}`).join(' and ')} only`;
    }
    if (nameContainsText(rawValue).length > MAX_NAME_CONTAINS) {
      return `and[${NAME_CONTAINS_KEY}] is limited to ${MAX_NAME_CONTAINS} characters`;
    }
  }
  return null;
}

/**
 * Every project id asked for, flat `project=` and `and[project]=` both: both are live, and missing
 * one makes half the project tabs return the whole corpus.
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
 * `$filter` from `and[...]` (a key's repeats OR, keys AND), ANDed with the whole filterFor() `acl`.
 * Returns `{filter, dropped, fields}`; `fields` = index columns the terms read, `opts.unexpressible` keys drop.
 */
function buildFilter(query, dataset, acl, access, opts = {}) {
  if (!acl || typeof acl.empty !== 'boolean') {
    throw new TypeError('[eagle-query] buildFilter requires the access filter from filterFor()');
  }
  if (acl.empty) {
    throw new TypeError('[eagle-query] buildFilter called for a caller scoped to nothing — the ' +
      'route must return [] and issue no request; there is no OData filter that matches nothing');
  }

  const fields = fieldsFor(dataset);
  const aliases = ALIASES[dataset] || {};
  const unexpressible = new Set(opts.unexpressible || []);
  const groups = [];
  const dropped = [];
  // Index fields the caller's own terms read: returned as `fields`, and a default below steps aside.
  const filtered = new Set();

  for (const [key, rawValue] of andParams(query)) {
    // `project` is translated by the caller before it gets here — an Eagle ObjectId compared
    // against a DEMI project id matches nothing, which reads as an empty tab rather than a bug.
    if (key === 'project') continue;

    // A substring match: a `search.ismatch` clause, not a term, so before the alias and field lookup.
    if (key === NAME_CONTAINS_KEY) {
      const containsFields = NAME_CONTAINS_FIELDS[dataset];
      const text = nameContainsText(rawValue);
      // Before the no-words test: an over-cap value must not read as an empty cell and widen to all.
      if (text.length > MAX_NAME_CONTAINS) { dropped.push(key); continue; }
      // No word left (cleared box, bare punctuation) is no filter; a clause over no terms is a 400.
      const lucene = buildContainsQuery(text);
      if (!lucene) continue;
      // EVERY field must be readable, not any: a clause naming a hidden field counts rows against it.
      if (!containsFields || !containsFields.every(f => fieldVisible(dataset, f, access))) {
        dropped.push(key);
        continue;
      }
      groups.push(nameContainsClause(containsFields, lucene));
      containsFields.forEach(f => filtered.add(f));
      continue;
    }

    // A `Start`/`End` suffix is a RANGE on the base field; a base no index carries still drops below
    // instead of becoming a 400.
    const edge = /(Start|End)$/.exec(key)?.[1];
    const base = edge ? key.slice(0, -edge.length) : key;

    // Before the field lookup, as both resolve to a field: UNMAPPED_KEYS, and `opts.unexpressible`
    // for one this request learned the LIVE index lacks whatever the committed definition says.
    if ((UNMAPPED_KEYS[dataset] || EMPTY_SET).has(base) || unexpressible.has(base)) {
      dropped.push(key);
      continue;
    }

    const field = aliases[base] || base;
    if (!fieldVisible(dataset, field, access)) {
      dropped.push(key);
      continue;
    }

    const meta = fields.get(field);
    // Not in the index, not `filterable`, or a TYPE `term()` cannot write: all drop. A range edge
    // gates on `rangeTerm` instead, as it asks the type a different question.
    if (!meta || !meta.filterable || (!edge && !expressible(meta))) {
      dropped.push(key);
      continue;
    }

    const values = valuesOf(rawValue);

    if (!edge && (PRESENCE_KEYS[dataset] || EMPTY_SET).has(base)) {
      const clause = presenceTerm(field, values);
      if (clause) { groups.push(clause); filtered.add(field); } else dropped.push(key);
      continue;
    }

    const valueMap = (VALUE_ALIASES[dataset] || {})[base] || {};
    const fallback = !edge && (FALLBACK_TERMS[dataset] || {})[base];
    // ONE ENTRY PER WIRE VALUE, whatever it expands to, so the report below counts values that
    // produced no term rather than the spellings each was tried under.
    const terms = values.flatMap((v) => {
      const spellings = spellingsOf(valueMap, v);
      const built = spellings
        .map(spelling => (edge ? rangeTerm(field, meta, spelling, edge) : term(field, meta, spelling)))
        .filter(Boolean);
      if (built.length === 0) return [];
      const extra = fallback && fallback(v, access, filtered);
      if (extra) built.push(extra);
      return [built.length === 1 ? built[0] : `(${built.join(' or ')})`];
    });
    // Reported whenever ANY value was lost, not only when all of them were: `and[pageNumber]=1,0.5`
    // would otherwise narrow silently to `1` and look like the filter the caller asked for.
    if (terms.length !== values.length) dropped.push(key);
    if (terms.length) {
      groups.push(terms.length === 1 ? terms[0] : `(${terms.join(' or ')})`);
      filtered.add(field);
    }
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
      // Named, not ignored: `categorized` routes to the index, and no demi index carries it.
      dropped.push('categorized');
    }
  }

  // A caller who filters on `documentSource` has said which sources they want; a dropped key has not.
  if (dataset === 'Document' && !filtered.has('documentSource')) {
    // Required here, not at the top: document-query loads the documents repository, whose `_sql`
    // requires this module, so a top-level require is a cycle.
    groups.push(require('./document-query').NOT_UPDATE_IMAGE);
  }

  if (acl.filter) groups.push(acl.filter);
  return { filter: groups.length ? groups.join(' and ') : undefined, dropped, fields: [...filtered] };
}

/**
 * Edm types `$orderby` can name: TERM_TYPES plus DateTimeOffset (eagle-public sorts on `datePosted`).
 * Collections and geographies fail membership however their `sortable` flag reads.
 */
const ORDER_TYPES = new Set([...TERM_TYPES, 'Edm.DateTimeOffset']);

function orderable(meta) {
  return ORDER_TYPES.has(meta.type);
}

/**
 * Project routing test: a filter (not `project`) or sort only the INDEX can answer. The fixed Cosmos
 * list read would answer it with the whole corpus under a 200.
 */
function hasCriteria(query) {
  if (filterKeysIn(query).some(key => key !== 'project')) return true;
  return sortEntries(query && query.sortBy).length > 0;
}

/**
 * `$orderby` from any `sortBy` shape (repeated, comma-joined, `+`/`-`); relevance is explicit so `$skip` paging
 * holds (wiki Search-Query-Construction). Returns `{orderby, dropped, fields}`; `fields` omits the id tiebreak.
 */
function buildOrderBy(sortBy, dataset, hasKeywords = false, access) {
  const fields = fieldsFor(dataset);
  const tiebreak = fields.get('id')?.sortable ? 'id asc' : null;

  const raw = sortEntries(sortBy);

  const parts = [];
  const dropped = [];
  const seen = new Set();
  for (const entry of raw) {
    const desc = entry.startsWith('-');
    const name = entry.replace(/^[+-]/, '');
    if (name === 'score') continue;
    const field = sortFieldFor(name, dataset, fields);
    if (!fieldVisible(dataset, field, access)) {
      dropped.push(name);
      continue;
    }

    const meta = fields.get(field);
    // Not in the index, not `sortable`, or a TYPE `$orderby` cannot name (`centroid` is sortable
    // and still a 400): all drop.
    if (!meta || !meta.sortable || !orderable(meta)) {
      dropped.push(name);
      continue;
    }
    // ONE CLAUSE PER FIELD: a repeat cannot change the order and may 400. No clause cap: Azure's is
    // 32 and the widest index has 17 fields.
    if (seen.has(field)) continue;
    seen.add(field);
    parts.push(`${field} ${desc ? 'desc' : 'asc'}`);
  }

  if (parts.length === 0) {
    const askedForRelevance = raw.some(e => e.replace(/^[+-]/, '') === 'score');
    if (askedForRelevance || hasKeywords) {
      // Relevance, made explicit so it can be paged. Without a sortable key there is no tiebreak
      // to add, and an `$orderby` of `search.score() desc` alone is what the service already does.
      return { orderby: tiebreak ? `search.score() desc, ${tiebreak}` : undefined, dropped, fields: [] };
    }
    if (!DEFAULT_ORDER[dataset]) return { orderby: undefined, dropped, fields: [] };
    // Same mapping and visibility gate as the caller's keys: a field they cannot read cannot order
    // their page, and `displayNameSort` exists for the default document order.
    const [defaultName, direction] = DEFAULT_ORDER[dataset].split(' ');
    const defaultField = sortFieldFor(defaultName, dataset, fields);
    if (fieldVisible(dataset, defaultField, access)) {
      parts.push(`${defaultField} ${direction}`);
      seen.add(defaultField);
    }
  }

  // The tiebreak goes through the SAME dedupe as the caller's clauses, or `sortBy=id` emits
  // `id asc, id asc`. `_id` reaches here as `id` too, through the alias table.
  if (tiebreak && !seen.has(tiebreak.split(' ')[0])) parts.push(tiebreak);
  return { orderby: parts.join(', ') || undefined, dropped, fields: [...seen] };
}

/**
 * Sort key → index field: SORT_KEYS, then the filter alias, else the caller's name when the target
 * cannot sort (keeps `sortBy=type` on the label, not the ObjectId its filter alias names).
 */
function sortFieldFor(name, dataset, fields) {
  const target = (SORT_KEYS[dataset] || {})[name] || (ALIASES[dataset] || {})[name];
  if (!target) return name;
  const meta = fields.get(target);
  return meta && meta.sortable ? target : name;
}

/**
 * Cosmos-backed datasets with a project axis; search.js applies `project` itself. Not derivable from
 * `fieldsFor`: they have no index, which reads the same as an index without the field.
 */
const COSMOS_PROJECT_DATASETS = new Set([
  'CommentPeriod', 'RecentActivity', 'Group', 'Inspection', 'InspectionElement', 'InspectionItem'
]);

/**
 * Can a `project` filter be EXPRESSED here (`projects` is its own scope)? A route must never answer
 * around this drop: one project's rows versus every project's is the whole request.
 */
function canScopeToProject(dataset) {
  return COSMOS_PROJECT_DATASETS.has(dataset) || Boolean(fieldsFor(dataset).get('projectId'));
}

/**
 * Every filter key sent, for the fixed-criteria Cosmos reads that apply none: logged by name, since
 * a silently ignored filter looks like one that matched everything.
 */
function filterKeysIn(query) {
  const keys = Array.from(andParams(query || {}), ([key]) => key);
  if (query && query.project) keys.push('project');
  if (query && query.categorized !== undefined) keys.push('categorized');
  // The bare spellings too: they are ACCEPTED parameters, so a branch that does not consume one
  // would otherwise answer 200 with the whole set and say nothing about the filter it ignored.
  for (const key of BARE_FILTER_KEYS) {
    if (query && query[key] !== undefined) keys.push(key);
  }
  return Array.from(new Set(keys));
}

/**
 * Parameters outside KNOWN_PARAMS (a 400). `extra` is one handler's own, e.g. `datasets` on
 * `/search/counts`; adding it to the shared set would make `/search?datasets=` silently ignored.
 */
function unknownParams(query, extra = EMPTY_SET) {
  return Object.keys(query || {}).filter(
    key => !KNOWN_PARAMS.has(key) && !extra.has(key) && key !== 'and' && !/^and\[.+\]$/.test(key)
  );
}

/**
 * The same 400 against an endpoint's OWN list. Unlike `unknownParams` it refuses `and[...]` too,
 * for endpoints that build no filter.
 */
function unsupportedParams(query, allowed) {
  return Object.keys(query || {}).filter(key => !allowed.has(key));
}

/**
 * eagle-public's populated-reference `{_id, name}`. `undefined`, not `{}`: templates read
 * `?.name || '-'`, so absent renders a dash ("none") and `{}` a blank cell ("broken").
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
  // Exported so the drift test can hold it against `repositories/chunks.js` CHUNK_PARENT_FIELDS.
  DOCUMENT_FACETS,
  // Exported for the ratchet tests beside ALIASES: one copy of the dataset -> catalog mapping, so
  // a dataset added here without a catalog entry fails rather than going ungated.
  DATASET_CATALOG,
  SORT_KEYS,
  // Exported beside ALIASES for the ratchet tests: a presence key still has to name a real,
  // filterable, catalogued field.
  PRESENCE_KEYS,
  DEFAULT_ORDER,
  KNOWN_PARAMS,
  buildFilter,
  buildOrderBy,
  hasCriteria,
  unknownParams,
  unsupportedParams,
  // Exported for the controller's 400 and for the tests that pin the two datasets it applies to.
  nameContainsError,
  // The native documents list renders the same name match (search/native-index.js).
  nameContainsClause,
  // The native updates list renders `hasDocumentUrl` with the same null-or-'' test.
  presenceTerm,
  NAME_CONTAINS_FIELDS,
  MAX_NAME_CONTAINS,
  filterKeysIn,
  canScopeToProject,
  andParams,
  // The ONE multi-select splitter. Exported so the Cosmos branches read `a,b` the same way
  // `buildFilter` does — a second copy would let the two paths disagree about one URL.
  valuesOf,
  projectIdsFrom,
  withProjectIds,
  reportDropped,
  ref,
  quote
};
