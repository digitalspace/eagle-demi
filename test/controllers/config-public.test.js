'use strict';

/**
 * The `public` config document, both ends: GET /config/public serves it and
 * PUT /eagle/config/public is how eagle-api keeps it current.
 *
 * Two things are asserted about the read that nothing else can see. First the allowlist: this
 * document is a copy of eagle-api's Mongo `Config`, so anything that lands there lands here, and
 * only PUBLIC_KEYS may reach an anonymous caller. Second the refusal: where /config degrades to
 * app settings, this route answers 503, because the safe answer to "I do not know whether the
 * access curtain is closed" is not `ACCESS_GATE: false`.
 *
 * The push is asserted on the same allowlist from the other side — eagle-api sends its whole
 * /api/config and the KEYCLOAK_* block must not land in a document an anonymous site reads — plus
 * the two fields whose absence is dangerous rather than merely wrong, and the route chain that is
 * the only thing between the stored payload and an unauthenticated caller.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const apiKeys = require('../../src/repositories/api-keys');
const configRepository = require('../../src/repositories/config');
const configController = require('../../src/controllers/config');
const { generateKey } = require('../../src/helpers/api-key');
const { forgetCachedKey } = require('../../src/helpers/auth');
const { routeChains } = require('../helpers/router-source');
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

/**
 * eagle-api's live /api/config, as it pushes it: the allowlisted keys plus the ones this API must
 * not store. `ACCESS_GATE: false` and `SHOW_SURVEY_BANNER: false` are here deliberately — a filter
 * that drops falsy values would store neither, and the first of those opens the access curtain.
 */
const PUSHED = {
  ENVIRONMENT: 'test',
  BANNER_COLOUR: 'orange',
  API_PATH: '/api',
  SEARCH_API_PATH: '/demi-search',
  DEMI_PROJECTS_PATH: '/demi-projects',
  ACCESS_GATE: false,
  SHOW_SURVEY_BANNER: false,
  KEYCLOAK_URL: 'https://test.loginproxy.gov.bc.ca/auth',
  KEYCLOAK_CLIENT_ID: 'eagle-admin-console',
  BUILD_ID: 'abc1234',
  API_LOCATION: ''
};

/** What the two routes must agree on: the PUBLIC_KEYS half of the payload above. */
const SERVED = {
  ENVIRONMENT: 'test',
  BANNER_COLOUR: 'orange',
  API_PATH: '/api',
  SEARCH_API_PATH: '/demi-search',
  DEMI_PROJECTS_PATH: '/demi-projects',
  ACCESS_GATE: false,
  SHOW_SURVEY_BANNER: false
};

/**
 * An in-memory `public` document, so a push and the GET after it see the same container rather
 * than two stubs that could agree about nothing. The stored row carries the Cosmos system fields
 * an upsert really returns — the response must not.
 */
function stubDocument(t, initial = null) {
  let stored = initial;
  t.mock.method(configRepository, 'getPublic', async () => stored);
  t.mock.method(configRepository, 'upsertPublic', async (doc) => {
    stored = { ...doc, id: 'public', _rid: 'rid9', _ts: 1700000005 };
    return stored;
  });
  return () => stored;
}

test('public config push', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('stores only PUBLIC_KEYS and answers what the GET will serve', async () => {
    const read = stubDocument(t);
    const res = mockRes();

    await configController.upsertPublicFromEagle({ ...REQ, body: PUSHED }, res);

    assert.equal(res.statusCode, 200);

    const { id: _id, _rid, _ts, ...document } = read();
    assert.deepEqual(document, SERVED);
    // The push is eagle-api's whole /api/config. None of these mean anything to the public site,
    // and the document exists to be read by anonymous callers.
    assert.ok(!('KEYCLOAK_URL' in document), 'a KEYCLOAK_* key reached the public document');
    assert.ok(!('BUILD_ID' in document), 'BUILD_ID must keep coming from the deploy package');

    // The response is the stored view, not the row: no id and no Cosmos system fields.
    assert.deepEqual(res.body, SERVED);
    assert.equal(res.body.ACCESS_GATE, false);
    assert.equal(typeof res.body.ACCESS_GATE, 'boolean');
  });

  await t.test('the GET afterwards serves the pushed values', async () => {
    stubDocument(t);

    await configController.upsertPublicFromEagle({ ...REQ, body: PUSHED }, mockRes());

    const res = mockRes();
    await configController.getPublicConfig(REQ, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, SERVED);
  });

  await t.test('pushing the same payload twice stores the same document', async () => {
    const read = stubDocument(t);

    await configController.upsertPublicFromEagle({ ...REQ, body: PUSHED }, mockRes());
    const first = read();
    const second = mockRes();
    await configController.upsertPublicFromEagle({ ...REQ, body: PUSHED }, second);

    assert.deepEqual(read(), first);
    assert.deepEqual(second.body, SERVED);
  });

  await t.test('a { doc } envelope is 400 — the body is the bare config object', async () => {
    // The contract with eagle-api: what /api/config serves, sent as the body itself. There is one
    // config document and Eagle has no id for it, so this route is deliberately not the `{ doc }`
    // shape the record mirrors take, and an envelope must not be stored as a config.
    const read = stubDocument(t);
    const res = mockRes();

    await configController.upsertPublicFromEagle({ ...REQ, body: { doc: PUSHED } }, res);

    assert.equal(res.statusCode, 400);
    assert.equal(read(), null, 'an enveloped body was stored');
  });

  await t.test("a Mongo row's own fields do not ride in on a bare push", async () => {
    // eagle-api strips `_id`, `__v` and `_schemaName` before it pushes. The allowlist is what makes
    // that a belt on top of braces rather than the only thing standing between a Mongo row and a
    // document an anonymous site reads.
    const read = stubDocument(t);
    const res = mockRes();

    await configController.upsertPublicFromEagle({
      ...REQ,
      body: { ...PUSHED, _id: '5c8a1b1c1d1e1f2021222324', __v: 0, _schemaName: 'Config' }
    }, res);

    const { id: _id, _rid, _ts, ...document } = read();
    assert.deepEqual(document, SERVED);
    assert.deepEqual(res.body, SERVED);
  });

  await t.test('a later push moves the values it carries', async () => {
    // The point of the route: a hand edit in eagle-api's Mongo lands here without the seeder.
    const read = stubDocument(t);

    await configController.upsertPublicFromEagle({ ...REQ, body: PUSHED }, mockRes());
    const res = mockRes();
    await configController.upsertPublicFromEagle(
      { ...REQ, body: { ...PUSHED, ACCESS_GATE: true, SEARCH_API_PATH: '' } }, res);

    assert.equal(read().ACCESS_GATE, true);
    // Empty is the kill switch that sends the public site's search back to eagle-api, so it is a
    // value the push must be able to set rather than an absence.
    assert.equal(read().SEARCH_API_PATH, '');
    assert.equal(res.body.SEARCH_API_PATH, '');
  });

  /**
   * Bodies the route must refuse, one subtest each so a failure names the case rather than an
   * index. `ENVIRONMENT` and `ACCESS_GATE` are the two whose absence is dangerous rather than
   * merely wrong: an rproxy that fell through to the SPA answers 200 with something that parses
   * but is not eagle-api's config — the seeder refuses that case for the same reason — and a gate
   * that is missing or stringy leaves the access curtain undecided. `'false'` is truthy, which is
   * the `string(bool)` trap that already switched a feature off once.
   */
  const REJECTED = [
    ['an empty object', {}, /ENVIRONMENT/],
    ['an array', [PUSHED], /JSON object/],
    ['a string', 'ENVIRONMENT=test', /JSON object/],
    ['no ENVIRONMENT', { ...PUSHED, ENVIRONMENT: undefined }, /ENVIRONMENT/],
    ['a blank ENVIRONMENT', { ...PUSHED, ENVIRONMENT: '   ' }, /ENVIRONMENT/],
    ['a non-string ENVIRONMENT', { ...PUSHED, ENVIRONMENT: 3 }, /ENVIRONMENT/],
    ['a stringy ACCESS_GATE', { ...PUSHED, ACCESS_GATE: 'true' }, /ACCESS_GATE/],
    ['no ACCESS_GATE', { ...PUSHED, ACCESS_GATE: undefined }, /ACCESS_GATE/]
  ];

  for (const [name, body, message] of REJECTED) {
    await t.test(`${name} is 400 and writes nothing`, async () => {
      const read = stubDocument(t);
      const res = mockRes();

      await configController.upsertPublicFromEagle({ ...REQ, body }, res);

      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, message);
      assert.equal(read(), null, 'a rejected body was stored anyway');
    });
  }

  await t.test('a Cosmos failure is a 500 that tells the caller nothing', async () => {
    t.mock.method(configRepository, 'getPublic', async () => null);
    t.mock.method(configRepository, 'upsertPublic', async () => {
      throw new Error('private endpoint down: demi-cosmos-test/demi/config');
    });
    const res = mockRes();

    await configController.upsertPublicFromEagle({ ...REQ, body: PUSHED }, res);

    assert.equal(res.statusCode, 500);
    assert.ok(!/demi-cosmos/.test(JSON.stringify(res.body)), 'the driver message reached the caller');
  });
});

/**
 * The route chain, run end to end. The handler reads and writes no ACL predicate — it stores what
 * it is given — so the chain is the whole thing standing between an anonymous caller and the
 * payload eagle-public boots on.
 */
test('the config push route is behind authMiddleware + requireWrite', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('it is declared with the mirror chain', () => {
    const [route, ...extra] = routeChains()
      .filter(r => r.method === 'put' && r.path === '/eagle/config/public');
    assert.ok(route, 'PUT /eagle/config/public is not in the route table');
    assert.deepStrictEqual(extra, []);
    assert.match(route.chain, /\bauthMiddleware\b/);
    assert.match(route.chain, /\brequireWrite\b/);
  });

  await t.test('no credential is 401, and nothing is written', async () => {
    const read = stubDocument(t);

    await withServer(async (call) => {
      const res = await call('/api/eagle/config/public', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(PUSHED)
      });
      assert.strictEqual(res.status, 401);
    });

    assert.equal(read(), null);
  });

  await t.test('a read-only credential is 403, and nothing is written', async () => {
    const read = stubDocument(t);
    const key = stubKey(t, ['demi-service-read']);

    await withServer(async (call) => {
      const res = await call('/api/eagle/config/public', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-api-key': key.plaintext },
        body: JSON.stringify(PUSHED)
      });
      assert.strictEqual(res.status, 403, await res.text());
    });

    assert.equal(read(), null);
    key.forget();
  });

  await t.test('a demi-service-write key stores it, and the GET serves it back', async () => {
    const read = stubDocument(t);
    const key = stubKey(t, ['demi-service-write']);

    await withServer(async (call) => {
      const push = await call('/api/eagle/config/public', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-api-key': key.plaintext },
        body: JSON.stringify(PUSHED)
      });
      // Read once: `Response` bodies are single-use, so the failure message and the assertion
      // cannot both consume it.
      const pushed = await push.text();
      assert.strictEqual(push.status, 200, pushed);
      assert.deepEqual(JSON.parse(pushed), SERVED);

      // The whole point of the route, asserted across both handlers: what eagle-api pushed is what
      // an anonymous caller boots on, with no seeding run in between.
      const served = await call('/api/config/public');
      assert.strictEqual(served.status, 200);
      assert.deepEqual(await served.json(), SERVED);
    });

    assert.equal(read().SEARCH_API_PATH, '/demi-search');
    key.forget();
  });
});

/** A registry key the push can authenticate with, stubbed at the repository. */
function stubKey(t, roles) {
  const { keyId, plaintext, hash } = generateKey('test');
  forgetCachedKey(keyId);
  t.mock.method(apiKeys, 'getById', async () => ({
    id: keyId, name: 'eagle-push', hash, roles,
    projectScope: null, expiresAt: null, revokedAt: null
  }));
  t.mock.method(apiKeys, 'touchLastUsed', async () => {});
  return { plaintext, forget: () => forgetCachedKey(keyId) };
}
