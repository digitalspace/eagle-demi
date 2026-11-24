'use strict';

const { resolveAccess } = require('../../helpers/access-sql');
const { accessFingerprint, createCountsCache } = require('../../helpers/counts-cache');
const { logger } = require('../../utils/logger');
const { filterFor } = require('../../helpers/access-odata');
const aiSearch = require('../../search/ai-search');
const eagleQuery = require('../../search/eagle-query');
const { updatesIndexAcl } = require('../../search/native-index');
const { documentsAcl } = require('../../search/document-query');
const commentPeriodsRepo = require('../../repositories/comment-periods');
const notificationsRepo = require('../../repositories/notifications');
const updatesRepo = require('../../repositories/updates');
const { keywordText } = require('./params');
const { withoutDialHidden } = require('./project-fields');
const { periodKeywords, periodListFilters } = require('./periods');
const { warnKeywordFallback } = require('./keyword-index');

/** The record types the unified search page shows a badge for, in the order the tabs sit in. */
const COUNTS_DATASETS = ['Project', 'Document', 'RecentActivity', 'ProjectNotification', 'CommentPeriod'];

/**
 * EVERY parameter `/search/counts` reads. It counts every type at once, so any filter is REFUSED:
 * a badge under a filter the caller thinks applied is a silently wrong number.
 */
const COUNTS_PARAMS = new Set(['keywords', 'q', 'prefix', 'datasets']);

const countsCache = createCountsCache();

exports.resetCountsCache = () => countsCache.clear();

/**
 * One count per record type: `null` where it could not MEASURE one, never 0. `degraded: true` marks
 * a count from the Cosmos CONTAINS fallback, not the index.
 */
const COUNT_LEGS = {
  async Project({ access, keywords, prefix }) {
    // 'id', not 'projectId': a project IS its own scope. Same clause the Project branch builds.
    const acl = filterFor(access, 'id');
    // OData cannot express a filter that matches nothing, and 0 here is measured — see filterFor.
    if (acl.empty) return { count: 0 };
    return {
      count: await aiSearch.countProjects({
        filter: await withoutDialHidden(access, acl.filter, [], keywords, aiSearch.PROJECT_SEARCH_FIELDS),
        keywords, matchAll: !keywords, fuzzy: true, prefix
      })
    };
  },

  async Document({ access, keywords, prefix }) {
    const acl = documentsAcl(access);
    if (acl.empty) return { count: 0 };
    // Projects are scoped on their own id; the same caller, a different index.
    const projectScope = filterFor(access, 'id');
    // THE TWO-LEG SUM, not a bare `top: 0` on the documents index: leg two owns the documents whose
    // PROJECT's name matched, and a count without it under-reports the tab's own total.
    const { count } = await aiSearch.searchDocuments({
      countOnly: true,
      // Through buildFilter so the tab counts the rows the Document list returns.
      filter: eagleQuery.buildFilter({}, 'Document', acl, access).filter,
      projectFilter: projectScope.empty ? undefined
        : await withoutDialHidden(access, projectScope.filter, [], keywords, aiSearch.LEG_TWO_SEARCH_FIELDS),
      keywords,
      matchAll: !keywords,
      fuzzy: true,
      prefix
    });
    return { count };
  },

  async RecentActivity({ access, keywords, prefix }) {
    const index = aiSearch.config().activitiesIndex;
    if (keywords && aiSearch.config().configured && index !== '') {
      try {
        const acl = await updatesIndexAcl(access);
        if (acl.empty) return { count: 0 };
        return {
          count: await aiSearch.countActivities({ filter: acl.filter, keywords, fuzzy: true, prefix })
        };
      } catch (err) {
        // A setting naming an index nobody created 404s on every query, and the container can still
        // answer. Every other failure rejects and the badge goes unknown.
        if (!aiSearch.isMissingIndex(err, index)) throw err;
        warnKeywordFallback('RecentActivity', 'missing');
      }
    } else if (keywords) {
      warnKeywordFallback('RecentActivity');
    }

    // CONTAINS rather than BM25, exactly as the keywordless list read answers it.
    return { count: await updatesRepo.count(access, { keywords }), degraded: Boolean(keywords) };
  },

  async ProjectNotification({ access, keywords, prefix }) {
    // No keywords is the same question the Cosmos list read answers, and it answers it exactly.
    if (!keywords) return { count: await notificationsRepo.count(access, {}) };

    const index = aiSearch.config().notificationsIndex;
    if (!aiSearch.config().configured || index === '') {
      warnKeywordFallback('ProjectNotification');
      // NOT the Cosmos count: `notificationsRepo.count` takes no keywords, so it would answer the
      // whole corpus to a keyword query — a confidently wrong badge. Unknown is the honest answer.
      return { count: null };
    }

    try {
      // NULL partition field, like `notifications.SCOPE_FIELD`: a notification is not project data,
      // so role ACL is the whole filter.
      const acl = filterFor(access, null);
      if (acl.empty) return { count: 0 };
      return {
        count: await aiSearch.countNotifications({ filter: acl.filter, keywords, fuzzy: true, prefix })
      };
    } catch (err) {
      if (!aiSearch.isMissingIndex(err, index)) throw err;
      warnKeywordFallback('ProjectNotification', 'missing');
      return { count: null };
    }
  },

  // The same predicate the unscoped list reads with no status, so the badge is that tab's total.
  async CommentPeriod({ access, keywords }) {
    return {
      count: await commentPeriodsRepo.countAll(access, await periodListFilters(access, periodKeywords(keywords)))
    };
  }
};

/**
 * Every badge, in parallel, one failure at a time. `allSettled` because a tab whose index is down
 * must not take the others with it — the page shows one blank badge, never a 500.
 */
async function computeCounts(access, keywords, prefix) {
  const settled = await Promise.allSettled(
    COUNTS_DATASETS.map(name => COUNT_LEGS[name]({ access, keywords, prefix })));

  const counts = {};
  const unavailable = [];
  const degraded = [];

  COUNTS_DATASETS.forEach((name, i) => {
    const leg = settled[i];
    if (leg.status === 'rejected') {
      logger.error(`[search/counts] ${name} count failed`,
        { error: leg.reason && leg.reason.message, stack: leg.reason && leg.reason.stack });
      counts[name] = null;
      unavailable.push(name);
      return;
    }
    // `undefined` and `null` are the same fact here: nobody measured this one.
    counts[name] = leg.value.count === undefined ? null : leg.value.count;
    if (counts[name] === null) unavailable.push(name);
    if (leg.value.degraded) degraded.push(name);
  });

  return { counts, unavailable, degraded };
}

/**
 * `GET /api/search/counts`: EVERY type is computed and cached, `datasets` only slices the answer.
 * No `Cache-Control`: the counts are ACL-scoped, and a shared cache would leak them across callers.
 */
exports.counts = async (req, res) => {
  try {
    const unknown = eagleQuery.unsupportedParams(req.query, COUNTS_PARAMS);
    if (unknown.length > 0) {
      return res.status(400).json({ error: `Unsupported query parameter: ${unknown.join(', ')}` });
    }

    const requested = req.query.datasets === undefined
      ? COUNTS_DATASETS
      : Array.from(new Set(String(req.query.datasets).split(',').map(s => s.trim()).filter(Boolean)));
    const invalid = requested.filter(name => !COUNTS_DATASETS.includes(name));
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Invalid or unsupported dataset: ${invalid.join(', ')}` });
    }

    // Whitespace only. Lowercasing would widen the cache but change the string the analyzer is
    // handed, and the key has to name the query that was actually run.
    const keywords = keywordText(req.query.keywords || req.query.q);
    // Same default as `/search`: on unless the caller sends the exact string `false`.
    const prefix = req.query.prefix !== 'false';
    const access = resolveAccess(req);

    const { promise, cached } = countsCache.read(`${keywords}|${prefix}|${accessFingerprint(access)}`,
      () => computeCounts(access, keywords, prefix));
    const { counts, unavailable, degraded } = await promise;

    // Sliced to what the caller asked about: a badge they do not render is not a tab they can be
    // told is unavailable.
    const asked = new Set(requested);
    const picked = {};
    for (const name of requested) picked[name] = counts[name];

    return res.json([{
      counts: picked,
      meta: [{
        unavailable: unavailable.filter(name => asked.has(name)),
        degraded: degraded.filter(name => asked.has(name)),
        cached
      }]
    }]);
  } catch (err) {
    logger.error('[demi-api search/counts] Top-level counts error:',
      { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Counts failed' });
  }
};
