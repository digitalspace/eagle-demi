'use strict';

const mongoose = require('mongoose');
const config = require('../config');

const LogSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now, index: true },
  level: { type: String, required: true, index: true },
  message: { type: String, required: true },
  requestId: { type: String, default: '', index: true },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  stack: { type: String, default: '' }
}, {
  timestamps: false, // Explicit timestamp property used instead
  capped: {
    size: config.logCappedSizeBytes, // e.g. 50MB
    max: config.logCappedMaxDocuments // e.g. 100,000 documents
  }
});

module.exports = mongoose.model('Log', LogSchema);
