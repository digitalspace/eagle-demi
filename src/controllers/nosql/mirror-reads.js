'use strict';

/**
 * GET handlers for the Eagle mirror kinds that have no reader of their own: the users, groups and
 * inspections containers. Same envelope as `GET /documents`: a list answers an array with the next
 * page's token in `x-continuation-token`, a by-id read answers one record or 404. The repository
 * filters the rows; `redactForAccess` here is the one place fields are withheld.
 */

const { resolveAccess, pageSizeFor } = require('../../helpers/access-sql');
const { redactForAccess, redactAllForAccess } = require('../../vis/redact');
const { serverError } = require('../../helpers/response');

/**
 * @param {string} entity  catalog entity the rows are redacted as
 * @param {(access, query, page: {pageSize, continuationToken}) => Promise<{items, continuationToken}>} list
 */
function listHandler(entity, list) {
  return async (req, res) => {
    try {
      const access = resolveAccess(req);
      const { pageSize, error } = pageSizeFor(access, req.query.pageSize);
      if (error) return res.status(400).json({ error });

      const { items, continuationToken } = await list(access, req.query,
        { pageSize, continuationToken: req.query.continuationToken });
      if (continuationToken) res.setHeader('x-continuation-token', continuationToken);
      return res.json(redactAllForAccess(entity, items, access));
    } catch (err) {
      return serverError(res, err, `${entity} list failed`);
    }
  };
}

/** @param {(access, id, query) => Promise<object|null>} get  a read already gated on `canRead` */
function getHandler(entity, notFound, get) {
  return async (req, res) => {
    try {
      const access = resolveAccess(req);
      const row = await get(access, req.params.id, req.query);
      if (!row) return res.status(404).json({ error: notFound });
      return res.json(redactForAccess(entity, row, access));
    } catch (err) {
      return serverError(res, err, `${entity} read failed`);
    }
  };
}

module.exports = { listHandler, getHandler };
