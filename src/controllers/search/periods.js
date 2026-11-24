'use strict';

const { isPrivileged } = require('../../helpers/access-sql');
const { redactAllForAccess } = require('../../vis/redact');
const { logger } = require('../../utils/logger');
const { sortEntries } = require('../../search/sort-entries');
const commentPeriodsRepo = require('../../repositories/comment-periods');
const notificationsRepo = require('../../repositories/notifications');
const { firstValue, DAY_MS } = require('./params');
const { cosmosRows, parentProjects } = require('./cosmos-rows');

/** How far back "closed recently" reaches, for the count that rides along with the open rail. */
const CLOSED_WINDOW_DAYS = 30;

/**
 * Every period open at this moment, plus how many closed in the last CLOSED_WINDOW_DAYS. `count` is
 * the whole answer, not a page; `closedCount` is a separate number, not a total for these rows.
 */
async function openPeriods({ access, pageSize }) {
  // ONE capture for both reads: two `new Date()` calls could fall either side of a period's
  // boundary and break the complement the reads form.
  const now = new Date();
  const since = new Date(now.getTime() - CLOSED_WINDOW_DAYS * DAY_MS);
  const [rows, closedCount] = await Promise.all([
    commentPeriodsRepo.listOpen(access, { limit: pageSize, now }),
    commentPeriodsRepo.countClosedSince(access, since, now)
  ]);
  const searchResults = await periodRows(access, rows);
  return { searchResults, count: searchResults.length, closedCount, applied: ['status'] };
}

/** eagle-api took quoted keywords; `keywordsOf` drops the quotes. */
const periodKeywords = (raw) => commentPeriodsRepo.keywordsOf(firstValue(raw));

/** Substring match on the label, or on the parent project's name resolved under the caller's access. */
async function periodListFilters(access, keywords, status) {
  return {
    status,
    keywords,
    keywordProjectIds: await commentPeriodsRepo.keywordProjectIds(access, keywords),
    now: new Date()
  };
}

/** Every period this caller may see, across all projects, paged and counted on one predicate. */
async function periodList({ access, keywords, status, pageNum, pageSize, sortBy }) {
  const filters = await periodListFilters(access, keywords, status);
  const [rows, count] = await Promise.all([
    commentPeriodsRepo.listAll(access, { ...filters, pageNum, pageSize, sortBy }),
    commentPeriodsRepo.countAll(access, filters)
  ]);
  logger.debug('[search] CommentPeriod list', {
    rows: rows.length, count, status: filters.status || null, keywordProjects: filters.keywordProjectIds.length
  });
  return {
    searchResults: await periodRows(access, rows),
    count,
    applied: status ? ['status'] : []
  };
}

/** The `sortBy` entries a period read did not order by: it takes the first allowed key only. */
function periodSortDropped(sortBy) {
  const names = sortEntries(sortBy).map(entry => entry.replace(/^[+-]/, ''));
  const used = names.find(name => commentPeriodsRepo.SORTABLE.includes(name));
  return names.filter(name => name !== used);
}

/**
 * Period rows with `project` as the EAGLE parent id, which eagle-public puts into a project URL, read
 * under the caller's access. A notification-parented period links to the notification's own id.
 */
async function periodRows(access, rows) {
  const { demiIds, parents, eagleIdByDemiId } = await parentProjects(access, rows);
  const nameByDemiId = new Map(parents.filter(p => p.name).map(p => [String(p.id), p.name]));

  const unmatched = demiIds.filter(id => !eagleIdByDemiId.has(id));
  const notificationParents = unmatched.length
    ? redactAllForAccess('notifications',
      await notificationsRepo.listByIds(access, unmatched), access)
    : [];
  for (const parent of notificationParents) {
    eagleIdByDemiId.set(String(parent.id), String(parent.id));
  }

  // The period's own ACL admits it only through the publish cascade; if that cascade failed, a
  // period of a hidden parent still reads public. The parent read above is the second check.
  const withheld = isPrivileged(access.roles || [])
    ? []
    : rows.filter(row => !eagleIdByDemiId.has(String(row.projectId)));
  if (withheld.length > 0) {
    logger.warn('[search] CommentPeriod withheld: parent not visible to this caller', {
      periodIds: withheld.map(row => String(row.id)),
      projectIds: Array.from(new Set(withheld.map(row => String(row.projectId))))
    });
  }

  // `projectName` rides on the parent read above, so the home page rail needs no read per card.
  // Absent, never invented, when the parent is hidden, unnamed, or a notification.
  return cosmosRows('commentPeriods', rows.filter(row => !withheld.includes(row)), access, 'CommentPeriod', (row) => {
    const name = nameByDemiId.get(String(row.projectId));
    return {
      project: eagleIdByDemiId.get(String(row.projectId)) || null,
      ...(name ? { projectName: name } : {})
    };
  });
}

module.exports = {
  openPeriods,
  periodKeywords,
  periodListFilters,
  periodList,
  periodSortDropped,
  periodRows
};
