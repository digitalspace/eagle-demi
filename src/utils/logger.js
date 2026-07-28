'use strict';

const winston = require('winston');
const { format, transports } = winston;
const { AsyncLocalStorage } = require('async_hooks');
const LogModel = require('../models/log');
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

// Custom Winston Transport to write logs to Azure Cosmos DB
class CosmosLogTransport extends winston.Transport {
  constructor(opts) {
    super(opts);
    this.name = 'CosmosLogTransport';
    this.level = opts.level || 'info';
  }

  log(info, callback) {
    setImmediate(() => {
      this.emit('logged', info);
    });

    try {
      const { timestamp, level, message, requestId, stack, ...meta } = info;
      LogModel.upsert({
        timestamp: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString(),
        level: level,
        message: message,
        requestId: requestId || '',
        meta: meta || {},
        stack: stack || ''
      }).catch((err) => {
        process.stderr.write(`[CosmosLogTransport Error] Failed to write log: ${err.message}\n`);
      });
    } catch (_err) {
      // Gracefully ignore during shutdown or startup
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
            let colorLevel = level.toUpperCase();
            if (level === 'info') colorLevel = `\x1b[32m${colorLevel}\x1b[0m`;
            else if (level === 'error') colorLevel = `\x1b[31m${colorLevel}\x1b[0m`;
            else if (level === 'warn') colorLevel = `\x1b[33m${colorLevel}\x1b[0m`;
            else if (level === 'debug') colorLevel = `\x1b[36m${colorLevel}\x1b[0m`;

            return `${timestamp} ${colorLevel}${reqTag}: ${msg}`;
          })
    )
  }),

  // 2. Custom Cosmos DB Transport
  new CosmosLogTransport({
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
