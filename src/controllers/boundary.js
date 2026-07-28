'use strict';

const Boundary = require('../models/boundary');

exports.getBoundaries = async (req, res) => {
  try {
    if (typeof res.setHeader === 'function') {
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    }
    const { type, geometry } = req.query;
    const conditions = [];
    const parameters = [];

    if (type) {
      parameters.push({ name: '@type', value: String(type) });
      conditions.push('c.type = @type');
    }

    const whereClause = conditions.length > 0 ? conditions.join(' AND ') : '';
    let boundaries = await Boundary.find(whereClause, parameters, { orderBy: 'c.name ASC' });

    if (geometry === 'true') {
      boundaries = boundaries.map(b => {
        delete b.simplifiedGeometry;
        return b;
      });
    } else if (geometry !== 'false') {
      boundaries = boundaries.map(b => {
        if (!b.simplifiedGeometry && b.geometry) {
          b.simplifiedGeometry = b.geometry;
        }
        delete b.geometry;
        return b;
      });
    }

    return res.json(boundaries);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.createBoundary = async (req, res) => {
  try {
    const { type, name, code, geometry } = req.body;

    if (!type || !name || !geometry || !geometry.coordinates) {
      return res.status(400).json({ error: 'Missing required fields: type, name, geometry' });
    }

    const newBoundary = {
      _id: `${type}_${name}`,
      type,
      name,
      code: code || '',
      geometry
    };

    const saved = await Boundary.upsert(newBoundary);
    return res.status(201).json(saved);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.getBoundary = async (req, res) => {
  try {
    const { id } = req.params;
    let boundary = await Boundary.findById(id);
    if (!boundary) {
      boundary = await Boundary.findOne('c.name = @name', [{ name: '@name', value: id }]);
    }
    if (!boundary) {
      return res.status(404).json({ error: 'Boundary not found' });
    }
    return res.json(boundary);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.updateBoundary = async (req, res) => {
  try {
    const { id } = req.params;
    let existing = await Boundary.findById(id);
    if (!existing) {
      existing = await Boundary.findOne('c.name = @name', [{ name: '@name', value: id }]);
    }
    if (!existing) {
      return res.status(404).json({ error: 'Boundary not found' });
    }

    const updated = { ...existing, ...req.body };
    const saved = await Boundary.upsert(updated);
    return res.json(saved);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.deleteBoundary = async (req, res) => {
  try {
    const { id } = req.params;
    let existing = await Boundary.findById(id);
    if (!existing) {
      existing = await Boundary.findOne('c.name = @name', [{ name: '@name', value: id }]);
    }
    if (!existing) {
      return res.status(404).json({ error: 'Boundary not found' });
    }

    await Boundary.deleteById(existing._id);
    return res.json({ message: 'Boundary deleted successfully', deleted: existing });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
