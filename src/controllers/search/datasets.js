'use strict';

const { pageSizeFor } = require('../../helpers/access-sql');
const eagleQuery = require('../../search/eagle-query');
const commentPeriodsRepo = require('../../repositories/comment-periods');
const commentsRepo = require('../../repositories/comments');
const notificationsRepo = require('../../repositories/notifications');
const listsRepo = require('../../repositories/lists');
const updatesRepo = require('../../repositories/updates');
const {
  filterValue,
  filterValues,
  activityWindow,
  documentFilter,
  stripLimit
} = require('./params');
const { cosmosRows, updateResults, notificationRows, commentRows } = require('./cosmos-rows');
const { openPeriods, periodKeywords, periodList, periodSortDropped, periodRows } = require('./periods');

/**
 * The Cosmos-backed `/search` datasets, each answering `{searchResults, count}`. `applied` names the
 * keys consumed; every other key is reported dropped, so a filter that did nothing is visible.
 */
const COSMOS_DATASETS = {
  /** Every lookup row. eagle-public asks for all 250-odd in one page and resolves ids client-side. */
  List: (ctx) => listRows(ctx, listsRepo.KINDS.LIST),

  /** The proponent / certificate-holder picker: `companyType=` in either wire shape, `sortBy=+name`. */
  Organization: (ctx) => listRows(ctx, listsRepo.KINDS.ORGANIZATION),

  async CommentPeriod({ access, query, filterQuery, pageNum, pageSize, sortBy }) {
    const id = filterValue(query, '_id');
    if (id) {
      const row = await commentPeriodsRepo.getById(access, id);
      const searchResults = await periodRows(access, row ? [row] : []);
      return { searchResults, count: searchResults.length, applied: ['_id'] };
    }

    // `filterQuery`, NOT `query`: `commentPeriods.projectId` holds the DEMI id (or a notification's
    // id), so it needs the ids `resolveProjectFilter` translated.
    const [projectId] = eagleQuery.projectIdsFrom(filterQuery);

    const statuses = filterValues(query, 'status');
    // REFUSED, never answered. An unrecognised status falling through would hand back the whole
    // corpus under a 200, which reads exactly like "every period matches your filter".
    if (statuses !== null && statuses.length > 1) {
      return { error: `and[status] takes one value, not ${statuses.join(', ')}` };
    }
    const status = statuses === null ? null : (statuses[0] || '');
    if (status !== null && !commentPeriodsRepo.STATUSES.includes(status)) {
      return {
        error: `and[status] must be one of ${commentPeriodsRepo.STATUSES.join(', ')}, not '${status}'`
      };
    }
    const sortDropped = periodSortDropped(sortBy);

    // A project filter keeps the per-project read below and reports `status` as dropped.
    if (!projectId) {
      const capped = pageSizeFor(access, pageSize);
      if (capped.error) return { error: capped.error };
      const keywords = periodKeywords(query.keywords || query.q);
      // The home rail sends none of these; the search tab always sends `sortBy` and `pageNum`.
      const rail = query.sortBy === undefined && query.pageNum === undefined && !keywords;
      if (status === 'open' && rail) return openPeriods({ access, pageSize: capped.pageSize });
      return {
        ...await periodList({ access, keywords, status, pageNum, pageSize: capped.pageSize, sortBy }),
        sortDropped
      };
    }

    const [rows, count] = await Promise.all([
      commentPeriodsRepo.listByProject(projectId, access, { pageNum, pageSize, sortBy }),
      commentPeriodsRepo.countByProject(projectId, access)
    ]);
    return { searchResults: await periodRows(access, rows), count, applied: ['project'], sortDropped };
  },

  async Comment({ access, query, pageNum, pageSize, sortBy }) {
    const id = filterValue(query, '_id');
    if (id) {
      const row = await commentsRepo.getById(access, id);
      return { searchResults: commentRows(access, row ? [row] : []), count: row ? 1 : 0, applied: ['_id'] };
    }

    const periodId = filterValue(query, 'period');
    if (!periodId) {
      // REFUSED, not answered empty: `comments` is partitioned by period and every caller has one.
      // An empty 200 here would read as "this period has no comments".
      return { error: 'dataset=Comment requires and[period]=<id> or _id' };
    }

    // Eagle's moderation filter. An unknown state is REFUSED: dropping it would answer every comment.
    const eaoStatuses = filterValues(query, 'eaoStatus');
    const unknownStatus = (eaoStatuses || []).filter(v => !commentsRepo.EAO_STATUSES.includes(v));
    if (unknownStatus.length) {
      return { error: `and[eaoStatus] must be one of ${commentsRepo.EAO_STATUSES.join(', ')}, not ${unknownStatus.join(', ')}` };
    }

    const [rows, count] = await Promise.all([
      commentsRepo.listByPeriod(periodId, access, { pageNum, pageSize, sortBy, eaoStatuses }),
      // The total for the WHOLE period under the same filter, which eagle-public pages against.
      commentsRepo.countByPeriod(periodId, access, { eaoStatuses })
    ]);
    return {
      searchResults: commentRows(access, rows),
      count,
      applied: ['period', ...(eaoStatuses !== null ? ['eaoStatus'] : [])]
    };
  },

  async RecentActivity({ access, query, pageNum, pageSize, sortBy }) {
    // A POINT READ on the `/id` partition: eagle-public's `/updates/:id` route, opened cold.
    const id = filterValue(query, '_id');
    if (id) {
      const row = await updatesRepo.getById(access, id);
      const searchResults = await updateResults(access, row ? [row] : []);
      return { searchResults, count: searchResults.length, applied: ['_id'] };
    }

    if (String(query.top) === 'true') {
      const { limit, error } = stripLimit(query);
      if (error) return { error };
      const searchResults = await updateResults(access, await updatesRepo.listTop(access, { limit }));
      // The count IS the answer here, not a page of a larger set: `listTop` returns the whole strip.
      return { searchResults, count: searchResults.length, applied: ['top'] };
    }

    // `query`, NOT `filterQuery`: `updates.projectId` holds the EAGLE project id, so the translated
    // DEMI id would match nothing.
    const [projectId] = eagleQuery.projectIdsFrom(query);
    // Keywords reach here only when the index is off: the repository answers with an unranked
    // CONTAINS substring match.
    const keywords = query.keywords || query.q || '';
    const types = filterValues(query, 'type');
    // The same filters the `activities` index applies to a keyword search, so both pages narrow alike.
    const { hasDocument, applied: documentApplied } = documentFilter(query);
    const { dateAddedFrom, dateAddedBefore, applied: windowApplied } = activityWindow(query);

    const criteria = { projectId, keywords, types, hasDocument, dateAddedFrom, dateAddedBefore };
    const [rows, count] = await Promise.all([
      updatesRepo.list(access, { ...criteria, pageNum, pageSize, sortBy }),
      // The SAME criteria as the page: a total built from a looser predicate describes rows the
      // page cannot hold, and eagle-public pages against it.
      updatesRepo.count(access, criteria)
    ]);
    return {
      searchResults: await updateResults(access, rows),
      count,
      // `!== null`, not truthy: `and[type]=` sent empty gives `[]`, a key SEEN with nothing to
      // narrow by, not one the container could not apply.
      applied: [
        ...(projectId ? ['project'] : []),
        ...(types !== null ? ['type'] : []),
        ...documentApplied,
        ...windowApplied
      ]
    };
  },

  async ProjectNotification({ access, query, pageNum, pageSize, sortBy }) {
    const id = filterValue(query, '_id');
    if (id) {
      const row = await notificationsRepo.getById(access, id);
      return {
        searchResults: await notificationRows(access, row ? [row] : []),
        count: row ? 1 : 0,
        applied: ['_id']
      };
    }

    const applied = [];
    const filters = {};
    for (const key of Object.keys(notificationsRepo.FILTERS)) {
      const value = filterValue(query, key);
      if (value !== null) {
        filters[key] = value;
        applied.push(key);
      }
    }

    const [rows, count] = await Promise.all([
      notificationsRepo.list(access, { ...filters, pageNum, pageSize, sortBy }),
      notificationsRepo.count(access, filters)
    ]);
    return {
      searchResults: await notificationRows(access, rows),
      count,
      applied
    };
  }
};
/** Test seam: the `_id` suite walks every dataset, so a new one cannot skip the point read. */
exports.COSMOS_DATASET_NAMES = Object.freeze(Object.keys(COSMOS_DATASETS));

/** `List` and `Organization`: one container, one handler, told apart by `kind`. */
async function listRows({ access, query, pageNum, pageSize, sortBy }, kind) {
  const id = filterValue(query, '_id');
  if (id) {
    const row = await listsRepo.getById(access, id, kind);
    const rows = row ? [row] : [];
    return { searchResults: cosmosRows('lists', rows, access, kind, listRow), count: rows.length, applied: ['_id'] };
  }

  const applied = [];
  const filters = {};
  for (const key of Object.keys(listsRepo.FILTERS)) {
    const value = filterValue(query, key);
    if (value !== null) {
      filters[key] = value;
      applied.push(key);
    }
  }

  const opts = { ...filters, pageNum, pageSize, sortBy };
  const [rows, count] = await Promise.all([
    listsRepo.listByKind(kind, access, opts),
    listsRepo.countByKind(kind, access, filters)
  ]);
  return { searchResults: cosmosRows('lists', rows, access, kind, listRow), count, applied };
}

/**
 * eagle-public compares `legislation === 2002`, so a year stored as a string matches nothing.
 * Coerced on read so rows already stored need no re-run of the backfill.
 */
function listRow(row) {
  if (row.legislation === undefined || row.legislation === null || row.legislation === '') return {};
  const year = Number(row.legislation);
  return Number.isFinite(year) ? { legislation: year } : {};
}

exports.COSMOS_DATASETS = COSMOS_DATASETS;
