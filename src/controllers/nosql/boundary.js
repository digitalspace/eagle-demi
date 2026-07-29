'use strict';

/**
 * Administrative boundaries — Cosmos NoSQL.
 *
 * Public reference geodata, so no ACL applies (see repositories/boundaries.js).
 *
 * Items now store simplified geometry only; full-resolution GeoJSON is a build artifact
 * served as a static asset, which the frontend already prefers. The old three-way
 * geometry=false|true|simplified juggling collapses to: omit geometry, or return the item.
 */

const boundaries = require('../../repositories/boundaries');

exports.getBoundaries = async (req, res) => {
  try {
    // Reference data changes rarely and the frontend fetches it on every map load.
    if (typeof res.setHeader === 'function') {
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    }

    const { type, geometry } = req.query;
    const { items } = await boundaries.listByType(type, {
      withGeometry: geometry !== 'false'
    });

    return res.json(items);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.getBoundary = async (req, res) => {
  try {
    const boundary = await boundaries.getById(req.params.id, req.query.type);
    if (!boundary) {
      return res.status(404).json({ error: 'Boundary not found' });
    }
    return res.json(boundary);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.createBoundary = async (req, res) => {
  try {
    const { type, name, code, geometry } = req.body;
    if (!type || !name) {
      return res.status(400).json({ error: 'Missing required fields: type, name' });
    }

    const saved = await boundaries.upsert({
      id: `${type}_${name}`,
      type,
      name,
      code: code || '',
      geometry: geometry || null,
      updatedAt: new Date().toISOString()
    });

    return res.status(201).json(saved);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.updateBoundary = async (req, res) => {
  try {
    const existing = await boundaries.getById(req.params.id, req.query.type);
    if (!existing) {
      return res.status(404).json({ error: 'Boundary not found' });
    }

    // type is the partition key — reassigning it is a delete-and-reinsert, not an update.
    const { id: _ignoredId, type: _ignoredPk, ...changes } = req.body;

    const saved = await boundaries.upsert({
      ...existing,
      ...changes,
      id: existing.id,
      type: existing.type,
      updatedAt: new Date().toISOString()
    });

    return res.json(saved);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.deleteBoundary = async (req, res) => {
  try {
    const existing = await boundaries.getById(req.params.id, req.query.type);
    if (!existing) {
      return res.status(404).json({ error: 'Boundary not found' });
    }

    await boundaries.deleteById(existing.id, existing.type);
    return res.json({ message: 'Boundary deleted successfully', deleted: existing });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
