'use strict';

const mongoose = require('mongoose');

const DocumentSchema = new mongoose.Schema({
  project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  displayName: { type: String, required: true },
  s3Key: { type: String, required: true, unique: true },
  region: { type: String, default: '', index: true },
  edrmsRecordNumber: { type: String, unique: true, sparse: true, index: true },
  orcsClassification: { type: String, default: '', index: true },
  isPublished: { type: Boolean, default: false, index: true }, // Root-level security flag

  // Content extraction fields
  contentExtracted: { type: Boolean, default: false, index: true },
  contentExtractedAt: { type: Date, default: null },
  contentPageCount: { type: Number, default: 0 },
  contentExtractionError: { type: String, default: null },
  extractionMethod: { type: String, default: '' }
}, { timestamps: true });

DocumentSchema.index({ displayName: 'text', orcsClassification: 'text' });

module.exports = mongoose.model('Document', DocumentSchema);
