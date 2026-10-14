'use strict';

/**
 * The HTTP adapter for every domain write: a route's write handler is `writeHandler(domainFn)`.
 * The domain function answers with a `status`; this maps it to the response, so a controller
 * that imports `domain/` never writes `res.status` or `res.json` itself.
 */

const { resolveAccess } = require('../../helpers/access-sql');
const { serverError } = require('../../helpers/response');
const { redactForAccess } = require('../../vis/redact');
const { logger } = require('../../utils/logger');

/** The body every staff write answers when it never found the row standing still. */
const WRITE_CONFLICT_ERROR = 'The record is being written by another request. Try again.';

const REFUSALS = Object.freeze({
  forbidden: { code: 403, error: 'Forbidden.' },
  'not-found': { code: 404, error: 'Not found.' },
  conflict: { code: 409, error: 'Conflict.' },
  busy: { code: 503, error: WRITE_CONFLICT_ERROR }
});

/**
 * @param {Function} fn `fn(ctx, body)` on a route without `:id`, `fn(ctx, id, body)` with it;
 *   `ctx` is `{ access, req }`. Resolves to `{status: 'ok', value, created?}`,
 *   `{status: 'invalid', fields}`, or `{status: 'forbidden'|'not-found'|'conflict'|'busy', error?}`.
 * @param {{entity: string}} options the catalog entity that redacts the saved row
 */
function writeHandler(fn, { entity }) {
  if (!entity) throw new TypeError('writeHandler needs the catalog entity');

  return async function (req, res) {
    try {
      const ctx = { access: resolveAccess(req), req };
      const id = req.params && req.params.id;
      const result = id === undefined ? await fn(ctx, req.body) : await fn(ctx, id, req.body);

      if (result.status === 'ok') {
        return res.status(result.created ? 201 : 200).json(redactForAccess(entity, result.value, ctx.access));
      }
      if (result.status === 'invalid') {
        // Field names only, and at most ten: the values and the key count are the caller's.
        logger.warn(`[Write] ${entity} write refused: invalid ${Object.keys(result.fields).slice(0, 10).join(', ')}`,
          { entity, id, status: 'invalid' });
        return res.status(400).json({ error: 'Invalid request body.', fields: result.fields });
      }
      const refusal = REFUSALS[result.status];
      if (!refusal) throw new Error(`unknown domain result status ${result.status}`);
      logger.warn(`[Write] ${entity} write refused: ${result.status}`, { entity, id, status: result.status });
      // The busy body is fixed: a domain message there would differ from every other staff write.
      const error = result.status === 'busy' ? refusal.error : result.error || refusal.error;
      return res.status(refusal.code).json({ error });
    } catch (err) {
      return serverError(res, err, `${entity} write failed`);
    }
  };
}

module.exports = { writeHandler, WRITE_CONFLICT_ERROR };
