'use strict';

const { redactAllForAccess } = require('../../vis/redact');
const { logger } = require('../../utils/logger');
const { filterFor } = require('../../helpers/access-odata');
const aiSearch = require('../../search/ai-search');
const eagleQuery = require('../../search/eagle-query');
const projectsRepo = require('../../repositories/projects');
const notificationsRepo = require('../../repositories/notifications');
const updatesRepo = require('../../repositories/updates');
const { stripLimit } = require('./params');
const { withoutDialHidden, redactIndexProject } = require('./project-fields');
const { cosmosRows, updateProjects } = require('./cosmos-rows');

/** The update type the home feed carries beside decisions; comment periods have their own rail. */
const FEED_UPDATE_TYPE = 'News';

const byDateDesc = (a, b) => Date.parse(b.date) - Date.parse(a.date);

/** The update-only feed fields, empty on a decision row so every row keeps the one shape. */
const NO_UPDATE_FIELDS = Object.freeze({ shortHeadline: null, summary: null, category: null, publishDate: null });
const isoDate = (value) => (value ? new Date(value).toISOString() : null);

/**
 * The newest project decisions this caller may see, dated no later than today, as feed rows.
 * From the `projects` index; the native feed reads Cosmos instead (`projects.listDecisions`).
 */
async function projectDecisionRows(access, limit, now) {
  const acl = filterFor(access, 'id');
  if (acl.empty) return [];
  // Through the same builders as a `dataset=Project` URL, so the ACL and the field gates are theirs.
  const { filter, fields } = eagleQuery.buildFilter(
    { 'and[decisionDateEnd]': now.toISOString() }, 'Project', acl, access);
  const { orderby, fields: sorted } = eagleQuery.buildOrderBy('-decisionDate', 'Project', false, access);
  let scoped;
  try {
    scoped = await withoutDialHidden(access, filter, [...fields, ...sorted]);
  } catch (err) {
    // Only this half drops, so news and notification decisions still serve; any other failure is a 502.
    if (err.code !== projectsRepo.DIAL_HIDDEN_OVER_CAP) throw err;
    logger.error('[search] home feed served without project decisions', { error: err.message, stack: err.stack });
    return [];
  }
  const { items } = await aiSearch.searchProjects({
    filter: scoped, orderby, skip: 0, keywords: '', matchAll: true, top: limit
  });
  return items
    .map(hit => redactIndexProject(hit, access))
    .filter(doc => doc.decisionDate)
    .map(doc => {
      const projectId = doc.legacyEagleId || String(doc.id);
      return {
        kind: 'decision',
        id: projectId,
        projectId,
        projectName: doc.name || doc.displayName || null,
        date: isoDate(doc.decisionDate),
        headline: doc.eacDecision || null,
        ...NO_UPDATE_FIELDS,
        content: null,
        documentUrl: null
      };
    });
}

/** Notification decisions as feed rows. A notification names its project loosely, by label. */
async function notificationDecisionRows(access, limit, now) {
  const rows = await notificationsRepo.listDecisions(access, { limit, now });
  const dated = redactAllForAccess('notifications', rows, access).filter(n => n.decisionDate);
  // A mirrored row with a garbage date would make isoDate throw and 502 the whole home page.
  const valid = dated.filter(n => !Number.isNaN(new Date(n.decisionDate).getTime()));
  if (valid.length < dated.length) {
    logger.warn('[search] home feed dropped notification decisions with an unparseable decisionDate', {
      ids: dated.filter(n => !valid.includes(n)).map(n => String(n.id))
    });
  }
  return valid
    .map(n => ({
      kind: 'decision',
      id: String(n.id),
      projectId: n.associatedProjectId || null,
      projectName: n.associatedProjectName || n.name || null,
      date: isoDate(n.decisionDate),
      headline: n.decision || null,
      ...NO_UPDATE_FIELDS,
      content: null,
      documentUrl: null
    }));
}

/**
 * The home feed: pinned updates first, exactly as the `top=true` strip, then the newest News updates
 * and decisions merged by date to fill the rest. Every half reads under the caller's own access.
 */
async function homeFeed({ access, query }) {
  if (query.keywords || query.q) return { error: 'dataset=HomeFeed does not take keywords' };
  const { limit, error } = stripLimit(query);
  if (error) return { error };

  const now = new Date();
  const [top, projectDecisions, notificationDecisions] = await Promise.all([
    updatesRepo.listTop(access, { limit, types: [FEED_UPDATE_TYPE] }),
    projectDecisionRows(access, limit, now),
    notificationDecisionRows(access, limit, now)
  ]);

  const project = await updateProjects(access, top);
  const updates = cosmosRows('updates', top, access, 'RecentActivity', project).map(row => ({
    kind: 'update',
    id: row._id,
    projectId: row.project ? row.project._id : null,
    projectName: row.project ? row.project.name : null,
    // When it went public, which is what a reader means by an update's date.
    date: isoDate(updatesRepo.publishedAt(row)),
    headline: row.headline || null,
    shortHeadline: row.shortHeadline || null,
    summary: row.summary || null,
    category: row.category || null,
    publishDate: row.publishDate || null,
    content: row.content || null,
    documentUrl: row.documentUrl || null
  }));

  // `listTop` answers pinned rows first, newest `publishDate` first; those hold their place, and
  // only the rest compete on date with the decisions.
  const pinnedCount = top.filter(row => row.pinned === true).length;
  const rest = [...updates.slice(pinnedCount), ...projectDecisions, ...notificationDecisions]
    .sort(byDateDesc)
    .slice(0, limit - pinnedCount);
  const rows = [...updates.slice(0, pinnedCount), ...rest];
  return { searchResults: rows, count: rows.length, applied: [] };
}

module.exports = {
  homeFeed
};
