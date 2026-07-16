'use strict';

require('dotenv').config();

const app = require('./app');
const { logger } = require('./utils/logger');

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  logger.info(`DEMI Central API Server running on port ${PORT}`);
  logger.info(`OpenAPI documentation available at http://localhost:${PORT}/api-docs`);

  // Start the self-contained Typesense Change Stream sync watcher in the background
  if (process.env.NODE_ENV !== 'test') {
    try {
      const typesenseSync = require('./typesense/index');
      typesenseSync.start();
      logger.info('Self-contained DEMI Typesense sync watcher started.');
    } catch (err) {
      logger.error('Failed to start DEMI Typesense sync watcher:', { error: err.message, stack: err.stack });
    }
  }
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
