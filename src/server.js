'use strict';

require('dotenv').config();

const app = require('./app');
const { logger } = require('./utils/logger');

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  logger.info(`DEMI Central API Server running on port ${PORT}`);
  logger.info(`OpenAPI documentation available at http://localhost:${PORT}/api-docs`);

  // The Typesense change-stream watcher was removed. It could never run against Cosmos:
  // it gated on db.command({hello:1}) reporting a replica-set name, which the Mongo API
  // never returns, so it exited immediately on every boot. Typesense is kept current by
  // the nightly full sync (alias swap); real-time sync returns with the Cosmos change feed.
});

// Handle Graceful Shutdown
const shutdown = () => {
  logger.info('Received kill signal, shutting down gracefully...');
  server.close(() => {
    logger.info('Closed out remaining connections.');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down.');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
