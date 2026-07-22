'use strict';

const mongoose = require('mongoose');

const DocumentSchema = new mongoose.Schema({
  project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
  displayName: { type: String, required: true },
  s3Key: { type: String, required: true, unique: true },
  region: { type: String, default: '' },
  edrmsRecordNumber: { type: String, unique: true, sparse: true },
  orcsClassification: { type: String, default: '' },
  isPublished: { type: Boolean, default: false }, // Root-level security flag
  read: { type: [String], default: ['sysadmin', 'staff'] },

  // Content extraction fields
  contentExtracted: { type: Boolean, default: false },
  contentExtractedAt: { type: Date, default: null },
  contentPageCount: { type: Number, default: 0 },
  contentExtractionError: { type: String, default: null },
  extractionMethod: { type: String, default: '' }
}, { timestamps: true });

// Compound Indexes (ESR Rule for Scaling & Permissions)
DocumentSchema.index({ project: 1, isPublished: 1 });
DocumentSchema.index({ isPublished: 1, region: 1 });
DocumentSchema.index({ read: 1, project: 1 });
DocumentSchema.index({ contentExtracted: 1, isPublished: 1, createdAt: -1 });

// Helper to strip sensitive internal fields for public responses
DocumentSchema.methods.toPublicJSON = function() {
  const obj = this.toObject();
  delete obj.s3Key;
  delete obj.orcsClassification;
  delete obj.contentExtractionError;
  return obj;
};

module.exports = mongoose.model('Document', DocumentSchema);

