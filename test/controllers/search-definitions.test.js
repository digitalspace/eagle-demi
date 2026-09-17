'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../src/config');
const jobs = require('../../src/repositories/bulk-downloads');
const searchDefinitions = require('../../src/jobs/search-definitions');
const controller = require('../../src/controllers/search-definitions');
const audit = require('../../src/utils/audit');
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
function accept(t, { active = [], audited = [] } = {}) {
  const sent = [];
  let created = null;
  t.mock.method(jobs, 'create', async (job) => { created = job; return job; });
  t.mock.method(jobs, 'listActiveSearchDefinitionJobs', async () => active);
  t.mock.method(searchDefinitions, 'enqueue', async (id) => { sent.push(id); });
  // Inert in the suite (no DCR configured), so it is recorded rather than stubbed out — the audit
  // row is part of what the route owes, not a side effect of it.
  t.mock.method(audit, 'auditEvent', (req, event) => { audited.push(event); });
  return { sent, audited, job: () => created };
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
    t.mock.method(jobs, 'listActiveSearchDefinitionJobs', async () => []);
    t.mock.method(jobs, 'patch', async (id, fields) => { patched = { id, fields }; });
    t.mock.method(searchDefinitions, 'enqueue', async () => { throw new Error('queue is gone'); });
    const response = res();

    await controller.applySearchDefinitions(post({ only: ['projects'] }), response);

    assert.strictEqual(response.statusCode, 503);
    assert.strictEqual(patched.fields.status, 'failed');
  });

  await t.test('a live run with no only list is refused', async () => {
    // An empty `only` is "everything", and live+everything resets every indexer including chunks,
    // which is hours of rebuild with search serving a partial index. Nobody asks for that by
    // leaving a field out.
    const taken = accept(t);
    const response = res();

    await controller.applySearchDefinitions(post({ live: true }), response);

    assert.strictEqual(response.statusCode, 400);
    assert.match(body(response).error, /only/);
    assert.deepStrictEqual(taken.sent, [], 'nothing was queued');
  });

  await t.test('a dry run with no only list is still allowed', async () => {
    // The guard is about what `live` does to the service, not about the shape of the request.
    accept(t);
    const response = res();

    await controller.applySearchDefinitions(post({}), response);

    assert.strictEqual(response.statusCode, 202);
  });

  await t.test('a repeated name is applied once', async () => {
    // The job runs one apply per entry, so a duplicate is the same PUT and the same reset twice.
    const taken = accept(t);
    const response = res();

    await controller.applySearchDefinitions(
      post({ only: ['projects', 'projects', 'documents'], live: true }), response);

    assert.strictEqual(response.statusCode, 202);
    assert.deepStrictEqual(taken.job().request.only, ['projects', 'documents']);
  });

  await t.test('a repeated data source name is applied once', async () => {
    const taken = accept(t);
    const response = res();

    await controller.applySearchDefinitions(
      post({ only: ['projects'], datasources: ['demi-projects-ds', 'demi-projects-ds'], live: true }),
      response);

    assert.strictEqual(response.statusCode, 202);
    assert.deepStrictEqual(taken.job().request.datasources, ['demi-projects-ds']);
  });

  await t.test('more names than the cap is a 400, before the names are read back', async () => {
    // The unknown-name 400 quotes the entries it did not recognise, so an unbounded list would be
    // reflected into the response — and for `only` it would be one apply.run per entry.
    const taken = accept(t);
    const response = res();

    await controller.applySearchDefinitions(
      post({ only: Array.from({ length: 21 }, (_, i) => `name-${i}`) }), response);

    assert.strictEqual(response.statusCode, 400);
    assert.match(body(response).error, /at most 20/);
    assert.ok(!body(response).error.includes('name-7'), 'the list must not be echoed back');
    assert.deepStrictEqual(taken.sent, [], 'nothing was queued');
  });

  await t.test('the accepted run is written to the audit record', async () => {
    // It decides what the search service serves, so it belongs in the seven-year record beside
    // apikey.create rather than only in the app log.
    const taken = accept(t);
    const response = res();

    await controller.applySearchDefinitions(
      post({ only: ['projects'], datasources: ['demi-projects-ds'], live: true }), response);

    assert.strictEqual(response.statusCode, 202);
    assert.strictEqual(taken.audited.length, 1);
    const event = taken.audited[0];
    assert.strictEqual(event.action, 'searchDefinitions.apply');
    assert.strictEqual(event.targetId, taken.job().id, 'the row the event names has to be readable');
    assert.deepStrictEqual(event.detail, {
      only: ['projects'], datasources: ['demi-projects-ds'], live: true, check: false
    });
  });

  await t.test('a run that was never queued is not audited as one', async () => {
    const audited = [];
    t.mock.method(jobs, 'create', async (job) => job);
    t.mock.method(jobs, 'listActiveSearchDefinitionJobs', async () => []);
    t.mock.method(jobs, 'patch', async () => {});
    t.mock.method(audit, 'auditEvent', (req, event) => { audited.push(event); });
    t.mock.method(searchDefinitions, 'enqueue', async () => { throw new Error('queue is gone'); });
    const response = res();

    await controller.applySearchDefinitions(post({ only: ['projects'] }), response);

    assert.strictEqual(response.statusCode, 503);
    assert.deepStrictEqual(audited, [], 'an apply that never reached the queue did not happen');
  });

  await t.test('a second apply is refused while one is still going', async () => {
    // Two runs PUT the same definitions and reset the same indexers, and the second reset throws
    // away the high-water mark the first is rebuilding from — for chunks, hours of work.
    const running = `${searchDefinitions.JOB_PREFIX}6f1c4b9e-0d2a-4d9d-9c3e-1f5f9a2b7c40`;
    const taken = accept(t, { active: [{ id: running, status: 'running' }] });
    const response = res();

    await controller.applySearchDefinitions(post({ only: ['chunks'], live: true }), response);

    assert.strictEqual(response.statusCode, 409);
    assert.strictEqual(body(response).jobId, running.slice(searchDefinitions.JOB_PREFIX.length),
      'the caller needs the job that is in the way, to poll it');
    assert.deepStrictEqual(taken.sent, [], 'nothing was queued');
    assert.strictEqual(taken.job(), null, 'and no row was written');
  });

  await t.test('a queued job that has not started yet blocks just the same', async () => {
    const taken = accept(t, {
      active: [{ id: `${searchDefinitions.JOB_PREFIX}00000000-0000-4000-8000-000000000000`, status: 'queued' }]
    });
    const response = res();

    await controller.applySearchDefinitions(post({ only: ['projects'], live: true }), response);

    assert.strictEqual(response.statusCode, 409);
    assert.deepStrictEqual(taken.sent, []);
  });

  await t.test('a running row whose worker died is not a run in flight', async () => {
    // A worker the host killed mid-run leaves `running` on the row for the rest of its 30-day TTL,
    // and nothing is coming to finish it. Counting that row as active refuses every apply for a
    // month, with a hand-edited Cosmos document as the only way out.
    const dead = new Date(Date.now() - searchDefinitions.WAIT_TIMEOUT_MS - 60 * 60 * 1000).toISOString();
    const taken = accept(t, {
      active: [{
        id: `${searchDefinitions.JOB_PREFIX}00000000-0000-4000-8000-000000000001`,
        status: 'running', createdAt: dead, startedAt: dead
      }]
    });
    const response = res();

    await controller.applySearchDefinitions(post({ only: ['projects'], live: true }), response);

    assert.strictEqual(response.statusCode, 202);
    assert.strictEqual(taken.sent.length, 1, 'the new run was queued');
  });

  await t.test('a running row still inside the wait window blocks', async () => {
    // The other side of the same rule: a chunks rebuild legitimately holds `running` for hours,
    // and a staleness window that swallowed it would let two applies reset the same indexer.
    const started = new Date(Date.now() - 60 * 1000).toISOString();
    const taken = accept(t, {
      active: [{
        id: `${searchDefinitions.JOB_PREFIX}00000000-0000-4000-8000-000000000002`,
        status: 'running', createdAt: started, startedAt: started
      }]
    });
    const response = res();

    await controller.applySearchDefinitions(post({ only: ['projects'], live: true }), response);

    assert.strictEqual(response.statusCode, 409);
    assert.deepStrictEqual(taken.sent, []);
  });

  await t.test('a queued row is dated from when it was created, having never started', async () => {
    // A `queued` row has no startedAt, so reading only that stamp would make every queued row
    // stale at once and the 409 would never fire before a worker picked the job up.
    const made = new Date(Date.now() - 60 * 1000).toISOString();
    const taken = accept(t, {
      active: [{
        id: `${searchDefinitions.JOB_PREFIX}00000000-0000-4000-8000-000000000003`,
        status: 'queued', createdAt: made
      }]
    });
    const response = res();

    await controller.applySearchDefinitions(post({ only: ['projects'], live: true }), response);

    assert.strictEqual(response.statusCode, 409);
    assert.deepStrictEqual(taken.sent, []);
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
