'use strict';

/**
 * `fetchJson` is stubbed by every other seed test, so its own contract is only covered here: the
 * caller's headers reach `fetch`. The Track team feed is unauthorised without them.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { fetchJson } = require('../../src/seed/sources');

test('fetchJson passes the caller headers to fetch', async (t) => {
  const calls = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ items: [] }) };
  });

  const body = await fetchJson('https://track.example/api/v1/projects/team-members',
    { Authorization: 'Bearer track-token' });

  assert.deepStrictEqual(body, { items: [] });
  assert.strictEqual(calls.length, 1, 'one attempt, no retry');
  assert.strictEqual(calls[0].url, 'https://track.example/api/v1/projects/team-members');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer track-token');
});
