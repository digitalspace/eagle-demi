'use strict';

const mongoose = require('mongoose');

const BoundarySchema = new mongoose.Schema({
  type: { type: String, required: true, index: true }, // 'Regional District', 'Municipality'
  name: { type: String, required: true, index: true },
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

BoundarySchema.index({ geometry: '2dsphere' });
BoundarySchema.index({ simplifiedGeometry: '2dsphere' });

module.exports = mongoose.model('Boundary', BoundarySchema, 'administrative_boundaries');
