'use strict';

/**
 * Native lists over Azure AI Search, in two modes. In both the index answers WHICH ROWS MATCH and
 * nothing else; the rows are read back from Cosmos with `id IN (...)`, which applies each record's
 * own field dials, so a value one record hides cannot be read through the index.
 *
 * Ranked mode (projects, activities, notifications): a `q=` list reads at most `ID_PAGE` ranked
 * ids and pages them in memory, so its total is capped there. A list with no `q` stays on Cosmos.
 * These indexes carry dials only as an unfilterable string, so a filter or sort on a field one
 * record hides is re-checked in Cosmos on the whole id set.
 *
 * Paged mode (documents): the index pages and counts itself (`skip`, `top`, `@odata.count`), in one
 * request for list and count, so totals are not capped. It serves every list except the few the map
 * sends to Cosmos (`cosmosServes`), cross-project lists without `q` included. With no sort, a `q`
 * list ranks by relevance and any other takes the map's default order, each then by `id`. Its
 * `searchVis` column is the lowest dial over the searched fields, so a keyword cannot count a row
 * whose searched field the caller may not see. Filter fields carry no dial in the index; Cosmos re-checks them on the
 * page only, which is latent while no route writes document dials.
 */

const aiSearch = require('./ai-search');
const { documentsAcl, NOT_UPDATE_IMAGE } = require('./document-query');
const { filterFor, inClause, quote } = require('../helpers/access-odata');
const { nativeCriteria, dialAllows, rangeBound, cosmosKind } = require('../helpers/native-query');
const { inList, selectWhere, selectFor, fetchAll } = require('../repositories/_sql');
const { NAME_CONTAINS_FIELDS, nameContainsClause, presenceTerm } = require('./eagle-query');
const { levelOf } = require('../vis/level');
const { PROJECT_TO_INDEX } = require('../vis/catalog/index-projects-renames');
const updates = require('../repositories/updates');
const { logger } = require('../utils/logger');

/** Most ranked ids one keyword list reads: one service request, never a second. */
const ID_PAGE = aiSearch.SERVICE_MAX_TOP;

/** The stored fields an index column is built from, from the data source's rename map. */
function sourcesOf(renames, column) {
  const sources = Object.keys(renames).filter(field => renames[field].includes(column));
  return sources.length ? sources : [column];
}

// A `<field>Tokens` column is its field again under the filename analyzer (data sources).
const TOKEN_TWINS = Object.freeze({ nameTokens: 'name', fileNameTokens: 'documentFileName' });

/** The stored fields behind an index's `searchFields` list. */
function searchedOf(searchFields) {
  return [...new Set(searchFields.split(',').map(column => TOKEN_TWINS[column] || column))];
}

const keywordSearched = dataset => searchedOf(aiSearch.KEYWORD_INDEXES[dataset].searchFields);

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * The `activities` index filter for this caller, for the native list and `controllers/search.js`:
 * role ACL and project scope in the Eagle id space the index holds, the parent gate, and the
 * publish gate `updates.liveCriteria` applies to the container.
 */
async function updatesIndexAcl(access) {
  const acl = filterFor(await updates.inEagleIdSpace(access), 'projectId');
  if (acl.empty) return acl;
  const clauses = acl.filter ? [`(${acl.filter})`] : [];
  // The repository's parent gate, so the index's count cannot describe rows the page will not hold.
  const hidden = await updates.hiddenParentIds(access);
  // `inClause` quotes each id: a stored id is data, and a quote in one must not rewrite the filter.
  if (hidden.length) clauses.push(`not ${inClause('projectId', hidden)}`);
  if (updates.isLiveGated(access)) {
    const now = new Date().toISOString();
    // On `publishDate` alone, as updates.liveCriteria: a gated row without one stays hidden.
    clauses.push(`(status eq null or (status eq ${quote(updates.PUBLISHED)} and publishDate le ${now}))`);
  }
  return { ...acl, filter: clauses.length ? clauses.join(' and ') : acl.filter };
}

/**
 * Per index: how its search runs, which column carries project identity for the ACL (or an `acl`
 * that builds it), and the native filter field -> filterable index column. A filter with no column
 * here still narrows in Cosmos; mapping it only spends the id page on rows that can match.
 * `collections` is the same for an `anyOf` filter, onto a Collection(Edm.String) column.
 *
 * `searched` is every native field the keyword matches against. A row is a keyword hit only when
 * the caller may see all of them, because which field matched is not reported back.
 */
const INDEX_MAPS = Object.freeze({
  projects: {
    search: opts => aiSearch.searchProjects(opts),
    partitionField: 'id',
    columns: {
      projectType: 'type',
      region: 'region',
      projectState: 'status',
      proponentName: 'proponent',
      'eacDecision._id': 'eacDecisionId',
      'currentPhaseName._id': 'currentPhaseNameId',
      'CEAAInvolvement._id': 'ceaaInvolvementId',
      decisionDate: 'decisionDate',
      sector: 'sector',
      dateUpdated: 'dateUpdated'
    },
    collections: { phaseIds: 'phaseIds' },
    types: { decisionDate: 'date', dateUpdated: 'date' },
    // Matched in the index so a hit ranked past the id page is not lost; Cosmos still re-checks it.
    contains: { name: NAME_CONTAINS_FIELDS.Project },
    searched: [...new Set(aiSearch.PROJECT_SEARCH_FIELDS.split(',')
      .flatMap(column => sourcesOf(PROJECT_TO_INDEX, column)))]
  },
  activities: {
    search: opts => aiSearch.searchActivities(opts),
    partitionField: 'projectId',
    acl: updatesIndexAcl,
    columns: { projectId: 'projectId', type: 'type', dateAdded: 'dateAdded', documentUrl: 'documentUrl' },
    types: { dateAdded: 'date' },
    searched: keywordSearched('activities')
  },
  // No project axis, like `notifications.SCOPE_FIELD`: role ACL is the whole filter.
  'project-notifications': {
    search: opts => aiSearch.searchNotifications(opts),
    partitionField: null,
    columns: { type: 'type', region: 'region', pcp: 'pcp', decision: 'decision' },
    searched: keywordSearched('notifications')
  },
  // Paged mode. `types` names columns whose values go unquoted; `sorts` is sort key -> column;
  // `contains` is a text filter's field -> the searchable columns its words must match in.
  documents: {
    paged: true,
    search: opts => aiSearch.searchDocumentIds(opts),
    partitionField: 'projectId',
    acl: documentsAcl,
    always: [NOT_UPDATE_IMAGE],
    searchVis: 'searchVis',
    columns: {
      projectId: 'projectId',
      typeId: 'typeId',
      milestoneId: 'milestoneId',
      projectPhaseId: 'projectPhaseId',
      documentAuthorTypeId: 'documentAuthorTypeId',
      isFeatured: 'isFeatured',
      legislation: 'legislation',
      documentSource: 'documentSource',
      datePosted: 'datePosted'
    },
    types: { isFeatured: 'boolean', legislation: 'int', datePosted: 'date' },
    sorts: {
      datePosted: 'datePosted',
      displayName: 'displayNameSort',
      sortOrder: 'sortOrder',
      type: 'type',
      milestone: 'milestone',
      projectPhase: 'projectPhase',
      documentAuthorType: 'documentAuthorType',
      isPublished: 'isPublished',
      legislation: 'legislation',
      isFeatured: 'isFeatured',
      documentAuthor: 'documentAuthorSort'
    },
    contains: { displayName: NAME_CONTAINS_FIELDS.Document },
    // Most rows hold sortOrder 0, so the staff order falls back to newest first, then by name.
    tiebreaks: { sortOrder: 'datePosted desc, displayNameSort asc' },
    defaultOrderby: 'datePosted desc',
    // Cosmos indexes no `datePosted` or `displayName` and cannot compare typed values the query
    // carries as strings, so it serves only one project's plain list and an `ids=` read. A name
    // match goes to the index too, which matches word prefixes where Cosmos would match a substring.
    cosmosServes: parsed => !parsed.q && !parsed.sort && !typedFilter(INDEX_MAPS.documents, parsed) &&
      !Object.keys(parsed.contains || {}).length &&
      Boolean(parsed.ids || (parsed.filters && parsed.filters.projectId)),
    searched: searchedOf(aiSearch.DOCUMENT_SEARCH_FIELDS)
  }
});

/** A filter or range on a column whose index type is not a string. */
function typedFilter(map, parsed) {
  const types = map.types || {};
  return Object.keys(parsed.filters || {}).some(field => types[field]) || (parsed.ranges || []).length > 0;
}

// Unquoted literals, so each value is checked against its type before any clause is built:
// `legislation=1) or (true` would otherwise close the ACL's parenthesis and void it.
const LITERALS = Object.freeze({
  boolean: value => (value === 'true' || value === 'false' ? value : null),
  int: value => (/^\d{1,4}$/.test(value) ? String(Number(value)) : null),
  date: value => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null)
});

/** Every typed value as its OData literal; throws a 400 on the first one its type refuses. */
function typedLiterals(map, parsed) {
  const types = map.types || {};
  const literal = (field, value) => {
    const rendered = LITERALS[types[field]](String(value));
    if (rendered === null) throw badRequest(`${field} cannot take ${JSON.stringify(String(value))}`);
    return rendered;
  };
  const filters = {};
  for (const [field, values] of Object.entries(parsed.filters || {})) {
    if (!types[field]) continue;
    if (types[field] === 'date') throw badRequest(`${field} takes a range, not a value`);
    if (types[field] === 'boolean' && values.length !== 1) throw badRequest(`${field} takes one value`);
    filters[field] = values.map(value => literal(field, value));
  }
  const ranges = (parsed.ranges || []).map(({ field, op, value }) => {
    if (types[field] !== 'date' || !map.columns[field]) throw badRequest(`cannot filter on a range of ${field}`);
    return `${map.columns[field]} ${op} ${rangeBound(op, literal(field, value))}`;
  });
  return { filters, ranges };
}

/**
 * The twin of `andClauses` (helpers/access-sql.js) for OData: absent clauses are dropped and every
 * one kept is parenthesised, so a clause holding `or` cannot bind across its neighbours. No clause
 * at all is null, which `runSearch` reads as unrestricted. OData has no `false`; a caller that can
 * match nothing must never reach here (see `indexFilter`).
 */
function andOData(...clauses) {
  const parts = clauses.filter(Boolean);
  return parts.length ? parts.map(part => `(${part})`).join(' and ') : null;
}

/**
 * The index `$filter` for this caller and parsed query: the ACL, the map's fixed clauses, `searchVis`
 * when there is a keyword, then the mapped filters, any-of filters, ranges, presence tests and `ids=`. `{ filter: null, empty: true }`
 * means the caller can match nothing and no request may be sent; `filter: null` with `empty: false`
 * is unrestricted. Throws a 400 for a typed value its column refuses, and in paged mode for a filter,
 * any-of filter or presence test with no column or any flag, before any clause is built.
 */
function indexFilter(map, parsed, access, acl = filterFor(access, map.partitionField)) {
  const typed = typedLiterals(map, parsed);
  if (map.paged) {
    // Every flag is refused: the index has no flag clause, so a page re-read would drop rows the count still holds.
    const unmapped = Object.keys({ ...parsed.filters, ...parsed.presence }).find(field => !map.columns[field]) ||
      Object.keys(parsed.anyOf || {}).find(field => !(map.collections || {})[field]) ||
      Object.keys(parsed.flags || {})[0];
    if (unmapped) throw badRequest(`cannot filter on ${unmapped} here`);
    // The page re-read drops CONTAINS, so a text filter the index cannot match would vanish.
    const unmatched = Object.keys(parsed.contains || {}).find(field => !(map.contains || {})[field]);
    if (unmatched) throw badRequest(`cannot match text in ${unmatched} here`);
  }
  if (acl.empty) return { filter: null, empty: true };

  const clauses = [acl.filter, ...(map.always || [])];
  if (map.searchVis && parsed.q) clauses.push(`${map.searchVis} ge ${levelOf(access)}`);
  for (const [field, values] of Object.entries(parsed.filters || {})) {
    const column = map.columns[field];
    if (!column) continue;
    if (typed.filters[field]) {
      const terms = typed.filters[field].map(value => `${column} eq ${value}`);
      clauses.push(terms.length === 1 ? terms[0] : `(${terms.join(' or ')})`);
    } else {
      clauses.push(values.length === 1 ? `${column} eq ${quote(values[0])}` : inClause(column, values));
    }
  }
  for (const [field, values] of Object.entries(parsed.anyOf || {})) {
    const column = (map.collections || {})[field];
    if (column) clauses.push(`${column}/any(p: ${inClause('p', values)})`);
  }
  clauses.push(...typed.ranges);
  for (const [field, text] of Object.entries(parsed.contains || {})) {
    const columns = (map.contains || {})[field];
    if (!columns) continue;
    // Punctuation alone leaves no word, and a clause over no terms is a 400 from the service.
    const lucene = aiSearch.buildContainsQuery(text);
    if (lucene) clauses.push(nameContainsClause(columns, lucene));
  }
  // Cosmos re-reads presence as well, so a row the index lags on cannot slip through.
  for (const [field, present] of Object.entries(parsed.presence || {})) {
    if (map.columns[field]) clauses.push(presenceTerm(map.columns[field], [String(present)]));
  }
  if (parsed.ids) clauses.push(inClause('id', parsed.ids));
  return { filter: andOData(...clauses), empty: false };
}

/**
 * `$orderby` for paged mode: the sort column and its `tiebreaks` entry, else relevance with `q`,
 * else the map's default; then `id` so pages never overlap.
 */
function indexOrderby(map, parsed) {
  if (!parsed.sort) return `${parsed.q ? 'search.score() desc' : map.defaultOrderby}, id`;
  const column = map.sorts[parsed.sort.field];
  if (!column) throw badRequest(`cannot sort on ${parsed.sort.field} here`);
  const tiebreak = (map.tiebreaks || {})[parsed.sort.field];
  return `${column} ${parsed.sort.desc ? 'desc' : 'asc'}, ${tiebreak ? `${tiebreak}, ` : ''}id`;
}

/** Every searched field visible to this caller on the row's own dials. */
function searchedVisible(map, access) {
  const level = levelOf(access);
  return { clause: map.searched.map(field => dialAllows(field, level)).join(' AND '), params: [] };
}

/**
 * A kind spec repository (`controllers/nosql/mirror-reads.js`) that answers `q=` lists from the
 * index and everything else from `cosmosKind` over the same container.
 *
 * `store` replaces `cosmosKind` for a container whose reads carry gates of their own (updates):
 * the kind's native repository plus `readAll(access, {criteria, orderBy})`, the unpaged read-back.
 */
function indexedKind({ index, container, entity, partitionField, defaultOrder, store: given, baseCriteria = [] }) {
  const map = INDEX_MAPS[index];
  if (!map) throw new Error(`[native-index] no field map for index ${index}`);
  const store = given || cosmosKind({ container, entity, partitionField, defaultOrder });
  const readAll = given ? given.readAll : (access, { criteria, orderBy }) => fetchAll(container, selectWhere({
    access, partitionField, criteria, select: selectFor(entity, access, partitionField), orderBy
  }));

  async function readMatches(access, parsed) {
    const { filter, empty } = indexFilter(map, parsed, access, map.acl ? await map.acl(access) : undefined);
    if (empty) return [];

    const top = Number.isInteger(parsed.idPage) && parsed.idPage > 0
      ? Math.min(parsed.idPage, ID_PAGE)
      : ID_PAGE;
    const { items } = await map.search({ keywords: parsed.q, filter, top });
    const ranked = [...new Set(items.map(hit => String(hit.id)))];
    if (ranked.length === 0) return [];

    // `q: null`: the index matched the keyword; Cosmos must not re-match it with CONTAINS.
    const { criteria, orderBy } = nativeCriteria({}, { ...parsed, q: null }, access);
    const rows = await readAll(access, {
      criteria: [...baseCriteria, ...criteria, inList('id', ranked, '@xid'), searchedVisible(map, access)],
      orderBy
    });
    if (orderBy) return rows;
    const rank = new Map(ranked.map((id, i) => [id, i]));
    return rows.sort((a, b) => rank.get(String(a.id)) - rank.get(String(b.id)));
  }

  /**
   * Paged mode: one index request pages and counts. The page's ids are re-read with their string
   * filters and dials; a typed filter or range re-checks only its dial, because the index matched
   * the value and the query holds it as a string. No ORDER BY: rows take the index's order.
   */
  async function readPage(access, parsed) {
    if (parsed.pageSize > aiSearch.MAX_PAGE_ROWS) {
      throw badRequest(`pageSize takes at most ${aiSearch.MAX_PAGE_ROWS} on this list`);
    }
    const orderby = indexOrderby(map, parsed);
    const { filter, empty } = indexFilter(map, parsed, access, map.acl ? await map.acl(access) : undefined);
    if (empty) return { rows: [], count: 0 };

    const { ids, count } = await map.search({
      keywords: parsed.q, filter, orderby, top: parsed.pageSize, skip: parsed.pageNum * parsed.pageSize
    });
    if (ids.length === 0) return { rows: [], count };

    const types = map.types || {};
    const level = levelOf(access);
    const plain = Object.fromEntries(Object.entries(parsed.filters).filter(([field]) => !types[field]));
    // `contains: {}` as `q: null`: the index matched the words, so Cosmos re-checks only their dials.
    const { criteria } = nativeCriteria({}, {
      ...parsed, q: null, sort: null, filters: plain, ranges: [], contains: {}
    }, access);
    const dialOnly = [...new Set([
      ...Object.keys(parsed.filters).filter(field => types[field]),
      ...(parsed.ranges || []).map(range => range.field),
      ...Object.keys(parsed.contains || {}).flatMap(field => searchedOf(map.contains[field].join(',')))
    ])].map(field => ({ clause: dialAllows(field, level), params: [] }));

    const rows = await readAll(access, {
      criteria: [
        ...baseCriteria, ...criteria, ...dialOnly, inList('id', ids, '@xid'),
        ...(parsed.q ? [searchedVisible(map, access)] : [])
      ]
    });
    if (rows.length < ids.length) {
      // Index lag or a dial on a filter field; the page is short, never wider.
      logger.warn(`[native-index] ${index} page re-read held fewer rows than the index returned`, {
        index, ids: ids.length, rows: rows.length
      });
    }
    const rank = new Map(ids.map((id, i) => [id, i]));
    return { rows: rows.sort((a, b) => rank.get(String(a.id)) - rank.get(String(b.id))), count };
  }

  // list and count of one request get the same `parsed`, so they share one index and Cosmos read.
  const reads = new WeakMap();
  function matches(access, parsed) {
    if (!reads.has(parsed)) reads.set(parsed, map.paged ? readPage(access, parsed) : readMatches(access, parsed));
    return reads.get(parsed);
  }
  const usesIndex = ({ parsed } = {}) => Boolean(parsed && (map.paged ? !map.cosmosServes(parsed) : parsed.q));
  const withBase = args => (baseCriteria.length ? { ...args, criteria: [...baseCriteria, ...args.criteria] } : args);

  return {
    ...store,
    async list(access, args) {
      if (!usesIndex(args)) return store.list(access, withBase(args));
      if (map.paged) return (await matches(access, args.parsed)).rows;
      const start = args.pageNum * args.pageSize;
      return (await matches(access, args.parsed)).slice(start, start + args.pageSize);
    },
    async count(access, args) {
      if (!usesIndex(args)) return store.count(access, withBase(args));
      if (map.paged) return (await matches(access, args.parsed)).count;
      return (await matches(access, args.parsed)).length;
    }
  };
}

module.exports = { ID_PAGE, INDEX_MAPS, andOData, indexFilter, indexedKind, updatesIndexAcl };
