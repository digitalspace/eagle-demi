'use strict';

const mongoose = require('mongoose');

const BoundarySchema = new mongoose.Schema({
  type: { type: String, required: true }, // 'Regional District', 'Municipality', 'Electoral District'
  name: { type: String, required: true },
  code: { type: String, default: '' },
  geometry: {
    type: { type: String, enum: ['Polygon', 'MultiPolygon'], required: true },
    coordinates: { type: mongoose.Schema.Types.Mixed, required: true }
  },
  simplifiedGeometry: {
    type: { type: String, enum: ['Polygon', 'MultiPolygon'] },
    coordinates: { type: mongoose.Schema.Types.Mixed }
  }
}, { timestamps: true });

BoundarySchema.index({ type: 1, name: 1 }, { unique: true });
BoundarySchema.index({ type: 1, simplifiedGeometry: '2dsphere' });
BoundarySchema.index({ geometry: '2dsphere' });

module.exports = mongoose.model('Boundary', BoundarySchema, 'administrative_boundaries');

