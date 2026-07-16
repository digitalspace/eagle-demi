'use strict';

const winston = require('winston');
const { format, transports } = winston;
const { AsyncLocalStorage } = require('async_hooks');
const mongoose = require('mongoose');
const config = require('../config');

// Asynchronous Context Tracking for Request/Correlation IDs
const asyncLocalStorage = new AsyncLocalStorage();

// Winston formatter to pull requestId dynamically from AsyncLocalStorage
const requestIdFormat = format((info) => {
  const store = asyncLocalStorage.getStore();
  if (store && store.requestId) {
    info.requestId = store.requestId;
  }
  return info;
});

// Custom Winston Transport to write to the MongoDB Capped Collection
class MongoCappedTransport extends winston.Transport {
  constructor(opts) {
    super(opts);
    this.name = 'MongoCappedTransport';
    this.level = opts.level || 'info';
  }

  log(info, callback) {
    setImmediate(() => {
      this.emit('logged', info);
    });

    // Write to DB only if connection is healthy
    if (mongoose.connection && mongoose.connection.readyState === 1) {
      try {
        const LogModel = mongoose.model('Log');
        
        // Extract meta fields excluding default winston fields
        const { timestamp, level, message, requestId, stack, ...meta } = info;

        const logEntry = new LogModel({
          timestamp: timestamp ? new Date(timestamp) : new Date(),
          level: level,
          message: message,
          requestId: requestId || '',
          meta: meta || {},
          stack: stack || ''
        });

        logEntry.save().catch((err) => {
          // Fallback to direct stderr print without looping back to Winston
          process.stderr.write(`[MongoCappedTransport Error] Failed to write log: ${err.message}\n`);
        });
      } catch (err) {
        // Model may not be registered yet, gracefully ignore
      }
    }

    callback();
  }
}

// Set up logger formats
const isProduction = process.env.NODE_ENV === 'production';

const defaultTransports = [
  // 1. Console Transport
  new transports.Console({
    level: config.logLevel,
    handleExceptions: true,
    format: format.combine(
      format.errors({ stack: true }),
      requestIdFormat(),
      format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      isProduction
        ? format.json()
        : format.printf(({ timestamp, level, message, requestId, stack }) => {
            const reqTag = requestId ? ` [${requestId}]` : '';
            const msg = stack ? `${message}\n${stack}` : message;
            // ANSI escape codes for level colorizing in local dev
            let colorLevel = level.toUpperCase();
            if (level === 'info') colorLevel = `\x1b[32m${colorLevel}\x1b[0m`; // Green
            else if (level === 'error') colorLevel = `\x1b[31m${colorLevel}\x1b[0m`; // Red
            else if (level === 'warn') colorLevel = `\x1b[33m${colorLevel}\x1b[0m`; // Yellow
            else if (level === 'debug') colorLevel = `\x1b[36m${colorLevel}\x1b[0m`; // Cyan

            return `${timestamp} ${colorLevel}${reqTag}: ${msg}`;
          })
    )
  }),

  // 2. Custom MongoDB Capped Transport
  new MongoCappedTransport({
    level: config.logLevel
  })
];

const logger = winston.createLogger({
  level: config.logLevel,
  transports: defaultTransports,
  exitOnError: false
});

module.exports = {
  logger,
  asyncLocalStorage,
  
  /**
   * Run a function within a logging request context.
   * @param {string} requestId - Unique ID of the current request execution chain.
   * @param {Function} callback - Function/Async Function to invoke.
   * @returns {*}
   */
  runWithRequestId: (requestId, callback) => {
    return asyncLocalStorage.run({ requestId }, callback);
  }
};
