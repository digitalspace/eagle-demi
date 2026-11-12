'use strict';

const winston = require('winston');
const { format, transports } = winston;
const { AsyncLocalStorage } = require('async_hooks');
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

// Stdout only. `api/index.js` starts the Azure Monitor OpenTelemetry distro, which forwards these
// lines to Application Insights, so add no transport here.

// Set up logger formats
const isProduction = process.env.NODE_ENV === 'production';
// Under the test runner a swallowed uncaught exception would let a broken test file exit 0.
const underTest = Boolean(process.env.NODE_TEST_CONTEXT) || process.env.NODE_ENV === 'test';

const defaultTransports = [
  // 1. Console Transport
  new transports.Console({
    level: config.logLevel,
    handleExceptions: !underTest,
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
  })
];

const logger = winston.createLogger({
  level: config.logLevel,
  transports: defaultTransports,
  exitOnError: false
});

// Logged here, not in src/config.js: config cannot require this module without a require cycle.
// Names only, never values.
if (config.unresolvedSecrets.length > 0) {
  logger.error(
    '[config] Key Vault reference did not resolve, treated as unset: ' +
    `${config.unresolvedSecrets.join(', ')}. Check the app identity's Key Vault Secrets User ` +
    'role and that each secret still exists.'
  );
}

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
