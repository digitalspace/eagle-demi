'use strict';

/**
 * `fetchJson` is stubbed by every other seed test, so its own contract is only covered here: the
 * caller's headers reach `fetch`. The Track team feed is unauthorised without them.
 *
 * `loadTrackProjects` is covered here for the same reason — every other test injects it, so the
 * choice between the live feed and the checked-in export is only made for real in this file.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { fetchJson, loadTrackProjects } = require('../../src/seed/sources');

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

test('loadTrackProjects reads the checked-in export when no reader client is configured', async () => {
  const projects = await loadTrackProjects();

  assert.ok(projects.length > 300, `${projects.length} rows from the offline fixture`);
  assert.ok(projects.every(p => p.track_project_id), 'the flat shape the merge reads');
});

test('loadTrackProjects prefers the live feed once TRACK_API_BASE and the client are set', async (t) => {
  for (const [key, value] of Object.entries({
    TRACK_API_BASE: 'https://track.example', TRACK_CLIENT_ID: 'demi-track-reader',
    TRACK_CLIENT_SECRET: 'not-a-real-secret'
  })) {
    const held = process.env[key];
    process.env[key] = value;
    t.after(() => { if (held === undefined) delete process.env[key]; else process.env[key] = held; });
  }
  // config caches process.env at require time, so the module has to be re-read with them set.
  delete require.cache[require.resolve('../../src/config')];
  delete require.cache[require.resolve('../../src/seed/sources')];
  t.after(() => {
    delete require.cache[require.resolve('../../src/config')];
    delete require.cache[require.resolve('../../src/seed/sources')];
  });
  const sources = require('../../src/seed/sources');

  const urls = [];
  t.mock.method(global, 'fetch', async (url) => {
    urls.push(String(url));
    return String(url).endsWith('/token')
      ? { ok: true, json: async () => ({ access_token: 'track-token' }) }
      : { ok: true, json: async () => [{ id: 207, name: 'Nicomen', project_state: { name: 'Closed' } }] };
  });

  const projects = await sources.loadTrackProjects();

  assert.deepStrictEqual(projects.map(p => p.track_project_id), [207], 'the feed, not the 382-row file');
  assert.strictEqual(projects[0].project_state_name, 'Closed', 'and mapped to the flat shape');
  assert.ok(urls.some(u => u.endsWith('/api/v1/projects')), urls.join(', '));
});
