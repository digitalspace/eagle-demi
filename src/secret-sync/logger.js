'use strict';

// The sync app's own logger, deliberately not `src/utils/logger.js`: that one reads its level from
// `src/config.js`, which is the API's configuration — it parses the API's host.json and refuses to
// load without the API's app settings. Pulling it into this zip made the entry point unloadable.
//
// Same interface subset the sync code uses (info/warn/error/debug) and the same transport story:
// stdout only, picked up by the Functions host. `src/secret-sync/index.js` starts the Azure Monitor
// distro with winston instrumentation before this module is required, so each line is forwarded to
// Application Insights when APPLICATIONINSIGHTS_CONNECTION_STRING is set, and is a plain stdout
// line when it is not.
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
