'use strict';

const mongoose = require('mongoose');

const RegionSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  geometry: {
    type: { type: String, enum: ['Polygon', 'MultiPolygon'], required: true },
    coordinates: { type: mongoose.Schema.Types.Mixed, required: true }
  }
}, { timestamps: true });

RegionSchema.index({ geometry: '2dsphere' });

module.exports = mongoose.model('Region', RegionSchema);

