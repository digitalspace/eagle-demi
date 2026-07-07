'use strict';

const mongoose = require('mongoose');

const ProjectSchema = new mongoose.Schema({
  trackProjectId: { type: Number, required: true, unique: true, index: true },
  name: { type: String, required: true },
  region: { type: String, default: '', index: true },
  centroid: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true } // [longitude, latitude] standard GeoJSON order
  },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true, strict: false });

ProjectSchema.index({ centroid: '2dsphere' });

module.exports = mongoose.model('Project', ProjectSchema);
