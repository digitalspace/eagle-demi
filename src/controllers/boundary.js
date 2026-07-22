'use strict';

const mongoose = require('mongoose');
const Boundary = require('../models/boundary');
const { parseBboxPolygon } = require('../helpers/geo');

exports.getBoundaries = async (req, res) => {
  try {
    const { type, geometry, bbox } = req.query;
    
    let spatialQuery = {};
    if (bbox) {
      const parsedBbox = parseBboxPolygon(bbox);
      if (parsedBbox) {
        spatialQuery = {
          geometry: {
            $geoIntersects: {
              $geometry: parsedBbox
            }
          }
        };
      }
    }

    const query = {
      ...(type ? { type } : {}),
      ...spatialQuery
    };

    // Optimize database projection based on requested geometry mode
    let projection = {};
    if (geometry === 'true') {
      projection = { simplifiedGeometry: 0 };
    } else if (geometry === 'false') {
      projection = { geometry: 0, simplifiedGeometry: 0 };
    } else {
      projection = { geometry: 0 };
    }

    let boundaries = await Boundary.find(query, projection).lean();

    if (geometry !== 'true' && geometry !== 'false') {
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

    const newBoundary = new Boundary({
      type,
      name,
      code,
      geometry
    });

    const saved = await newBoundary.save();
    return res.status(201).json(saved);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.getBoundary = async (req, res) => {
  try {
    const { id } = req.params;
    const query = mongoose.Types.ObjectId.isValid(id) ? { _id: id } : { name: id };

    const boundary = await Boundary.findOne(query).lean();
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
    const query = mongoose.Types.ObjectId.isValid(id) ? { _id: id } : { name: id };

    const updated = await Boundary.findOneAndUpdate(query, req.body, { new: true, runValidators: true });
    if (!updated) {
      return res.status(404).json({ error: 'Boundary not found' });
    }
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.deleteBoundary = async (req, res) => {
  try {
    const { id } = req.params;
    const query = mongoose.Types.ObjectId.isValid(id) ? { _id: id } : { name: id };

    const deleted = await Boundary.findOneAndDelete(query);
    if (!deleted) {
      return res.status(404).json({ error: 'Boundary not found' });
    }
    return res.json({ message: 'Boundary deleted successfully', deleted });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
