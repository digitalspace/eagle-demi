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

    // No paging: 281 items across 3 partitions is one response. Accepting `pageSize` without
    // returning the continuation token would hand a caller a truncated map and no way to page it.
    const { type, geometry } = req.query;
    const { items } = await boundaries.listByType(access, {
      // Geometry is opt-OUT, not opt-in. The frontend sends `geometry=simplified` for the default
      // fidelity and nothing at all on the bbox call, so requiring `geometry=true` would strip the
      // polygons from both and blank the map without erroring.
      type,
      withGeometry: geometry !== 'false'
    });

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
    return res.json({ message: 'Boundary deleted successfully', deleted: existing });
  } catch (err) {
    return serverError(res, err, 'deleteBoundary failed');
  }
};
