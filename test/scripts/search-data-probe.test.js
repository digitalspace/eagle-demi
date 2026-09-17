'use strict';

/**
 * The value-level gate, end to end against a stub API: which HTTP answers stop a release, and
 * whether a red log tells the operator what to do. A 503 with no hint sends somebody to the AI
 * Search portal for a fault that is fixed by re-pushing from eagle-api.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { startStub, runScript } = require('../helpers/stub-http');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'search-data-probe.sh');

function runProbe(baseUrl, env = {}) {
  return runScript(SCRIPT, [baseUrl], { cwd: REPO_ROOT, env });
}

const PASSING = {
  ok: true,
  checks: [
    { index: 'projects', field: 'currentPhaseNameId', count: 0, max: 0, ok: true },
    { index: 'projects', field: 'eacDecisionId', count: 0, max: 0, ok: true }
  ]
};

const FAILING = {
  ok: false,
  checks: [
    { index: 'projects', field: 'currentPhaseNameId', count: 359, max: 0, ok: false },
    { index: 'projects', field: 'eacDecisionId', count: 0, max: 0, ok: true }
  ]
};

async function probeAgainst(respond, env = {}) {
  const stub = await startStub(respond);
  try {
    return { run: await runProbe(stub.url, env), stub };
  } finally {
    await stub.close();
  }
}

test('search-data-probe.sh', async (t) => {
  await t.test('a 200 exits 0 and prints one line per check', async () => {
    const { run, stub } = await probeAgainst(() => ({ status: 200, json: PASSING }));

    assert.strictEqual(run.status, 0, run.stderr);
    assert.deepStrictEqual(stub.requests.map((r) => `${r.method} ${r.url}`),
      ['GET /health/search-data']);
    assert.match(run.stdout, /projects currentPhaseNameId 0\/0 ok/);
    assert.match(run.stdout, /projects eacDecisionId 0\/0 ok/);
  });

  await t.test('a 503 exits 1, names the failing check and prints the fix', async () => {
    const { run } = await probeAgainst(() => ({ status: 503, json: FAILING }));

    assert.strictEqual(run.status, 1, 'a 503 that passed would ship the outage this gate exists for');
    assert.match(run.stderr, /projects currentPhaseNameId 359\/0 FAIL/);
    // The passing check is still printed: the fault being one field is the diagnosis.
    assert.match(run.stderr, /projects eacDecisionId 0\/0 ok/);
    // Whitespace-tolerant: the hint is wrapped across lines in the output.
    assert.match(run.stderr.replace(/\s+/g, ' '),
      /eagle-api pushed before its List refs were resolved/);
    assert.match(run.stderr,
      /node scripts\/demi-repush\.js --kind project --live --concurrency 1/);
    assert.match(run.stderr, /PT5M/);
  });

  // A check that could not run is not a check that passed. The endpoint reports no count for it,
  // and the line has to say so rather than print `undefined/undefined`.
  await t.test('an index that is not deployed is printed as missing', async () => {
    const { run } = await probeAgainst(() => ({
      status: 503,
      json: { ok: false, checks: [{ index: 'projects', field: 'currentPhaseNameId', ok: false, error: 'missing' }] }
    }));

    assert.strictEqual(run.status, 1);
    assert.match(run.stderr, /projects currentPhaseNameId missing FAIL/);
  });

  await t.test('a 404 exits 1 unless the one deploy that ships the route says otherwise', async () => {
    const missing = () => ({ status: 404, body: 'Not Found' });

    const refused = await probeAgainst(missing);
    assert.strictEqual(refused.run.status, 1,
      'a 404 that passed on its own would make every run of this gate decorative');
    assert.match(refused.run.stderr, /no \/health\/search-data/);

    const allowed = await probeAgainst(missing, { SEARCH_DATA_ALLOW_MISSING: '1' });
    assert.strictEqual(allowed.run.status, 0, allowed.run.stderr);
    assert.match(allowed.run.stdout, /ungated/);
  });

  await t.test('an unreachable API exits 1', async () => {
    const { run } = await probeAgainst(() => ({ destroy: true }));

    assert.strictEqual(run.status, 1);
    assert.match(run.stderr, /could not reach/);
  });

  // 200 is not the answer on its own: the body has to carry the counts. A proxy or gateway that
  // answers 200 with an error page is the shape that would otherwise turn this gate green forever.
  await t.test('a 200 carrying an HTML error page exits 1 and prints no summary', async () => {
    const { run } = await probeAgainst(() => ({
      status: 200,
      body: '<html><head><title>502 Bad Gateway</title></head><body>error</body></html>'
    }));

    assert.strictEqual(run.status, 1);
    assert.match(run.stderr, /no readable checks/);
    assert.ok(!run.stdout.includes('✓'),
      `nothing was counted, so there is no clean run to report; got: ${run.stdout}`);
  });

  await t.test('a 200 whose JSON carries no checks exits 1 and prints no summary', async () => {
    const { run } = await probeAgainst(() => ({ status: 200, json: { ok: true } }));

    assert.strictEqual(run.status, 1, 'an empty check list counted nothing and must not pass');
    assert.match(run.stderr, /no readable checks/);
    assert.ok(!run.stdout.includes('✓'), `got: ${run.stdout}`);
  });

  await t.test('an unexpected status exits 1', async () => {
    const { run } = await probeAgainst(() => ({ status: 500, body: 'upstream error' }));

    assert.strictEqual(run.status, 1);
    assert.match(run.stderr, /answered 500/);
  });

  await t.test('an empty base URL exits 1 rather than checking nothing', async () => {
    const run = await runScript(SCRIPT, [''], { cwd: REPO_ROOT });

    assert.strictEqual(run.status, 1);
    assert.match(run.stderr, /no base URL/);
  });
});
