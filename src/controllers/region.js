'use strict';

const Region = require('../models/region');

exports.getRegions = async (req, res) => {
  try {
    const regions = await Region.find({}, { sort: { name: 1 } });
    return res.json(regions);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.createRegion = async (req, res) => {
  try {
    const { name, geometry } = req.body;

    if (!name || !geometry || !geometry.coordinates) {
      return res.status(400).json({ error: 'Missing required fields: name, geometry' });
    }

    const newRegion = {
      _id: name,
      name,
      geometry
    };

    const saved = await Region.upsert(newRegion);
    return res.status(201).json(saved);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.getRegion = async (req, res) => {
  try {
    const { id } = req.params;
    let region = await Region.findById(id);
    if (!region) {
      region = await Region.findOne({ name: String(id) });
    }
    if (!region) {
      return res.status(404).json({ error: 'Region not found' });
    }
    return res.json(region);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.updateRegion = async (req, res) => {
  try {
    const { id } = req.params;
    let existing = await Region.findById(id);
    if (!existing) {
      existing = await Region.findOne({ name: String(id) });
    }
    if (!existing) {
      return res.status(404).json({ error: 'Region not found' });
    }

    const updated = { ...existing, ...req.body };
    const saved = await Region.upsert(updated);
    return res.json(saved);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.deleteRegion = async (req, res) => {
  try {
    const { id } = req.params;
    let existing = await Region.findById(id);
    if (!existing) {
      existing = await Region.findOne({ name: String(id) });
    }
    if (!existing) {
      return res.status(404).json({ error: 'Region not found' });
    }

    await Region.deleteById(existing._id);
    return res.json({ message: 'Region deleted successfully', deleted: existing });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
