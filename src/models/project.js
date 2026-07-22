'use strict';

const mongoose = require('mongoose');

const ProjectSchema = new mongoose.Schema({
  trackProjectId: { type: Number, required: true, unique: true },
  name: { type: String, required: true },
  region: { type: String, default: '' },
  isPublished: { type: Boolean, default: false }, // Covered by compound indexes
  read: { type: [String], default: ['sysadmin', 'staff'] },
  regionalDistrict: { type: String, default: '' },
  municipality: { type: String, default: '' },
  electoralDistrict: { type: String, default: '' },
  centroid: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true } // [longitude, latitude] standard GeoJSON order
  },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true, strict: true });

ProjectSchema.index({ centroid: '2dsphere' });
ProjectSchema.index({ isPublished: 1, region: 1 });
ProjectSchema.index({ isPublished: 1, regionalDistrict: 1 });
ProjectSchema.index({ isPublished: 1, municipality: 1 });
ProjectSchema.index({ read: 1 });

module.exports = mongoose.model('Project', ProjectSchema);

