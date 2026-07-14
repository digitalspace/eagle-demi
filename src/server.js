'use strict';

require('dotenv').config();

const app = require('./app');

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`DEMI Central API Server running on port ${PORT}`);
  console.log(`OpenAPI documentation available at http://localhost:${PORT}/api-docs`);

  // Start the self-contained Typesense Change Stream sync watcher in the background
  if (process.env.NODE_ENV !== 'test') {
    try {
      const typesenseSync = require('./typesense/index');
      typesenseSync.start();
      console.log('Self-contained DEMI Typesense sync watcher started.');
    } catch (err) {
      console.error('Failed to start DEMI Typesense sync watcher:', err.message);
    }
  }
});

// Handle Graceful Shutdown
const shutdown = () => {
  console.log('Received kill signal, shutting down gracefully...');
  server.close(() => {
    console.log('Closed out remaining connections.');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down.');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
