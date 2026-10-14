'use strict';

/**
 * The request/response shim, on the paths no controller test can see.
 *
 * Everything here used to be Express's job — query parsing, multipart, the guard chain, redirects —
 * so it had no test in this repo at all. Each case below is a shape that silently degrades: a
 * multi-select filter that applies one option under a 200, an upload that arrives with no file, a
 * printed short link that stops redirecting.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { SUITE_KEY } = require('../helpers/suite-key');
const { HttpRequest, HttpResponse } = require('@azure/functions');

const { dispatch } = require('../../src/http/router');
const configController = require('../../src/controllers/config');
const documentController = require('../../src/controllers/nosql/document');
const links = require('../../src/repositories/links');
const healthController = require('../../src/controllers/health');
const searchSchemaController = require('../../src/controllers/search-schema');
const config = require('../../src/config');
const { logger } = require('../../src/utils/logger');

const AUTHED = { 'x-api-key': SUITE_KEY };

function call(path, init = {}) {
  return dispatch(new HttpRequest({
    method: init.method || 'GET',
    url: `http://127.0.0.1${path}`,
    headers: init.headers || {},
    body: init.body
  }), { error: () => {} });
}

test('repeated query keys stay arrays', async (t) => {
  // `Object.fromEntries(searchParams)` keeps only the LAST value, and eagle-public emits one
  // `and[key]=value` per selected facet option — so every multi-select filter quietly applied one
  // option, under a 200, indistinguishable from a filter that matched few rows.
  let seen;
  t.mock.method(configController, 'getConfig', (req, res) => { seen = req.query; res.json({}); });

  await call('/api/config?and[region]=Peace&and[region]=Cariboo&sortBy=-name&sortBy=');

  assert.deepStrictEqual(seen['and[region]'], ['Peace', 'Cariboo']);
  assert.deepStrictEqual(seen.sortBy, ['-name', '']);
});

test('route params are named and percent-decoded', async (t) => {
  let seen;
  t.mock.method(links, 'getById', async (id) => { seen = id; return null; });

  const res = await call('/s/ab%2Dc');
  assert.strictEqual(seen, 'ab-c', 'the handler reads a decoded :code, not the raw segment');
  assert.strictEqual(res.status, 404, 'an unknown code renders the not-found page');
  assert.match(res.headers['content-type'], /text\/html/);
});

test('a malformed percent-escape in a route param is a 400, not a 500', async () => {
  const res = await call('/s/%ZZ');
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(JSON.parse(res.body), { error: 'Bad Request' });
});

test('a short link redirects with no-store, never a cached 301', async (t) => {
  // A cached permanent redirect on a printed poster can never be corrected.
  t.mock.method(links, 'getById', async () => ({ id: 'abc', url: 'https://example.gov.bc.ca/x' }));

  const res = await call('/s/abc');
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, 'https://example.gov.bc.ca/x');
  assert.strictEqual(res.headers['cache-control'], 'no-store');
});

test('an uncredentialed call to a guarded route is 401 and never reaches the handler', async (t) => {
  let reached = false;
  t.mock.method(documentController, 'createDocument', (req, res) => { reached = true; res.json({}); });

  const res = await call('/api/documents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { string: '{}' }
  });

  assert.strictEqual(res.status, 401);
  assert.strictEqual(reached, false, 'the guard chain must stop before the handler');
});

test('a multipart upload arrives as req.file', async (t) => {
  // The one multipart route. multer is gone; the dispatcher writes the part to os.tmpdir() and
  // synthesises the same four fields the handler reads, including the path it unlinks.
  let seen;
  t.mock.method(documentController, 'extractDocument', (req, res) => {
    seen = { file: req.file, body: req.body };
    res.status(202).json({});
  });

  const form = new FormData();
  form.set('project', '207');
  form.set('upfile', new File([Buffer.from('%PDF-1.4 fake')], 'plan.pdf', { type: 'application/pdf' }));
  const encoded = new Response(form);

  const res = await call('/api/documents/extract', {
    method: 'POST',
    headers: { ...AUTHED, 'content-type': encoded.headers.get('content-type') },
    body: { bytes: new Uint8Array(await encoded.arrayBuffer()) }
  });

  assert.strictEqual(res.status, 202);
  assert.strictEqual(seen.body.project, '207');
  assert.strictEqual(seen.file.originalname, 'plan.pdf');
  assert.strictEqual(seen.file.mimetype, 'application/pdf');
  assert.strictEqual(seen.file.size, 13);
  assert.ok(require('node:fs').existsSync(seen.file.path), 'the handler is handed a real path');
  require('node:fs').unlinkSync(seen.file.path);
});

test('a body over the 10 MB limit is refused before it is parsed', async (t) => {
  let reached = false;
  t.mock.method(documentController, 'createDocument', (req, res) => { reached = true; res.json({}); });

  const res = await call('/api/documents', {
    method: 'POST',
    headers: { ...AUTHED, 'content-type': 'application/json', 'content-length': String(11 * 1024 * 1024) },
    body: { string: '{}' }
  });

  assert.strictEqual(res.status, 413);
  assert.strictEqual(reached, false);
});

test('a search-service failure thrown to the router answers a fixed message', async (t) => {
  t.mock.method(logger, 'error', () => {});
  t.mock.method(configController, 'getConfig', () => {
    throw Object.assign(new Error("HTTP 400 Invalid expression: search.in(acl, 'public', ',')"),
      { status: 400, searchService: true });
  });

  const res = await call('/api/config');

  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(JSON.parse(res.body), { error: 'The search service could not run this query.' });
});

test('a malformed JSON body is a 400, not a 500', async () => {
  const res = await call('/api/documents', {
    method: 'POST',
    headers: { ...AUTHED, 'content-type': 'application/json' },
    body: { string: '{not json' }
  });
  assert.strictEqual(res.status, 400);
});

test('a null-body status is dispatched with no body and no content-length', async () => {
  // The Functions worker (api/index.js) hands this straight to `new Response(body, ...)`, and
  // undici throws `Invalid response status code 204` on any body — including the '' the shim's
  // send('') leaves behind — which the host then serves as an empty 500.
  const res = await call('/api/anything', {
    method: 'OPTIONS',
    headers: { origin: 'http://127.0.0.1', 'access-control-request-method': 'POST' }
  });

  assert.strictEqual(res.status, 204);
  assert.strictEqual(res.body, undefined, 'a 204 carries no body at all, not even an empty string');
  assert.strictEqual(res.headers['content-length'], undefined, 'a null-body status has no length');
  assert.doesNotThrow(() => new Response(res.body, { status: res.status, headers: res.headers }));
});

test('a 200 with an empty body still carries content-length: 0', async (t) => {
  t.mock.method(configController, 'getConfig', (req, res) => res.send(''));

  const res = await call('/api/config');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body, '', 'only null-body statuses lose their body');
  assert.strictEqual(res.headers['content-length'], '0');
});

test('a streamed body arrives whole under the length the handler preset', async (t) => {
  t.mock.method(configController, 'getConfig', (req, res) => {
    res.set('Content-Length', 11);
    res.stream(Readable.from([Buffer.from('hello '), Buffer.from('world')]));
  });

  const res = await call('/api/config');
  // HttpResponse is what the host builds from dispatch's return value.
  const sent = new HttpResponse(res);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['content-length'], '11', 'the preset length, not the length of an empty buffer');
  assert.strictEqual(await sent.text(), 'hello world');
});

test('a public answer never echoes the caller\'s request id', async (t) => {
  t.mock.method(configController, 'getConfig', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json({});
  });
  const res = await call('/api/config', { headers: { 'x-request-id': 'caller-chosen' } });
  assert.match(res.headers['x-request-id'], /^[0-9a-f]{8}$/);
});

test('the served request id is logged beside the caller\'s', async (t) => {
  t.mock.method(configController, 'getConfig', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json({});
  });
  const info = t.mock.method(logger, 'info', () => {});
  const res = await call('/api/config', { headers: { 'x-request-id': 'caller-chosen' } });
  const line = info.mock.calls.map(c => c.arguments[1])
    .find(meta => meta && meta.evt === 'request-id-replaced');
  assert.strictEqual(line.servedId, res.headers['x-request-id']);
  assert.strictEqual(line.callerId, 'caller-chosen');
});

test('a private answer keeps the caller\'s request id', async (t) => {
  t.mock.method(configController, 'getConfig', (req, res) => {
    res.set('Cache-Control', 'no-store').json({});
  });
  const res = await call('/api/config', { headers: { 'x-request-id': 'caller-chosen' } });
  assert.strictEqual(res.headers['x-request-id'], 'caller-chosen');
});

test('a 304 the handler answers carries no body and no content-length', async (t) => {
  // A conditional GET states the file's size before it learns the copy is fresh; the 304 must drop
  // that length, or undici refuses the Response and the host serves an empty 500.
  t.mock.method(configController, 'getConfig', (req, res) => {
    res.set('Content-Length', 11).set('ETag', '"abc"');
    res.status(304).send('');
  });

  const res = await call('/api/config');

  assert.strictEqual(res.status, 304);
  assert.strictEqual(res.body, undefined);
  assert.strictEqual(res.headers['content-length'], undefined);
  assert.strictEqual(res.headers.etag, '"abc"');
  assert.doesNotThrow(() => new Response(res.body, { status: res.status, headers: res.headers }));
});

// Bounded: the failure mode is a body that never ends.
test('a stream answered as 304 sends nothing and releases its source', { timeout: 5000 }, async (t) => {
  // Never ends by itself, like a store read nobody consumes.
  const source = new Readable({ read() {} });
  t.mock.method(configController, 'getConfig', (req, res) => {
    res.set('Content-Length', 5);
    res.stream(source, { status: 304 });
  });

  const res = await call('/api/config');

  assert.strictEqual(res.status, 304);
  assert.strictEqual(res.body, undefined);
  assert.strictEqual(res.headers['content-length'], undefined);
  await once(source, 'close');
  assert.strictEqual(source.destroyed, true, 'an unread store stream would hold its connection open');
});

// Bounded: the failure mode is a body that never ends.
test('a stream that fails after the headers is logged and ends short', { timeout: 5000 }, async (t) => {
  const error = t.mock.method(logger, 'error', () => {});
  let sentFirst = false;
  const source = new Readable({
    read() {
      if (sentFirst) return this.destroy(new Error('store connection reset'));
      sentFirst = true;
      this.push('partial');
    }
  });
  t.mock.method(configController, 'getConfig', (req, res) => {
    res.set('Content-Length', 100);
    res.stream(source);
  });

  const res = await call('/api/config');
  const text = await new HttpResponse(res).text();

  assert.strictEqual(res.headers['content-length'], '100');
  assert.strictEqual(text, 'partial', 'the bytes read before the failure, then a clean end');
  const logged = error.mock.calls.map((c) => c.arguments[1]).find((meta) => meta && meta.evt === 'stream-error');
  assert.strictEqual(logged && logged.error, 'store connection reset');
});

// Native reads: comment periods and comments.
test('native comment period and comment reads', async (t) => {
  const cosmos = require('../../src/db/cosmos-nosql');
  const projects = require('../../src/repositories/projects');
  const PATHS = [
    '/api/comment-periods', '/api/comment-periods/cp1', '/api/comment-periods/cp1/summary',
    '/api/comments', '/api/comments/c1'
  ];
  // `author` on an unattributed comment is level 2: an anonymous read must not carry it.
  const ROWS = {
    commentPeriods: { id: 'cp1', projectId: 'p1', read: ['public'] },
    comments: { id: 'c1', periodId: 'cp1', projectId: 'p1', read: ['public'], comment: 'Fish', author: 'Pat Hidden', isAnonymous: true }
  };
  t.beforeEach((t) => {
    t.mock.method(cosmos, 'query', async (container, spec) =>
      ({ items: spec.query.includes('COUNT(1)') ? [1] : [ROWS[container]] }));
    t.mock.method(cosmos, 'queryFirst', async container => ROWS[container]);
    t.mock.method(projects, 'listRowsByIds', async () => []);
  });

  for (const path of PATHS) {
    await t.test(`${path} answers anonymous without a level-2 field`, async () => {
      const res = await call(path);
      assert.strictEqual(res.status, 200, res.body);
      assert.ok(!res.body.includes('Pat Hidden'), res.body);
    });

    await t.test(`${path} answers a rejected Bearer with 401`, async () => {
      const res = await call(path, { headers: { authorization: 'Bearer not-a-token' } });
      assert.strictEqual(res.status, 401);
    });
  }
});

// Native reads: updates and project notifications.
test('native update and notification reads', async (t) => {
  const cosmos = require('../../src/db/cosmos-nosql');
  const updates = require('../../src/repositories/updates');
  const PATHS = [
    '/api/updates', '/api/updates/feed', '/api/updates/u1',
    '/api/notifications', '/api/notifications/n1'
  ];
  // `notifiedBy` and `eaglePushedAt` are level 2: an anonymous read must not carry them.
  const ROWS = {
    updates: { id: 'u1', read: ['public'], headline: 'Hello', notifiedBy: 'Hidden Sender' },
    notifications: { id: 'n1', read: ['public'], name: 'Mine', eaglePushedAt: 'Hidden Sender' }
  };
  t.beforeEach((t) => {
    updates.forgetParents();
    t.mock.method(cosmos, 'query', async (container, spec) => {
      if (spec.query.includes('COUNT(1)')) return { items: [1] };
      return { items: ROWS[container] ? [ROWS[container]] : [] };
    });
    t.mock.method(cosmos, 'readItem', async container => ROWS[container] || null);
  });

  for (const path of PATHS) {
    await t.test(`${path} answers anonymous without a level-2 field`, async () => {
      const res = await call(path);
      assert.strictEqual(res.status, 200, res.body);
      assert.ok(res.body.includes(path.includes('notifications') ? 'Mine' : 'Hello'), res.body);
      assert.ok(!res.body.includes('Hidden Sender'), res.body);
    });

    await t.test(`${path} answers a rejected Bearer with 401`, async () => {
      const res = await call(path, { headers: { authorization: 'Bearer not-a-token' } });
      assert.strictEqual(res.status, 401);
    });
  }
});

test('edge gate', async (t) => {
  // Fake values: the gate compares what the request presents against these.
  const GATEWAY = { 'x-gateway-secret': 'gateway-secret-for-edge-gate-suite' };
  const EDGE = { 'x-edge-secret': 'edge-secret-for-edge-gate-suite' };
  const saved = { edgeGate: config.edgeGate, edgeSecret: config.edgeSecret };

  t.beforeEach((t) => {
    process.env.APIM_GATEWAY_SECRET = GATEWAY['x-gateway-secret'];
    config.edgeSecret = EDGE['x-edge-secret'];
    config.edgeGate = 'enforce';
    t.mock.method(configController, 'getConfig', (req, res) => res.json({ ok: true }));
  });
  t.afterEach(() => {
    delete process.env.APIM_GATEWAY_SECRET;
    Object.assign(config, saved);
  });

  const gateWarnings = (warn) =>
    warn.mock.calls.filter(c => String(c.arguments[0]).includes('edge gate'));

  await t.test('enforce refuses a direct call to the Function host', async () => {
    const res = await call('/api/config');
    assert.strictEqual(res.status, 403);
    assert.match(JSON.parse(res.body).error, /^Forbidden/);
  });

  await t.test('enforce refuses APIM without the edge secret', async () => {
    const res = await call('/api/config', { headers: { ...GATEWAY } });
    assert.strictEqual(res.status, 403);
  });

  await t.test('a wrong edge secret counts as no edge', async () => {
    const res = await call('/api/config', { headers: { ...GATEWAY, 'x-edge-secret': 'guess' } });
    assert.strictEqual(res.status, 403);
  });

  await t.test('the edge secret without APIM is refused', async () => {
    const res = await call('/api/config', { headers: { ...EDGE } });
    assert.strictEqual(res.status, 403);
  });

  await t.test('APIM plus the edge secret is served', async () => {
    const res = await call('/api/config', { headers: { ...GATEWAY, ...EDGE } });
    assert.strictEqual(res.status, 200);
  });

  await t.test('APIM plus a subscription name is served', async () => {
    const res = await call('/api/config', { headers: { ...GATEWAY, 'x-apim-subscription': 'eagle-api' } });
    assert.strictEqual(res.status, 200);
  });

  await t.test('APIM plus a valid X-Api-Key is served and reaches auth', async (t) => {
    t.mock.method(documentController, 'createDocument', (req, res) => res.json({}));
    t.mock.method(documentController, 'getDocuments', (req, res) => res.json({ user: req.user.preferred_username }));
    const headers = { ...GATEWAY, 'x-api-key': SUITE_KEY };

    assert.strictEqual((await call('/api/config', { headers })).status, 200);
    const read = await call('/api/documents', { headers });
    assert.strictEqual(read.status, 200);
    assert.strictEqual(JSON.parse(read.body).user, 'internal-service');
    const write = await call('/api/documents', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: { string: '{}' }
    });
    assert.strictEqual(write.status, 200);
  });

  // passiveAuth serves a rejected key as anonymous and /config has no guard, so only the gate
  // stops a junk key sent straight to APIM.
  await t.test('APIM plus a bogus or empty X-Api-Key is refused, even on public routes', async (t) => {
    let reached = 0;
    t.mock.method(documentController, 'getDocuments', (req, res) => { reached++; res.json({}); });

    for (const key of ['not-a-key', '']) {
      const headers = { ...GATEWAY, 'x-api-key': key };
      assert.strictEqual((await call('/api/config', { headers })).status, 403, `config, key '${key}'`);
      assert.strictEqual((await call('/api/documents', { headers })).status, 403, `documents, key '${key}'`);
    }
    assert.strictEqual(reached, 0);
  });

  await t.test('log serves a bogus key and writes one bad-key line', async (t) => {
    config.edgeGate = 'log';
    const warn = t.mock.method(logger, 'warn');

    const res = await call('/api/config', { headers: { ...GATEWAY, 'x-api-key': 'not-a-key' } });

    assert.strictEqual(res.status, 200);
    const lines = gateWarnings(warn);
    assert.strictEqual(lines.length, 1);
    assert.deepStrictEqual(lines[0].arguments[1], { evt: 'edge-gate', path: '/api/config', reason: 'bad-key' });
  });

  await t.test('/health/db is served with no headers at all', async (t) => {
    t.mock.method(healthController, 'db', (req, res) => res.json({ ok: true }));
    const res = await call('/health/db');
    assert.strictEqual(res.status, 200);
  });

  await t.test('the /api/health aliases are served with no headers at all', async (t) => {
    t.mock.method(searchSchemaController, 'searchSchema', (req, res) => res.json({ ok: true }));
    assert.strictEqual((await call('/api/health')).status, 200);
    assert.strictEqual((await call('/api/health/search-schema')).status, 200);
  });

  await t.test('log serves the request and writes exactly one gate line', async (t) => {
    config.edgeGate = 'log';
    const warn = t.mock.method(logger, 'warn');

    const res = await call('/api/config', { headers: { ...GATEWAY } });

    assert.strictEqual(res.status, 200);
    const lines = gateWarnings(warn);
    assert.strictEqual(lines.length, 1);
    assert.deepStrictEqual(lines[0].arguments[1], { evt: 'edge-gate', path: '/api/config', reason: 'no-edge' });
  });

  await t.test('log names a missing gateway hop and never logs header values', async (t) => {
    config.edgeGate = 'log';
    const warn = t.mock.method(logger, 'warn');

    await call('/api/config', { headers: { ...EDGE } });

    const lines = gateWarnings(warn);
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].arguments[1].reason, 'no-gateway');
    assert.ok(!JSON.stringify(lines[0].arguments).includes(EDGE['x-edge-secret']));
  });

  await t.test('log stays quiet for a request that came through the edge', async (t) => {
    config.edgeGate = 'log';
    const warn = t.mock.method(logger, 'warn');
    await call('/api/config', { headers: { ...GATEWAY, ...EDGE } });
    assert.strictEqual(gateWarnings(warn).length, 0);
  });

  await t.test('off serves everything and logs nothing', async (t) => {
    config.edgeGate = '';
    const warn = t.mock.method(logger, 'warn');
    const res = await call('/api/config');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(gateWarnings(warn).length, 0);
  });
});

// Native reads: users and groups.
test('native users and groups reads', async (t) => {
  const cosmos = require('../../src/db/cosmos-nosql');
  // Public rows that still hold a level-2 field: the dispatched answer must not.
  const ROWS = {
    users: { id: 'u1', read: ['public'], displayName: 'Sam Public', email: 'sam@example.invalid' },
    groups: { id: 'g1', projectId: 'p1', read: ['public'], name: 'Working group', members: ['u1'] }
  };
  const HIDDEN = { users: 'email', groups: 'members' };

  t.beforeEach((t) => {
    t.mock.method(cosmos, 'query', async (container) => ({ items: ROWS[container] ? [ROWS[container]] : [] }));
    t.mock.method(cosmos, 'readItem', async (container) => ROWS[container] || null);
    t.mock.method(cosmos, 'queryFirst', async (container) => ROWS[container] || null);
  });
  t.afterEach(() => t.mock.restoreAll());

  for (const kind of ['users', 'groups']) {
    for (const path of [`/api/${kind}`, `/api/${kind}/${ROWS[kind].id}`]) {
      await t.test(`${path} answers an anonymous caller without ${HIDDEN[kind]}`, async () => {
        const res = await call(path);
        assert.strictEqual(res.status, 200, res.body);
        const row = [].concat(JSON.parse(res.body))[0];
        assert.strictEqual(row.id, ROWS[kind].id);
        assert.ok(!(HIDDEN[kind] in row), `${HIDDEN[kind]} reached an anonymous caller`);
      });

      await t.test(`${path} answers a rejected Bearer with 401, not the public tier`, async () => {
        const res = await call(path, { headers: { authorization: 'Bearer not-a-token' } });
        assert.strictEqual(res.status, 401);
      });
    }
  }
});

// Native kind reads: lists and organizations.
test('native lists and organizations routes', async (t) => {
  const cosmos = require('../../src/db/cosmos-nosql');
  // One row per kind; `description` is level 2 in catalog/lists.js and is set on both, so a route
  // that skipped the redactor would show it on either kind.
  const rows = [
    { id: 'l1', kind: 'List', name: 'Pre-Application', type: 'eaoStatus', description: 'level 2', read: ['public'] },
    { id: 'o1', kind: 'Organization', name: 'Acme Mining', description: 'level 2', read: ['public'] }
  ];
  t.mock.method(cosmos, 'query', async (container, spec, options = {}) =>
    ({ items: rows.filter(row => row.kind === options.partitionKey) }));
  t.mock.method(cosmos, 'readItem', async (container, id, kind) =>
    rows.find(row => row.id === id && row.kind === kind) || null);
  t.after(() => t.mock.restoreAll());

  const paths = { '/api/lists': 'l1', '/api/lists/l1': 'l1', '/api/organizations': 'o1', '/api/organizations/o1': 'o1' };

  for (const [path, id] of Object.entries(paths)) {
    await t.test(`anonymous GET ${path} leaves out the level-2 field`, async () => {
      const res = await call(path);
      assert.strictEqual(res.status, 200);
      const [row] = [].concat(JSON.parse(res.body));
      assert.strictEqual(row.id, id);
      assert.strictEqual(row.description, undefined);
    });

    await t.test(`GET ${path} with a rejected Bearer is a 401`, async () => {
      const res = await call(path, { headers: { authorization: 'Bearer not-a-jwt' } });
      assert.strictEqual(res.status, 401);
    });

    await t.test(`authenticated GET ${path} is private, no-store`, async () => {
      const res = await call(path, { headers: { ...AUTHED } });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers['cache-control'], 'private, no-store');
    });
  }
});

// --- projects/counts: native list routes ---
test('native projects and counts routes', async (t) => {
  const projectsCosmos = require('../../src/db/cosmos-nosql');
  t.afterEach(() => t.mock.restoreAll());
  // `addedBy` is level 2 on every project.
  const stubProjects = () => t.mock.method(projectsCosmos, 'query', async (container, spec) =>
    (spec.query.includes('COUNT(1)')
      ? { items: [1] }
      : { items: [{ id: 'p1', name: 'Mine', read: ['public'], addedBy: 'staff-only@example.org' }] }));

  await t.test('an anonymous project list withholds a level-2 field', async () => {
    stubProjects();
    const res = await call('/api/projects');
    assert.strictEqual(res.status, 200);
    const [row] = JSON.parse(res.body);
    assert.strictEqual(row.name, 'Mine');
    assert.ok(!('addedBy' in row), 'addedBy reached an anonymous caller');
  });

  for (const path of ['/api/projects', '/api/counts?kind=projects']) {
    await t.test(`a rejected Bearer on ${path} is 401, not the public view`, async () => {
      stubProjects();
      const res = await call(path, { headers: { authorization: 'Bearer not-a-jwt' } });
      assert.strictEqual(res.status, 401);
    });

    await t.test(`an authenticated ${path} answer is private, no-store`, async () => {
      stubProjects();
      const res = await call(path, { headers: AUTHED });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers['cache-control'], 'private, no-store');
    });
  }
});

// --- documents, scan and passages: native list routes beside the token walk ---
test('native documents, scan and passages routes', async (t) => {
  const cosmos = require('../../src/db/cosmos-nosql');
  const aiSearch = require('../../src/search/ai-search');
  const projects = require('../../src/repositories/projects');
  const passages = require('../../src/controllers/native/passages');
  t.afterEach(() => t.mock.restoreAll());

  // `sealedAt` is level 2 on every document.
  const DOCS = [{ id: 'd1', projectId: 'p1', read: ['public'], displayName: 'Part A', sealedAt: '2026-09-01T00:00:00.000Z' }];
  const stubStores = () => {
    t.mock.method(aiSearch, 'searchDocumentIds', async () => ({ ids: ['d1'], count: 1 }));
    t.mock.method(aiSearch, 'searchChunks', async () => ({ items: [], count: 0 }));
    t.mock.method(cosmos, 'query', async (container, spec) =>
      ({ items: spec.query.includes('COUNT(1)') ? [DOCS.length] : structuredClone(DOCS) }));
    t.mock.method(projects, 'listRowsByIds', async () => []);
  };

  await t.test('anonymous /api/documents withholds sealedAt', async () => {
    stubStores();
    const res = await call('/api/documents');
    assert.strictEqual(res.status, 200, res.body);
    const [row] = JSON.parse(res.body);
    assert.strictEqual(row.id, 'd1');
    assert.ok(!('sealedAt' in row), 'sealedAt reached an anonymous caller');
  });

  // probe-acl reads one project's documents by id batch.
  await t.test('/api/documents?project=<id>&ids=<id> is 200', async () => {
    stubStores();
    const res = await call('/api/documents?project=p1&ids=d1');
    assert.strictEqual(res.status, 200, res.body);
    assert.deepStrictEqual(JSON.parse(res.body).map(row => row.id), ['d1']);
  });

  for (const path of ['/api/documents', '/api/documents/passages?q=water']) {
    await t.test(`rejected Bearer on ${path} is 401`, async () => {
      stubStores();
      const res = await call(path, { headers: { authorization: 'Bearer not-a-jwt' } });
      assert.strictEqual(res.status, 401);
    });

    await t.test(`authenticated ${path} answer is no-store`, async () => {
      stubStores();
      const res = await call(path, { headers: AUTHED });
      assert.strictEqual(res.status, 200, res.body);
      assert.strictEqual(res.headers['cache-control'], 'private, no-store');
    });
  }

  await t.test('anonymous /api/documents/scan is 401', async () => {
    const scan = t.mock.method(documentController, 'scanDocuments', (req, res) => res.json([]));
    const res = await call('/api/documents/scan');
    assert.strictEqual(res.status, 401);
    assert.strictEqual(scan.mock.callCount(), 0);
  });

  await t.test('/api/documents/scan and /api/documents/passages do not hit /documents/:id', async () => {
    const byId = t.mock.method(documentController, 'getDocument', (req, res) => res.json({ route: 'byId' }));
    t.mock.method(documentController, 'scanDocuments', (req, res) => res.json({ route: 'scan' }));
    t.mock.method(passages, 'getPassages', (req, res) => res.json({ route: 'passages' }));

    for (const name of ['scan', 'passages']) {
      const res = await call(`/api/documents/${name}?q=water`, { headers: AUTHED });
      assert.strictEqual(res.status, 200, res.body);
      assert.deepStrictEqual(JSON.parse(res.body), { route: name });
    }
    assert.strictEqual(byId.mock.callCount(), 0);
  });

  await t.test('passages without q 400', async () => {
    stubStores();
    const res = await call('/api/documents/passages');
    assert.strictEqual(res.status, 400);
    assert.match(JSON.parse(res.body).error, /q is required/);
    assert.strictEqual(aiSearch.searchChunks.mock.callCount(), 0);
  });
});
