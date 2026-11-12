'use strict';

/**
 * Administrative boundaries. Reads are ACL-gated so a staff-only shapefile stays possible. Items
 * hold simplified geometry only; full-resolution GeoJSON is served as a static asset.
 */

const boundaries = require('../../repositories/boundaries');
const { resolveAccess, readForLevel } = require('../../helpers/access-sql');
const { INTERNAL_FIELDS } = require('../../db/cosmos-nosql');
const { serverError } = require('../../helpers/response');
const { auditEvent } = require('../../utils/audit');
const { logger } = require('../../utils/logger');

/**
 * No parent to out-rank, so the caller's `isPublished` is honoured directly; the default is public.
 */
function resolveBoundaryAcl(isPublished) {
  const published = isPublished !== false;
  return {
    isPublished: published,
    read: readForLevel(published ? 4 : 2)
  };
}

// Never served: the ACL and the Cosmos system fields, `_etag` included.
const UNSERVED_KEYS = Object.freeze(['read', '_etag', ...INTERNAL_FIELDS]);

// A body key outside these is refused, so a typo cannot store a field every caller then reads.
const UPDATABLE_KEYS = Object.freeze(['name', 'code', 'geometry', 'simplifiedGeometry', 'isPublished']);
// Keys the update has always accepted and dropped, so a fetched row sent back still saves.
const IGNORED_KEYS = Object.freeze(['id', 'type', 'read', 'updatedAt']);

function served(row) {
  const out = { ...row };
  for (const key of UNSERVED_KEYS) delete out[key];
  return out;
}

exports.getBoundaries = async (req, res) => {
  try {
    const access = resolveAccess(req);

    // `Vary: Authorization`, not `private`: the anonymous response is the same for nearly every
    // caller, and `private` would lose the shared cache for it.
    if (typeof res.setHeader === 'function') {
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
      res.setHeader('Vary', 'Authorization');
    }

    // Always bounded. Without `type` the SDK serves the cross-partition ORDER BY with no
    // `x-ms-continuation`, so that path never gets a token and a full page is reported below.
    const { type, geometry, continuationToken } = req.query;
    const { items, continuationToken: nextPage, pageSize } = await boundaries.listByType(access, {
      // Opt-out: the frontend sends `geometry=simplified` or nothing, so requiring `true` would
      // blank the map.
      type,
      withGeometry: geometry !== 'false',
      // Unclamped: only `pageOptions` clamps, and the guard below reads its value back. The
      // default is the ceiling because `undefined` takes the `fetchAll()` drain.
      pageSize: req.query.pageSize === undefined ? 1000 : req.query.pageSize,
      continuationToken
    });

    if (nextPage && typeof res.setHeader === 'function') {
      res.setHeader('x-continuation-token', nextPage);
    }

    // A full page with no token may be truncated and cannot be resumed. The log echoes no caller
    // value: the route is anonymous and logs reach Application Insights.
    if (!nextPage && items.length >= pageSize) {
      // Told to the caller too, and kept out of the day-long shared cache set above.
      if (typeof res.setHeader === 'function') {
        res.setHeader('x-truncated', 'true');
        res.setHeader('Cache-Control', 'no-store');
      }
      logger.warn(
        `[boundaries] returned a full page of ${pageSize} with no continuation token on ` +
        `${type ? 'a type-scoped' : 'the unfiltered cross-partition'} read — any further rows ` +
        'are unreachable; scope by `type` to page them'
      );
    }

    return res.json(items.map(served));
  } catch (err) {
    return serverError(res, err, 'getBoundaries failed');
  }
};

exports.getBoundary = async (req, res) => {
  try {
    const access = resolveAccess(req);

    // Falls back to a name lookup: the frontend's loadSingleBoundaryGeometry calls
    // `/boundaries/<name>`.
    let boundary = await boundaries.getById(access, req.params.id, req.query.type);
    if (!boundary) {
      boundary = await boundaries.getByName(access, String(req.params.id), req.query.type);
    }
    if (!boundary) {
      // 404 for both "absent" and "not yours" — a 403 would confirm the boundary exists.
      return res.status(404).json({ error: 'Boundary not found' });
    }
    return res.json(served(boundary));
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

    return res.status(201).json(served(saved));
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

    const unknown = Object.keys(req.body || {})
      .filter(key => !UPDATABLE_KEYS.includes(key) && !IGNORED_KEYS.includes(key));
    if (unknown.length > 0) {
      return res.status(400).json({ error: `Unknown body parameter(s): ${unknown.join(', ')}` });
    }

    // type is the partition key, so it is never reassigned. `read` derives from `isPublished`,
    // never from the body, so the two cannot disagree.
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

    // Records the publish flip as project.update does: it changes who can read the boundary.
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

    return res.json(served(saved));
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
