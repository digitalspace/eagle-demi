'use strict';

/**
 * Keyword (`q=`) reads for the native list contract, over Azure AI Search.
 *
 * The index answers WHICH ROWS MATCH, ranked, and nothing else; the rows themselves are read back
 * from Cosmos with `id IN (...)` plus the same criteria a Cosmos list builds. The index cannot do
 * that part: it carries a record's own field dials only as an unfilterable string (`vis`,
 * `ToString(c.vis)` in the data source), so a filter, sort or keyword on a field one record hides
 * would still match and count it. Cosmos applies the dials, so a hidden value cannot be probed.
 *
 * A list with no `q` stays on Cosmos: the index would only hand back the ACL-filtered id set,
 * which Cosmos computes itself.
 *
 * KNOWN LIMIT: a keyword list holds at most `ID_PAGE` rows, so its total is capped there too.
 */

const aiSearch = require('./ai-search');
const { filterFor, inClause, quote } = require('../helpers/access-odata');
const { nativeCriteria, dialAllows, cosmosKind } = require('../helpers/native-query');
const { inList, selectWhere, selectFor, fetchAll } = require('../repositories/_sql');
const { levelOf } = require('../vis/level');
const { PROJECT_TO_INDEX } = require('../vis/catalog/index-projects-renames');
const updates = require('../repositories/updates');

/** Most ranked ids one keyword list reads: one service request, never a second. */
const ID_PAGE = aiSearch.SERVICE_MAX_TOP;

/** The stored fields an index column is built from, from the data source's rename map. */
function sourcesOf(renames, column) {
  const sources = Object.keys(renames).filter(field => renames[field].includes(column));
  return sources.length ? sources : [column];
}

/** The stored fields behind a keyword index's `searchFields`; `nameTokens` is `name` (data source). */
function keywordSearched(dataset) {
  const columns = aiSearch.KEYWORD_INDEXES[dataset].searchFields.split(',');
  return [...new Set(columns.map(column => (column === 'nameTokens' ? 'name' : column)))];
}

/**
 * The `activities` ACL as `controllers/search.js` updatesIndexAcl builds it: scope in the Eagle id
 * space the index holds, the parent gate, and the publish gate. The Cosmos read-back applies all
 * three again; here they keep hidden rows from filling the id page.
 */
async function updatesAcl(access) {
  const acl = filterFor(await updates.inEagleIdSpace(access), 'projectId');
  if (acl.empty) return acl;
  const hidden = await updates.hiddenParentIds(access);
  const live = updates.isLiveGated(access)
    ? `status eq null or (status eq ${quote(updates.PUBLISHED)} and publishDate le ${new Date().toISOString()})`
    : null;
  return { filter: andOData(acl.filter, hidden.length ? `not ${inClause('projectId', hidden)}` : null, live), empty: false };
}

/**
 * Per index: how its search runs, which column carries project identity for the ACL (or an `acl`
 * that builds it), and the native filter field -> filterable index column. A filter with no column
 * here still narrows in Cosmos; mapping it only spends the id page on rows that can match.
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
      proponentName: 'proponent'
    },
    searched: [...new Set(aiSearch.PROJECT_SEARCH_FIELDS.split(',')
      .flatMap(column => sourcesOf(PROJECT_TO_INDEX, column)))]
  },
  activities: {
    search: opts => aiSearch.searchActivities(opts),
    partitionField: 'projectId',
    acl: updatesAcl,
    columns: { projectId: 'projectId', type: 'type' },
    searched: keywordSearched('activities')
  },
  // No project axis, like `notifications.SCOPE_FIELD`: role ACL is the whole filter.
  'project-notifications': {
    search: opts => aiSearch.searchNotifications(opts),
    partitionField: null,
    columns: { type: 'type', region: 'region', pcp: 'pcp', decision: 'decision' },
    searched: keywordSearched('notifications')
  }
});

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
 * The index `$filter` for this caller and parsed query: the ACL, then the mapped filters and `ids=`.
 * `{ filter: null, empty: true }` means the caller can match nothing and no request may be sent;
 * `filter: null` with `empty: false` is unrestricted.
 */
function indexFilter(map, parsed, access, acl = filterFor(access, map.partitionField)) {
  if (acl.empty) return { filter: null, empty: true };

  const clauses = [acl.filter];
  for (const [field, values] of Object.entries(parsed.filters || {})) {
    const column = map.columns[field];
    if (!column) continue;
    clauses.push(values.length === 1 ? `${column} eq ${quote(values[0])}` : inClause(column, values));
  }
  if (parsed.ids) clauses.push(inClause('id', parsed.ids));
  return { filter: andOData(...clauses), empty: false };
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
function indexedKind({ index, container, entity, partitionField, defaultOrder, store: given }) {
  const map = INDEX_MAPS[index];
  if (!map) throw new Error(`[native-index] no field map for index ${index}`);
  const store = given || cosmosKind({ container, entity, partitionField, defaultOrder });
  const readAll = given ? given.readAll : (access, { criteria, orderBy }) => fetchAll(container, selectWhere({
    access, partitionField, criteria, select: selectFor(entity, access, partitionField), orderBy
  }));

  async function readMatches(access, parsed) {
    const { filter, empty } = indexFilter(map, parsed, access, map.acl ? await map.acl(access) : undefined);
    if (empty) return [];

    const { items } = await map.search({ keywords: parsed.q, filter, top: ID_PAGE });
    const ranked = [...new Set(items.map(hit => String(hit.id)))];
    if (ranked.length === 0) return [];

    // `q: null`: the index matched the keyword; Cosmos must not re-match it with CONTAINS.
    const { criteria, orderBy } = nativeCriteria({}, { ...parsed, q: null }, access);
    const rows = await readAll(access, {
      criteria: [...criteria, inList('id', ranked, '@xid'), searchedVisible(map, access)],
      orderBy
    });
    if (orderBy) return rows;
    const rank = new Map(ranked.map((id, i) => [id, i]));
    return rows.sort((a, b) => rank.get(String(a.id)) - rank.get(String(b.id)));
  }

  // list and count of one request get the same `parsed`, so they share one index and Cosmos read.
  const reads = new WeakMap();
  function matches(access, parsed) {
    if (!reads.has(parsed)) reads.set(parsed, readMatches(access, parsed));
    return reads.get(parsed);
  }
  const usesIndex = args => Boolean(args && args.parsed && args.parsed.q);

  return {
    ...store,
    async list(access, args) {
      if (!usesIndex(args)) return store.list(access, args);
      const start = args.pageNum * args.pageSize;
      return (await matches(access, args.parsed)).slice(start, start + args.pageSize);
    },
    async count(access, args) {
      if (!usesIndex(args)) return store.count(access, args);
      return (await matches(access, args.parsed)).length;
    }
  };
}

module.exports = { ID_PAGE, INDEX_MAPS, andOData, indexFilter, indexedKind };
