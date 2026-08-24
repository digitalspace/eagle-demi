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

// Logs go to stdout only — a database round trip per log line is not this module's job.
//
// Shipping is wired in `api/index.js`, which starts the Azure Monitor OpenTelemetry distro with
// winston instrumentation enabled. That hooks this logger and forwards each line to Application
// Insights, correlated with the request trace. No transport is added here, and none should be —
// with no APPLICATIONINSIGHTS_CONNECTION_STRING (local development, tests, `yarn start`) nothing
// starts and this stays a plain stdout logger.
//
// The `requestId` below predates that and still earns its place: it survives into the exported
// telemetry as a log field, and it is what correlates lines written outside any OpenTelemetry span.

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
