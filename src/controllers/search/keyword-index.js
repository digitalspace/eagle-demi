'use strict';

const { logger } = require('../../utils/logger');
const { filterFor } = require('../../helpers/access-odata');
const aiSearch = require('../../search/ai-search');
const eagleQuery = require('../../search/eagle-query');
const { updatesIndexAcl } = require('../../search/native-index');
const notificationsRepo = require('../../repositories/notifications');
const updatesRepo = require('../../repositories/updates');
const { filterValue } = require('./params');
const { updateResults, notificationRows } = require('./cosmos-rows');

/**
 * The two Cosmos datasets whose KEYWORD search the index ranks. Rows are read back from Cosmos
 * through the keywordless mapper, so the wire shape cannot drift and a stale index hit drops out.
 */
const KEYWORD_INDEX_DATASETS = {
  RecentActivity: {
    index: () => aiSearch.config().activitiesIndex,
    search: (opts) => aiSearch.searchActivities(opts),
    // `?top=true` (the home strip, ordered by pinned-ness) and `and[_id]` (a point read) stay Cosmos
    // reads whatever else the caller sent.
    cosmosOnly: (query) => String(query.top) === 'true' || filterValue(query, '_id') !== null,
    // `updates.projectId` holds the EAGLE id, so filter on the UNTRANSLATED ids, flattened onto
    // `project`, the one form `buildFilter` applies.
    indexQuery: (query) => eagleQuery.withProjectIds(query, eagleQuery.projectIdsFrom(query)),
    acl: updatesIndexAcl,
    rows: async (access, ids) => {
      return updateResults(access, inIdOrder(await updatesRepo.listByIds(access, ids), ids));
    }
  },
  ProjectNotification: {
    index: () => aiSearch.config().notificationsIndex,
    search: (opts) => aiSearch.searchNotifications(opts),
    // `and[_id]` is a point read of one record, and the keywords say nothing about which one.
    cosmosOnly: (query) => filterValue(query, '_id') !== null,
    indexQuery: (query) => query,
    // NULL, like `notifications.SCOPE_FIELD`: a notification is not project data, so there is no
    // project axis to narrow on and role ACL is the whole filter.
    acl: async (access) => filterFor(access, null),
    rows: async (access, ids) => notificationRows(access,
      inIdOrder(await notificationsRepo.listByIds(access, ids, { full: true }), ids))
  }
};

/** Cosmos answers a named set in its own order; the ranking the index computed is the one to keep. */
function inIdOrder(rows, ids) {
  const byId = new Map(rows.map(row => [String(row.id), row]));
  return ids.map(id => byId.get(String(id))).filter(Boolean);
}

/**
 * The filter keys an INDEX page did not apply. Built from what was applied, since a bare key
 * (`period`, `docIds`) never reaches `buildFilter` to be refused.
 */
function unappliedFilterKeys(query, indexQuery, dropped) {
  const offered = [
    ...Array.from(eagleQuery.andParams(indexQuery), ([key]) => key),
    ...(indexQuery.project ? ['project'] : []),
    ...(indexQuery.categorized !== undefined ? ['categorized'] : [])
  ];
  const applied = new Set(offered.filter(key => !dropped.includes(key)));
  return eagleQuery.filterKeysIn(query).filter(key => !applied.has(key));
}

/**
 * Once per process per dataset: the frontend searches on every debounced keystroke, so a
 * per-request line would be noise.
 */
const keywordFallbackWarned = new Set();

/** Why the ranking the caller got is not the one they asked for. One line each, one latch each. */
const KEYWORD_FALLBACK_REASONS = {
  off: 'SEARCH_ENDPOINT or the index app setting for this dataset is empty',
  missing: 'the index its app setting names does not exist on the search service (HTTP 404)'
};

function warnKeywordFallback(dataset, reason = 'off') {
  const key = `${dataset}:${reason}`;
  if (keywordFallbackWarned.has(key)) return;
  keywordFallbackWarned.add(key);
  logger.warn(
    `[search] ${dataset}: keyword search is falling back to the Cosmos read — ` +
    `${KEYWORD_FALLBACK_REASONS[reason]}. This is a configuration state, NOT a search that found ` +
    'nothing.'
  );
}

/** Test seam, like resetStaleChunkScopeCache: the warn-once latch outlives one test otherwise. */
exports.resetKeywordFallbackWarnings = () => keywordFallbackWarned.clear();
/** Test seam: drive the latch directly rather than through a whole request. */
exports.warnKeywordFallback = warnKeywordFallback;

exports.KEYWORD_INDEX_DATASETS = KEYWORD_INDEX_DATASETS;
exports.unappliedFilterKeys = unappliedFilterKeys;
