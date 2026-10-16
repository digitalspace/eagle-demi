'use strict';

/**
 * Native comment period reads: `GET /comment-periods`, `/comment-periods/:id` and
 * `/comment-periods/:id/summary`, on the list contract in `helpers/native-query.js`.
 */

const commentPeriods = require('../../repositories/comment-periods');
const comments = require('../../repositories/comments');
const { listHandler, getHandler } = require('../nosql/mirror-reads');
const { projectParentJoin, nativeCriteria, isEagleId } = require('../../helpers/native-query');
const { resolveAccess } = require('../../helpers/access-sql');
const { assertFilterable } = require('../../repositories/_sql');
const { serverError } = require('../../helpers/response');
const { auditEvent } = require('../../utils/audit');
const COMMENTS = require('./comments').SPEC;

// Same as mirror-reads: the Front Door cache key ignores Authorization.
const NO_STORE = 'private, no-store';

const BASE_SPEC = Object.freeze({
  entity: 'commentPeriods',
  repository: commentPeriods.nativeRepository(),
  sortKeys: ['dateStarted', 'dateCompleted', 'isPublished'],
  filters: ['projectId'],
  aliases: { project: 'projectId' },
  multiValueFilters: [],
  parentJoin: projectParentJoin,
  audited: true,
  notFound: 'Comment period not found'
});

const unfiltered = listHandler(BASE_SPEC);

/**
 * `GET /comment-periods`. `status` (open, upcoming, closed; repeatable) is compared against the
 * clock rather than read from a field, so it is taken out here and handed to the repository.
 */
exports.getCommentPeriods = (req, res) => {
  const { status, ...query } = req.query || {};
  req.query = query;
  if (status === undefined) return unfiltered(req, res);

  const statuses = [...new Set([].concat(status))];
  const bad = statuses.find(value => !commentPeriods.STATUSES.includes(value));
  if (bad !== undefined) {
    return res.status(400).json({ error: `status takes ${commentPeriods.STATUSES.join(', ')}` });
  }
  return listHandler({ ...BASE_SPEC, repository: commentPeriods.nativeRepository(statuses) })(req, res);
};

exports.SPEC = BASE_SPEC;
exports.getCommentPeriod = getHandler(BASE_SPEC);

/** Comments of `periodId` this caller may read, optionally of one `eaoStatus`, on the list's own predicate. */
function countComments(access, periodId, eaoStatus) {
  const filters = { periodId: [periodId], ...(eaoStatus ? { eaoStatus: [eaoStatus] } : {}) };
  const { criteria } = nativeCriteria(COMMENTS, { ids: null, filters, q: null, sort: null }, access);
  return COMMENTS.repository.count(access, { criteria });
}

/**
 * `GET /comment-periods/:id/summary`: `{ id, total, eaoStatus: { <status>: n } }`. Every count goes
 * through the comment list's predicate, so a comment the caller cannot read is not counted.
 */
exports.getCommentPeriodSummary = async (req, res) => {
  try {
    const access = resolveAccess(req);
    if (access.authenticated) res.setHeader('cache-control', NO_STORE);

    const unknown = Object.keys(req.query || {})[0];
    if (unknown) return res.status(400).json({ error: `unknown parameter: ${unknown}` });

    const id = req.params.id;
    const repo = BASE_SPEC.repository;
    let period = await repo.getById(access, id);
    if (!period && isEagleId(id)) period = await repo.getByEagleId(access, id);
    if (!period) return res.status(404).json({ error: BASE_SPEC.notFound });

    try {
      assertFilterable(COMMENTS.entity, 'eaoStatus', access);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const [total, ...perStatus] = await Promise.all([
      countComments(access, period.id),
      ...comments.EAO_STATUSES.map(status => countComments(access, period.id, status))
    ]);
    const eaoStatus = Object.fromEntries(comments.EAO_STATUSES.map((status, i) => [status, perStatus[i]]));

    if (access.authenticated) {
      auditEvent(req, {
        action: 'commentPeriods.summary', targetType: 'commentPeriods', targetId: period.id, projectId: period.projectId
      });
    }
    return res.json({ id: period.id, total, eaoStatus });
  } catch (err) {
    return serverError(res, err, 'commentPeriods summary failed');
  }
};
