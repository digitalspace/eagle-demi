'use strict';

/**
 * GET handlers for Cosmos kinds, and the one place their fields are withheld (`redactForAccess`).
 *
 * Called with an entity name: the mirror kinds' continuation-token lists (users, groups,
 * inspections). Called with a kind spec: the native list contract (`helpers/native-query.js`).
 */

const { resolveAccess, pageSizeFor } = require('../../helpers/access-sql');
const { assertKindSpec, parseNativeQuery, nativeCriteria, isEagleId } = require('../../helpers/native-query');
const { redactForAccess, redactAllForAccess } = require('../../vis/redact');
const { serverError } = require('../../helpers/response');
const { analyticsEvent, auditEvent } = require('../../utils/audit');

// The Front Door cache key ignores Authorization, so nothing a credential unlocked may be stored.
const NO_STORE = 'private, no-store';

// Searches on these carry names and emails; their terms stay out of the 13-month events table.
const UNLOGGED_SEARCH_KINDS = Object.freeze(['users', 'comments']);

/**
 * A kind spec: `{ entity, repository, sortKeys, filters, multiValueFilters, qFields?, parentJoin?,
 * audited?, notFound? }`. `repository` is `{ list(access, {criteria, orderBy, pageNum, pageSize}),
 * count(access, {criteria}), getById(access, id), getByEagleId?(access, id) }`, each bound to the
 * caller's visibility predicate (`cosmosKind` builds one). `parentJoin(access, rows)` runs on
 * redacted rows.
 */
function nativeListHandler(spec) {
  assertKindSpec(spec);
  return async (req, res) => {
    try {
      const access = resolveAccess(req);
      if (access.authenticated) res.setHeader('cache-control', NO_STORE);

      const parsed = parseNativeQuery(spec, req.query, access);
      if (parsed.error) return res.status(400).json({ error: parsed.error });

      const { criteria, orderBy } = nativeCriteria(spec, parsed, access);
      const [rows, total] = await Promise.all([
        spec.repository.list(access, { criteria, orderBy, pageNum: parsed.pageNum, pageSize: parsed.pageSize }),
        parsed.count ? spec.repository.count(access, { criteria }) : undefined
      ]);
      if (total !== undefined) res.setHeader('x-total-count', String(total));

      let body = redactAllForAccess(spec.entity, rows, access);
      if (spec.parentJoin) body = await spec.parentJoin(access, body);

      if (parsed.q && !UNLOGGED_SEARCH_KINDS.includes(spec.entity)) {
        analyticsEvent(req, {
          eventName: 'search',
          searchTerm: parsed.q,
          resultCount: total,
          detail: { kind: spec.entity, pageSize: parsed.pageSize }
        });
      }
      if (spec.audited && access.authenticated) {
        auditEvent(req, { action: `${spec.entity}.list`, targetType: spec.entity, detail: { count: body.length } });
      }
      return res.json(body);
    } catch (err) {
      // `readPage` refuses a page past MAX_PAGE_DEPTH before reading anything.
      if (err && err.status === 400) return res.status(400).json({ error: err.message });
      return serverError(res, err, `${spec.entity} list failed`);
    }
  };
}

/** By id: a DEMI id, or a 24-hex Eagle id where the kind keys rows differently. One 404 for both. */
function nativeGetHandler(spec) {
  assertKindSpec(spec);
  const notFound = spec.notFound || 'Not found';
  return async (req, res) => {
    try {
      const access = resolveAccess(req);
      if (access.authenticated) res.setHeader('cache-control', NO_STORE);

      const unknown = Object.keys(req.query || {})[0];
      if (unknown) return res.status(400).json({ error: `unknown parameter: ${unknown}` });

      const id = req.params.id;
      let row = await spec.repository.getById(access, id);
      if (!row && isEagleId(id) && spec.repository.getByEagleId) row = await spec.repository.getByEagleId(access, id);
      if (!row) return res.status(404).json({ error: notFound });

      let body = redactForAccess(spec.entity, row, access);
      if (spec.parentJoin) [body] = await spec.parentJoin(access, [body]);

      if (spec.audited && access.authenticated) {
        auditEvent(req, { action: `${spec.entity}.read`, targetType: spec.entity, targetId: row.id, projectId: row.projectId });
      }
      return res.json(body);
    } catch (err) {
      return serverError(res, err, `${spec.entity} read failed`);
    }
  };
}

/**
 * @param {string|object} entity  catalog entity the rows are redacted as, or a kind spec
 * @param {(access, query, page: {pageSize, continuationToken}) => Promise<{items, continuationToken}>} [list]
 */
function listHandler(entity, list) {
  if (typeof entity === 'object') return nativeListHandler(entity);
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

/** @param {(access, id, query) => Promise<object|null>} [get]  a read already gated on `canRead` */
function getHandler(entity, notFound, get) {
  if (typeof entity === 'object') return nativeGetHandler(entity);
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
