'use strict';

// Not `src/utils/logger.js`: that one loads `src/config.js`, which refuses to load without the
// API's app settings, so the sync app could not start.
const winston = require('winston');
const { format, transports } = winston;

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  exitOnError: false,
  transports: [
    new transports.Console({
      handleExceptions: true,
      format: format.combine(format.errors({ stack: true }), format.timestamp(), format.json())
    })
  ]
});

module.exports = { logger };
