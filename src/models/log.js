'use strict';

const mongoose = require('mongoose');
const config = require('../config');

const LogSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  level: { type: String, required: true },
  message: { type: String, required: true },
  requestId: { type: String, default: '' },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  stack: { type: String, default: '' }
}, {
  timestamps: false, // Explicit timestamp property used instead
  capped: {
    size: config.logCappedSizeBytes, // e.g. 50MB
    max: config.logCappedMaxDocuments // e.g. 100,000 documents
  }
});

LogSchema.index({ level: 1, timestamp: -1 });
LogSchema.index({ requestId: 1 });
LogSchema.index({ timestamp: -1 });

module.exports = mongoose.model('Log', LogSchema);

