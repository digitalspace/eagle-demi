'use strict';

// Fake eagle-api, Keycloak and sync-out queue for the sync-out consumer suites.

const assert = require('node:assert');
const queues = require('../../src/jobs/queue-client');
const config = require('../../src/config');

const API = 'https://eagle.example/api';
const ISSUER = config.keycloakIssuer;

/** Set `env` for one test, restoring each value after it. */
function useEnv(t, env) {
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

function wireQueue(t) {
  const sent = [];
  t.mock.method(queues, 'queueClientFor', ({ name }) => ({
    sendMessage: async (body) => { sent.push({ queue: name, body: JSON.parse(body) }); }
  }));
  return sent;
}

/**
 * Fake eagle-api and Keycloak. `routes` maps `METHOD path` or `METHOD *` to a reply, a list served in order, or a
 * function of the request body; `{ lost: true }` rejects as a dropped connection, `{ body: null }` answers `null`.
 */
function wireEagle(t, routes) {
  const calls = [];
  const served = {};
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url === `${ISSUER}/protocol/openid-connect/token`) return Response.json({ access_token: 'token', expires_in: 300 });
    const key = `${method} ${url.slice(API.length)}`;
    const route = routes[key] || routes[`${method} *`];
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    // Recorded before the check: the engine turns the thrown assertion into a retry, not a test failure.
    calls.push({ key, body });
    assert.ok(route, `unexpected eagle-api call ${key}`);
    const index = served[key] = (served[key] || 0) + 1;
    const listed = Array.isArray(route) ? route[Math.min(index, route.length) - 1] : route;
    const reply = typeof listed === 'function' ? await listed(body) : listed;
    if (reply.lost) throw new TypeError('fetch failed');
    return Response.json(reply.body === undefined ? {} : reply.body, { status: reply.status || 200 });
  });
  return calls;
}

const keys = calls => calls.map(c => c.key);

module.exports = { API, useEnv, wireQueue, wireEagle, keys };
