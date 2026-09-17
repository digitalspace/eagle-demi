'use strict';

process.env.NODE_ENV = 'test';
// The job reads the endpoint from src/search/ai-search.js, which reads this at call time.
process.env.SEARCH_ENDPOINT = 'https://demi-search-test.search.windows.net';
// Both keyword indexes on, so the serving list the job hands apply.run has five distinct names.
process.env.SEARCH_INDEX_ACTIVITIES = 'activities';
process.env.SEARCH_INDEX_PROJECT_NOTIFICATIONS = 'project-notifications';

const test = require('node:test');
const assert = require('node:assert');

const jobs = require('../../src/repositories/bulk-downloads');
const aiSearch = require('../../src/search/ai-search');
const apply = require('../../src/scripts/apply-search-definitions');
const datasources = require('../../src/scripts/put-search-datasources');
const resetIndexers = require('../../src/scripts/reset-and-run-indexers');
const searchDefinitions = require('../../src/jobs/search-definitions');

const ID = `${searchDefinitions.JOB_PREFIX}6f1c4b9e-0d2a-4d9d-9c3e-1f5f9a2b7c40`;

function row(overrides = {}) {
  return {
    id: ID,
    status: 'queued',
    request: { only: ['projects'], datasources: [], live: true, check: false },
    ...overrides
  };
}

/**
 * Everything that would reach the search service, replaced. The patches are collected in order,
 * because the ORDER of the `resetIssuedAt` write against the reset is the property under test.
 */
function harness(t, { job, code = 0, resetLog = [] } = {}) {
  const patches = [];
  const applied = [];
  const resets = [];
  // What the row had been patched with by the time the reset was issued — the stamp has to be in
  // there, not written afterwards.
  const patchedByReset = [];
  t.mock.method(jobs, 'getById', async () => job);
  t.mock.method(jobs, 'patch', async (id, fields) => { patches.push(fields); });
  t.mock.method(aiSearch, 'getToken', async () => 'token');
  t.mock.method(apply, 'run', async (options) => { applied.push(options); });
  t.mock.method(datasources, 'putDataSources', async () => 1);
  t.mock.method(resetIndexers, 'resetAndRun', async (options) => {
    resets.push(options);
    patchedByReset.push(patches.slice());
    for (const line of resetLog) options.log(line);
    return code;
  });
  return { patches, applied, resets, patchedByReset, final: () => patches[patches.length - 1] };
}

test('search definition job', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('applies the definitions, then resets and runs the indexers it selected', async () => {
    const h = harness(t, {
      job: row(),
      resetLog: ['DEMI_RESULT name=projects-indexer status=success items=361 failed=0 tracking=null']
    });

    await searchDefinitions.run(ID);

    assert.strictEqual(h.applied.length, 1);
    assert.strictEqual(h.applied[0].only, 'projects');
    assert.strictEqual(h.applied[0].live, true);
    assert.deepStrictEqual(h.resets[0].names, ['projects-indexer']);
    assert.strictEqual(h.resets[0].mode, 'reset');
    assert.strictEqual(h.final().status, 'succeeded');
    assert.deepStrictEqual(h.final().results, [{
      indexer: 'projects-indexer', status: 'success',
      itemsProcessed: '361', itemsFailed: '0', tracking: 'null'
    }]);
  });

  // liveNames is the only thing that makes apply.run refuse a non-additive PUT over an index the
  // app is serving, so an empty list here would silently drop that guard.
  await t.test('names the indexes the app is serving, so a non-additive PUT over one is refused', async () => {
    const h = harness(t, { job: row() });

    await searchDefinitions.run(ID);

    assert.deepStrictEqual(h.applied[0].liveNames,
      ['chunks', 'projects', 'documents', 'activities', 'project-notifications']);
  });

  await t.test('the reset stamp is written BEFORE the reset, so a redelivery can see it', async () => {
    const h = harness(t, { job: row() });

    await searchDefinitions.run(ID);

    assert.ok(h.patches.some(p => p.resetIssuedAt), 'the job must record when the reset was issued');
    assert.ok(h.patchedByReset[0].some(p => p.resetIssuedAt),
      'a stamp written after the reset cannot stop a redelivery from resetting again');
  });

  await t.test('a redelivery past the reset watches instead of resetting again', async () => {
    const h = harness(t, {
      job: row({ status: 'running', resetIssuedAt: '2026-09-17T10:00:00.000Z' }),
      resetLog: ['DEMI_RESULT name=projects-indexer status=success items=361 failed=0 tracking=null']
    });

    await searchDefinitions.run(ID, { attempt: 2, maxAttempts: 3 });

    assert.deepStrictEqual(h.applied, [], 'nothing is PUT a second time');
    assert.strictEqual(h.resets[0].mode, 'watch', 'a second reset would throw away the rebuild');
    assert.deepStrictEqual(h.patches.filter(p => p.resetIssuedAt), [],
      'the original stamp is never rewritten');
    assert.strictEqual(h.final().status, 'succeeded');
  });

  await t.test('a finished job is left alone — nothing is applied and nothing is reset', async () => {
    const h = harness(t, { job: row({ status: 'succeeded' }) });

    await searchDefinitions.run(ID, { attempt: 2, maxAttempts: 3 });

    assert.deepStrictEqual(h.patches, []);
    assert.deepStrictEqual(h.applied, []);
    assert.deepStrictEqual(h.resets, []);
  });

  await t.test('an indexer that did not finish cleanly fails the job', async () => {
    const h = harness(t, { job: row(), code: 1, resetLog: ['DEMI_FAIL projects-indexer ended transientFailure'] });

    await searchDefinitions.run(ID);

    assert.strictEqual(h.final().status, 'failed');
  });

  await t.test('an indexer still running at the deadline is a warning, not a failure', async () => {
    const h = harness(t, {
      job: row({ request: { only: ['chunks'], datasources: [], live: true, check: false } }),
      resetLog: ['DEMI_WARN chunks-indexer still running after 1500s']
    });

    await searchDefinitions.run(ID);

    assert.strictEqual(h.final().status, 'warned');
    assert.deepStrictEqual(h.final().results, [{ indexer: 'chunks-indexer', status: 'stillRunning' }]);
  });

  await t.test('a dry run writes nothing and resets nothing', async () => {
    const h = harness(t, {
      job: row({ request: { only: ['projects'], datasources: ['demi-projects-ds'], live: false, check: false } })
    });

    await searchDefinitions.run(ID);

    assert.strictEqual(h.applied[0].live, false);
    assert.deepStrictEqual(h.resets, [], 'a dry run must not touch a live indexer');
    assert.strictEqual(h.final().status, 'succeeded');
  });

  await t.test('data sources are PUT only on a live run, and only the ones asked for', async () => {
    let asked = null;
    harness(t, {
      job: row({ request: { only: ['projects'], datasources: ['demi-projects-ds'], live: true, check: false } })
    });
    t.mock.method(datasources, 'putDataSources', async (options) => { asked = options.names; return 1; });

    await searchDefinitions.run(ID);

    assert.deepStrictEqual(asked, ['demi-projects-ds']);
  });

  await t.test('a check run reports drift as warned and never applies', async () => {
    const h = harness(t, { job: row({ request: { only: [], datasources: [], live: false, check: true } }) });
    t.mock.method(apply, 'runCheck', async (options) => {
      options.log('drift projects: missing fields eacNumber');
      return 1;
    });

    await searchDefinitions.run(ID);

    assert.deepStrictEqual(h.applied, []);
    assert.strictEqual(h.final().status, 'warned');
    assert.deepStrictEqual(h.final().steps, ['drift projects: missing fields eacNumber']);
  });

  await t.test('a failure mid-apply lands on the row rather than in the queue', async () => {
    const h = harness(t, { job: row() });
    t.mock.method(apply, 'run', async () => { throw new Error('PUT /indexes/projects -> 403'); });

    // Does not rethrow: a retry would re-PUT and re-reset what a human has to look at first.
    await searchDefinitions.run(ID);

    assert.strictEqual(h.final().status, 'failed');
    assert.match(h.final().error, /403/);
    assert.deepStrictEqual(h.resets, []);
  });

  await t.test('a job whose row is gone is logged, not run against a guess', async () => {
    const h = harness(t, { job: null });

    await searchDefinitions.run(ID);

    assert.deepStrictEqual(h.applied, []);
    assert.deepStrictEqual(h.patches, []);
  });
});

test('search definition job inputs', async (t) => {
  await t.test('the names a request may ask for are the definitions this package carries', () => {
    const known = searchDefinitions.knownNames();
    assert.ok(known.includes('chunks'), 'an index name');
    assert.ok(known.includes('chunks-indexer'), 'and its indexer name');
    assert.ok(searchDefinitions.knownDataSourceNames().includes('demi-chunks-ds'));
  });

  await t.test('an empty only list selects every indexer', () => {
    assert.deepStrictEqual(
      searchDefinitions.indexersFor([]).sort(),
      apply.load(apply.INDEXER_DIR).map(d => d.body.name).sort()
    );
  });

  await t.test('the wait ends before the host kills the worker', () => {
    const functionTimeoutMs = 30 * 60 * 1000; // host.json
    assert.ok(searchDefinitions.WAIT_TIMEOUT_MS < functionTimeoutMs,
      'a wait at the function timeout leaves the row stuck on `running`');
  });
});
