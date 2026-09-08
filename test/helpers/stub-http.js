'use strict';

/**
 * A real socket, because the thing under test is a shell script holding a real `curl`.
 *
 * The in-process `with-server` helper cannot serve these suites: `scripts/search-schema-probe.sh`
 * and `scripts/search-smoke.sh` are what production CI runs, and their whole job is turning HTTP
 * statuses into exit codes.
 */

const http = require('node:http');
const { execFile } = require('node:child_process');

/**
 * Start a stub on loopback.
 *
 * `destroy` kills the connection without answering, which is how a caller sees the
 * never-completed request that curl reports as status 000.
 *
 * @param {(req: import('node:http').IncomingMessage, body: string) =>
 *   { status?: number, body?: string, json?: unknown, destroy?: boolean }} respond
 * @returns {Promise<{ url: string, requests: Array<{ method: string, url: string, body: string }>,
 *   close: () => Promise<void> }>}
 */
async function startStub(respond) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, body });
      const answer = respond(req, body) || {};
      if (answer.destroy) return req.socket.destroy();
      const payload = answer.json === undefined ? (answer.body || '') : JSON.stringify(answer.json);
      res.writeHead(answer.status || 200, { 'content-type': 'application/json' });
      res.end(payload);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/**
 * Run a script and resolve with its exit code and output.
 *
 * ASYNC ON PURPOSE. `spawnSync` blocks the event loop, so the stub above — same process — never
 * answers, and every request sits until curl's own timeout. The suite deadlocks rather than fails,
 * which is worse than either.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string> }} [opts]
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
function runScript(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      encoding: 'utf8',
      timeout: 60000
    }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') return reject(err);
      resolve({ status: err ? err.code : 0, stdout, stderr });
    });
  });
}

module.exports = { startStub, runScript };
