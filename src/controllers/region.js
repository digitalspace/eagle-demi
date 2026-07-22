'use strict';

const mongoose = require('mongoose');
const Region = require('../models/region');

exports.getRegions = async (req, res) => {
  try {
    const regions = await Region.find({}).lean();
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

    const newRegion = new Region({
      name,
      geometry
    });

    const saved = await newRegion.save();
    return res.status(201).json(saved);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Region with that name already exists' });
    }
    return res.status(500).json({ error: err.message });
  }
};

exports.getRegion = async (req, res) => {
  try {
    const { id } = req.params;
    const query = mongoose.Types.ObjectId.isValid(id) ? { _id: id } : { name: id };

    const region = await Region.findOne(query).lean();
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
    const query = mongoose.Types.ObjectId.isValid(id) ? { _id: id } : { name: id };

    const updated = await Region.findOneAndUpdate(query, req.body, { new: true, runValidators: true });
    if (!updated) {
      return res.status(404).json({ error: 'Region not found' });
    }
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.deleteRegion = async (req, res) => {
  try {
    const { id } = req.params;
    const query = mongoose.Types.ObjectId.isValid(id) ? { _id: id } : { name: id };

    const deleted = await Region.findOneAndDelete(query);
    if (!deleted) {
      return res.status(404).json({ error: 'Region not found' });
    }
    return res.json({ message: 'Region deleted successfully', deleted });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
