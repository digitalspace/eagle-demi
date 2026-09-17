'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../src/config');
const jobs = require('../../src/repositories/bulk-downloads');
const searchDefinitions = require('../../src/jobs/search-definitions');
const controller = require('../../src/controllers/search-definitions');
const { makeRes } = require('../../src/http/router');
const { withServer } = require('../helpers/with-server');
const { routeChains } = require('../helpers/router-source');

// The queue name is what switches the feature on; Azure drops an empty app setting, so an
// environment without one must refuse rather than accept work nothing will pick up.
config.searchDefinitionsQueue = 'search-definitions';

const SYSADMIN = { sub: 'kc-sub-1', preferred_username: 'ops.person', realm_access: { roles: ['sysadmin'] } };

function res() {
  return makeRes('test-request');
}

function body(response) {
  return JSON.parse(response.body);
}

function post(payload) {
  return { headers: {}, query: {}, params: {}, body: payload, user: SYSADMIN };
}

/** Accept the row and the message, so a test can assert on what was recorded. */
function accept(t) {
  const sent = [];
  let created = null;
  t.mock.method(jobs, 'create', async (job) => { created = job; return job; });
  t.mock.method(searchDefinitions, 'enqueue', async (id) => { sent.push(id); });
  return { sent, job: () => created };
}

test('POST /admin/search-definitions/apply', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('accepts a run and answers 202 with the job id and where to poll it', async () => {
    accept(t);
    const response = res();

    await controller.applySearchDefinitions(post({ only: ['projects'], live: true }), response);

    assert.strictEqual(response.statusCode, 202);
    const answer = body(response);
    assert.strictEqual(answer.status, 'queued');
    assert.strictEqual(answer.statusUrl, `/api/admin/search-definitions/jobs/${answer.jobId}`);
    assert.deepStrictEqual(answer.request, { only: ['projects'], datasources: [], live: true, check: false });
  });

  await t.test('the row is written before the message, and the row id is not the one handed out', async () => {
    const taken = accept(t);
    const response = res();

    await controller.applySearchDefinitions(post({ only: ['projects'] }), response);

    const stored = taken.job();
    // The prefix is what keeps this row off GET /bulk-downloads/:id, whose id check is a bare UUID.
    assert.strictEqual(stored.id, `${searchDefinitions.JOB_PREFIX}${body(response).jobId}`);
    assert.deepStrictEqual(taken.sent, [stored.id], 'the queue gets the stored id, not the public one');
  });

  await t.test('an index name the package does not carry is a 400, not a job', async () => {
    const taken = accept(t);
    const response = res();

    await controller.applySearchDefinitions(post({ only: ['chunkz'] }), response);

    assert.strictEqual(response.statusCode, 400);
    assert.match(body(response).error, /chunkz/);
    assert.deepStrictEqual(taken.sent, [], 'nothing was queued');
  });

  await t.test('an indexer name is accepted, because --only has always taken either', async () => {
    accept(t);
    const response = res();

    await controller.applySearchDefinitions(post({ only: ['chunks-indexer'] }), response);

    assert.strictEqual(response.statusCode, 202);
  });

  await t.test('a data source name the package does not carry is a 400', async () => {
    accept(t);
    const response = res();

    await controller.applySearchDefinitions(post({ datasources: ['demi-nope-ds'], live: true }), response);

    assert.strictEqual(response.statusCode, 400);
    assert.match(body(response).error, /demi-nope-ds/);
  });

  await t.test('only must be a list, not a bare name', async () => {
    accept(t);
    const response = res();

    await controller.applySearchDefinitions(post({ only: 'projects' }), response);

    assert.strictEqual(response.statusCode, 400);
    assert.match(body(response).error, /only must be an array/);
  });

  await t.test('live must be a boolean — "true" is not one', async () => {
    accept(t);
    const response = res();

    await controller.applySearchDefinitions(post({ live: 'true' }), response);

    assert.strictEqual(response.statusCode, 400);
    assert.match(body(response).error, /live must be true or false/);
  });

  await t.test('live and check together are refused, as the CLI refuses them', async () => {
    accept(t);
    const response = res();

    await controller.applySearchDefinitions(post({ live: true, check: true }), response);

    assert.strictEqual(response.statusCode, 400);
    assert.match(body(response).error, /mutually exclusive/);
  });

  await t.test('an unknown body key is a typo the caller hears about', async () => {
    accept(t);
    const response = res();

    await controller.applySearchDefinitions(post({ datasource: ['demi-projects-ds'] }), response);

    assert.strictEqual(response.statusCode, 400);
    assert.match(body(response).error, /datasource/);
  });

  await t.test('no queue name means the feature is off, not a queued job', async (tt) => {
    accept(t);
    config.searchDefinitionsQueue = '';
    tt.after(() => { config.searchDefinitionsQueue = 'search-definitions'; });
    const response = res();

    await controller.applySearchDefinitions(post({ only: ['projects'] }), response);

    assert.strictEqual(response.statusCode, 503);
  });

  await t.test('a row whose message could not be sent is failed, not left queued', async () => {
    let patched = null;
    t.mock.method(jobs, 'create', async (job) => job);
    t.mock.method(jobs, 'patch', async (id, fields) => { patched = { id, fields }; });
    t.mock.method(searchDefinitions, 'enqueue', async () => { throw new Error('queue is gone'); });
    const response = res();

    await controller.applySearchDefinitions(post({ only: ['projects'] }), response);

    assert.strictEqual(response.statusCode, 503);
    assert.strictEqual(patched.fields.status, 'failed');
  });
});

test('GET /admin/search-definitions/jobs/:id', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const ID = '6f1c4b9e-0d2a-4d9d-9c3e-1f5f9a2b7c40';

  await t.test('reads the row the prefix belongs to, and reports its steps', async () => {
    let asked = null;
    t.mock.method(jobs, 'getById', async (id) => {
      asked = id;
      return {
        id, status: 'warned', request: { only: ['chunks'], datasources: [], live: true, check: false },
        steps: ['DEMI_RESET chunks-indexer 204'],
        results: [{ indexer: 'chunks-indexer', status: 'stillRunning' }],
        resetIssuedAt: '2026-09-17T10:00:00.000Z'
      };
    });
    const response = res();

    await controller.getSearchDefinitionJob({ params: { id: ID } }, response);

    assert.strictEqual(asked, `${searchDefinitions.JOB_PREFIX}${ID}`);
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(body(response).status, 'warned');
    assert.deepStrictEqual(body(response).results, [{ indexer: 'chunks-indexer', status: 'stillRunning' }]);
  });

  await t.test('an id that is not a UUID never reaches the container', async () => {
    let reads = 0;
    t.mock.method(jobs, 'getById', async () => { reads++; return null; });
    const response = res();

    await controller.getSearchDefinitionJob({ params: { id: 'quota:1.2.3.4' } }, response);

    assert.strictEqual(response.statusCode, 404);
    assert.strictEqual(reads, 0, 'a non-UUID id must not be read back at all');
  });

  await t.test('an unknown job is a 404', async () => {
    t.mock.method(jobs, 'getById', async () => null);
    const response = res();

    await controller.getSearchDefinitionJob({ params: { id: ID } }, response);

    assert.strictEqual(response.statusCode, 404);
  });
});

test('search definition routes are sysadmin-gated', async (t) => {
  const paths = ['/admin/search-definitions/apply', '/admin/search-definitions/jobs/:id'];

  await t.test('every guard is declared in the route table', () => {
    const chains = routeChains();
    for (const path of paths) {
      const declared = chains.find(r => r.path === path);
      assert.ok(declared, `${path} must be declared in src/http/routes.js`);
      // The NAME from source, the same two-reading rule as db_auth.test.js: a count alone is
      // equally satisfied by passiveAuthMiddleware, which admits an anonymous caller.
      assert.match(declared.chain, /\bauthMiddleware\b/);
      assert.doesNotMatch(declared.chain, /\bpassiveAuthMiddleware\b/);
      assert.match(declared.chain, /\brequireAdmin\b/);
      assert.match(declared.chain, /requireRole\('sysadmin'\)/);
    }
  });

  await t.test('an unauthenticated apply is refused before the controller runs', async () => {
    let queued = 0;
    t.mock.method(searchDefinitions, 'enqueue', async () => { queued++; });
    t.after(() => t.mock.restoreAll());

    await withServer(async (call) => {
      const response = await call('/admin/search-definitions/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ only: ['projects'], live: true })
      });
      assert.strictEqual(response.status, 401);
    });
    assert.strictEqual(queued, 0);
  });
});
