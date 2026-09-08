'use strict';

/**
 * GET /config/public — the payload eagle-public boots on.
 *
 * Two things are asserted that nothing else can see. First the allowlist: this document is a copy
 * of eagle-api's Mongo `Config`, so anything that lands there lands here, and only PUBLIC_KEYS may
 * reach an anonymous caller. Second the refusal: where /config degrades to app settings, this
 * route answers 503, because the safe answer to "I do not know whether the access curtain is
 * closed" is not `ACCESS_GATE: false`.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const configRepository = require('../../src/repositories/config');
const configController = require('../../src/controllers/config');
const { withServer } = require('../helpers/with-server');

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    json(data) { this.body = data; return this; }
  };
}

const REQ = { query: {}, params: {}, body: {} };

/** What a seeded document looks like, plus a field the allowlist has to keep out. */
const STORED = {
  id: 'public',
  ENVIRONMENT: 'test',
  BANNER_COLOUR: 'orange',
  API_PATH: '/api',
  SEARCH_API_PATH: '/demi-search',
  DEMI_PROJECTS_PATH: '/demi-projects',
  ADMIN_PATH: '/admin',
  ACCESS_GATE: true,
  SECRET: 'hunter2',
  _rid: 'rid1',
  _ts: 1700000000
};

test('public config controller', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('serves the allowlisted keys and nothing else', async () => {
    t.mock.method(configRepository, 'getPublic', async () => STORED);
    const res = mockRes();

    await configController.getPublicConfig(REQ, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.SEARCH_API_PATH, '/demi-search');
    assert.equal(res.body.ACCESS_GATE, true);
    // The document is a copy of a collection somebody edits by hand: a field added there must not
    // become public just by existing.
    assert.ok(!('SECRET' in res.body), 'a non-allowlisted field reached an anonymous caller');
    assert.ok(!('id' in res.body));
    assert.ok(!('_rid' in res.body));
    for (const key of Object.keys(res.body)) {
      assert.ok(configController.PUBLIC_KEYS.includes(key), `${key} is not in PUBLIC_KEYS`);
    }
  });

  await t.test('defaults nothing — an absent key stays absent', async () => {
    t.mock.method(configRepository, 'getPublic', async () => ({ id: 'public', ENVIRONMENT: 'test' }));
    const res = mockRes();

    await configController.getPublicConfig(REQ, res);

    assert.deepEqual(res.body, { ENVIRONMENT: 'test' });
    // A defaulted SEARCH_API_PATH would silently move the public site's search backend.
    assert.ok(!('SEARCH_API_PATH' in res.body));
    assert.ok(!('ACCESS_GATE' in res.body));
  });

  await t.test('a stored ACCESS_GATE false is served as boolean false', async () => {
    // Skipping falsy values is the exact bug that would open the curtain on an environment that
    // deliberately turned the gate off, so `false` has to survive as itself.
    t.mock.method(configRepository, 'getPublic', async () => ({
      id: 'public', ENVIRONMENT: 'test', ACCESS_GATE: false, SHOW_SURVEY_BANNER: false
    }));
    const res = mockRes();

    await configController.getPublicConfig(REQ, res);

    assert.equal(res.body.ACCESS_GATE, false);
    assert.equal(typeof res.body.ACCESS_GATE, 'boolean');
    assert.equal(res.body.SHOW_SURVEY_BANNER, false);
  });

  await t.test('503 and no-store when the document is not seeded', async () => {
    t.mock.method(configRepository, 'getPublic', async () => null);
    const res = mockRes();

    await configController.getPublicConfig(REQ, res);

    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.ok(!('ACCESS_GATE' in res.body), 'a refusal must not carry a defaulted gate value');
  });

  await t.test('503 and no-store when the read throws', async () => {
    t.mock.method(configRepository, 'getPublic', async () => {
      throw new Error('private endpoint down');
    });
    const res = mockRes();

    await configController.getPublicConfig(REQ, res);

    // /config degrades to app settings here. This one must not: eagle-public falls back to
    // eagle-api on a 503, and a guessed payload is what it cannot detect.
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['cache-control'], 'no-store');
  });
});

test('the documented payload is the served one', () => {
  // The swagger PublicConfig schema is the only published statement of what an anonymous caller
  // gets, and it is hand-maintained. Text-scanned rather than parsed: there is no YAML parser in
  // this project's dependencies, and the failure this guards against is forgetting, not evasion.
  const yaml = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'swagger', 'swagger.yaml'), 'utf8').split('\n');

  const start = yaml.indexOf('    PublicConfig:');
  assert.ok(start > 0, 'the PublicConfig schema is gone from swagger.yaml');
  const end = yaml.findIndex((line, i) => i > start && /^ {4}\S/.test(line));
  const documented = yaml.slice(start, end)
    .map((line) => /^ {8}([A-Z_]+):$/.exec(line))
    .filter(Boolean)
    .map((m) => m[1]);

  assert.deepEqual(documented.sort(), [...configController.PUBLIC_KEYS].sort());
});

test('public config over the dispatcher', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('answers at /api/config/public and /config/public without shadowing /config', async () => {
    t.mock.method(configRepository, 'getPublic', async () => STORED);
    t.mock.method(configRepository, 'get', async () => null);

    await withServer(async (call) => {
      for (const path of ['/api/config/public', '/config/public']) {
        const res = await call(path);
        assert.equal(res.status, 200, path);
        const body = await res.json();
        assert.equal(body.SEARCH_API_PATH, '/demi-search', path);
        assert.ok(!('SECRET' in body), path);
      }

      // The route table is matched with anchored regexes, so the longer path must not have eaten
      // the shorter one — /config still answers the admin console's payload.
      const base = await call('/api/config');
      assert.equal(base.status, 200);
      const baseBody = await base.json();
      assert.equal(baseBody.configEndpoint, true);
      assert.ok('BUILD_ID' in baseBody);
      assert.ok(!('SEARCH_API_PATH' in baseBody), '/config started answering the public payload');
    });
  });

  await t.test('an unseeded document is a 503 the edge will not cache', async () => {
    t.mock.method(configRepository, 'getPublic', async () => null);

    await withServer(async (call) => {
      const res = await call('/api/config/public');
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    });
  });
});
