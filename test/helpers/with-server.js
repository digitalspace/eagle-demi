'use strict';

/**
 * Boot the real Express app on an ephemeral port and hand the caller its base URL.
 *
 * `node:http` and global `fetch` rather than supertest — no new dependency for what ten lines
 * already do. Shared because two suites need a real request: the boot test, and the tripwire that
 * reads raw response TEXT rather than a parsed body.
 */

const http = require('node:http');

async function withServer(fn) {
  const app = require('../../src/app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

module.exports = { withServer };
