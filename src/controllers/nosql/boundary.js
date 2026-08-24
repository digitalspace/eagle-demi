'use strict';

/**
 * Administrative boundaries — Cosmos NoSQL.
 *
 * Reads are ACL-gated like every other container. The corpus is public reference geodata today,
 * but "public in practice" is not the same as "cannot be restricted", and a staff-only shapefile
 * has to be expressible. See repositories/boundaries.js for why project scope does not apply.
 *
 * Items now store simplified geometry only; full-resolution GeoJSON is a build artifact
 * served as a static asset, which the frontend already prefers. The old three-way
 * geometry=false|true|simplified juggling collapses to: omit geometry, or return the item.
 */

const boundaries = require('../../repositories/boundaries');
const { resolveAccess, SECURE_ROLES } = require('../../helpers/access-sql');
const { serverError } = require('../../helpers/response');
const { auditEvent } = require('../../utils/audit');
const { logger } = require('../../utils/logger');

/**
 * The ACL a written boundary carries.
 *
 * Unlike a document, a boundary has no parent whose visibility it could out-rank, so the caller's
 * request is honoured directly — `isPublished: false` yields a staff-only shapefile. The default
 * is public, which is what every existing row is.
 */
function resolveBoundaryAcl(isPublished) {
  const published = isPublished !== false;
  return {
    isPublished: published,
    read: published ? ['public', ...SECURE_ROLES] : [...SECURE_ROLES]
  };
}

exports.getBoundaries = async (req, res) => {
  try {
    const access = resolveAccess(req);

    // Reference data changes rarely and the frontend fetches it on every map load. The response
    // varies by caller now, so `Vary: Authorization` rather than `private` — the anonymous
    // response is byte-identical for every anonymous caller, which is very nearly all of them, and
    // `private` would give up the shared cache for the one case that benefits from it most.
    if (typeof res.setHeader === 'function') {
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
      res.setHeader('Vary', 'Authorization');
    }

    // BOUNDED, and the token comes back ONLY ON THE PATH THAT CAN CARRY ONE. The read used to pass
    // no `pageSize` at all, which takes `cosmos.query`'s `fetchAll()` branch and drains the
    // container cross-partition on an anonymous request — fine at 281 items across 3 partitions,
    // and fine only because of that number.
    //
    // THE TWO PATHS PAGE DIFFERENTLY, and it is not a choice this code makes. With `type` the query
    // sets `partitionKey`, runs single-partition through the SDK's `DefaultQueryExecutionContext`,
    // and `x-ms-continuation` propagates — that path pages correctly. WITHOUT `type` it is
    // cross-partition with `ORDER BY c.name ASC`, which the SDK serves through its pipelined
    // `LegacyFetchImplementation`, whose `mergeHeaders` does not copy `x-ms-continuation`. So
    // `continuationToken` comes back `undefined` no matter how many rows are left.
    //
    // That is why the full page below is REPORTED rather than quietly served. The old note here
    // said paging was omitted because accepting `pageSize` without returning the token hands a
    // caller a truncated map and no way to page it. On the unfiltered path that is still true and
    // the SDK is the reason, so the honest thing is to bound the read and say when the bound bit —
    // not to leave it draining the container. Both frontend list calls pass `type=`
    // (`registry-state.service.ts:903,936`), so neither can reach it.
    const { type, geometry, continuationToken } = req.query;
    const { items, continuationToken: nextPage, pageSize } = await boundaries.listByType(access, {
      // Geometry is opt-OUT, not opt-in. The frontend sends `geometry=simplified` for the default
      // fidelity and nothing at all on the bbox call, so requiring `geometry=true` would strip the
      // polygons from both and blank the map without erroring.
      type,
      withGeometry: geometry !== 'false',
      // Passed through UNCLAMPED and read back below. `pageOptions` clamps to [1, 1000] and is the
      // only place that does; clamping here as well produced two numbers that disagreed on junk
      // input, and the guard below then compared against the one that had bounded nothing.
      // `undefined` would skip `maxItemCount` entirely and take the `fetchAll()` drain, so the
      // default is the ceiling rather than nothing.
      pageSize: req.query.pageSize === undefined ? 1000 : req.query.pageSize,
      continuationToken
    });

    if (nextPage && typeof res.setHeader === 'function') {
      res.setHeader('x-continuation-token', nextPage);
    }

    // A FULL PAGE AND NO TOKEN is unresumable: either there are exactly `pageSize` rows and this is
    // complete, or there are more and the caller can never reach them. The two are indistinguishable
    // from here, which is precisely why it must not pass silently — a truncated map that says
    // nothing is the failure this endpoint is meant to have stopped having.
    // `pageSize` here is what `pageOptions` actually applied, not what the caller asked for — see
    // the repository. No caller-supplied value is interpolated: this line is unauthenticated and
    // winston forwards to Application Insights (`utils/logger.js:25-29`), so echoing `type` would
    // let anyone write chosen text into telemetry, once per request, at unbounded cardinality.
    if (!nextPage && items.length >= pageSize) {
      logger.warn(
        `[boundaries] returned a full page of ${pageSize} with no continuation token on ` +
        `${type ? 'a type-scoped' : 'the unfiltered cross-partition'} read — any further rows ` +
        'are unreachable; scope by `type` to page them'
      );
    }

    return res.json(items);
  } catch (err) {
    return serverError(res, err, 'getBoundaries failed');
  }
};

exports.getBoundary = async (req, res) => {
  try {
    const access = resolveAccess(req);

    // Falls back to a NAME lookup, matching the Mongo controller. The frontend calls
    // `/boundaries/<name>` from loadSingleBoundaryGeometry — dropping the fallback made every
    // boundary selection issue a request that 404s. It still rendered, because the list response
    // carries simplifiedGeometry and the caller falls back to it, so the only visible symptom was
    // a failing request per selection.
    let boundary = await boundaries.getById(access, req.params.id, req.query.type);
    if (!boundary) {
      boundary = await boundaries.getByName(access, String(req.params.id), req.query.type);
    }
    if (!boundary) {
      // 404 for both "absent" and "not yours" — a 403 would confirm the boundary exists.
      return res.status(404).json({ error: 'Boundary not found' });
    }
    return res.json(boundary);
  } catch (err) {
    return serverError(res, err, 'getBoundary failed');
  }
};

exports.createBoundary = async (req, res) => {
  try {
    const { type, name, code, geometry, isPublished } = req.body;
    if (!type || !name) {
      return res.status(400).json({ error: 'Missing required fields: type, name' });
    }

    const saved = await boundaries.upsert({
      id: `${type}_${name}`,
      type,
      name,
      code: code || '',
      geometry: geometry || null,
      ...resolveBoundaryAcl(isPublished),
      updatedAt: new Date().toISOString()
    });

    // No ProjectId: boundaries are reference geography partitioned on `type`, with no parent
    // project. Left empty rather than borrowing an unrelated id to fill the column.
    auditEvent(req, {
      action: 'boundary.create',
      targetType: 'boundary',
      targetId: saved.id,
      detail: { type: saved.type, name: saved.name, isPublished: saved.isPublished }
    });

    return res.status(201).json(saved);
  } catch (err) {
    return serverError(res, err, 'createBoundary failed');
  }
};

exports.updateBoundary = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const existing = await boundaries.getById(access, req.params.id, req.query.type);
    if (!existing) {
      return res.status(404).json({ error: 'Boundary not found' });
    }

    // type is the partition key — reassigning it is a delete-and-reinsert, not an update.
    // `read` is derived from `isPublished` rather than taken from the body, so the two cannot
    // disagree: read[] is authoritative and isPublished mirrors it, never the reverse.
    const {
      id: _ignoredId, type: _ignoredPk, read: _ignoredRead, isPublished, ...changes
    } = req.body;

    const acl = isPublished === undefined
      ? { isPublished: existing.isPublished, read: existing.read }
      : resolveBoundaryAcl(isPublished);

    const saved = await boundaries.upsert({
      ...existing,
      ...changes,
      ...acl,
      id: existing.id,
      type: existing.type,
      updatedAt: new Date().toISOString()
    });

    // The publish transition is recorded the way project.update records it: a boundary's `read[]`
    // is derived from isPublished (resolveBoundaryAcl above), so flipping it is a visibility
    // change, and that is the edit anyone reads this table to find.
    auditEvent(req, {
      action: 'boundary.update',
      targetType: 'boundary',
      targetId: existing.id,
      detail: {
        type: existing.type,
        changed: Object.keys(changes),
        isPublishedFrom: existing.isPublished,
        isPublishedTo: saved.isPublished
      }
    });

    return res.json(saved);
  } catch (err) {
    return serverError(res, err, 'updateBoundary failed');
  }
};

exports.deleteBoundary = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const existing = await boundaries.getById(access, req.params.id, req.query.type);
    if (!existing) {
      return res.status(404).json({ error: 'Boundary not found' });
    }

    await boundaries.deleteById(existing.id, existing.type);

    auditEvent(req, {
      action: 'boundary.delete',
      targetType: 'boundary',
      targetId: existing.id,
      detail: { type: existing.type, name: existing.name, isPublished: existing.isPublished }
    });

    return res.json({ message: 'Boundary deleted successfully', deleted: existing });
  } catch (err) {
    return serverError(res, err, 'deleteBoundary failed');
  }
};
