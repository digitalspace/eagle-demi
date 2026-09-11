'use strict';

/**
 * The pre-deploy gate, exercised end to end against a stub API.
 *
 * What it has to get right is not "does it POST": it is which field names leave this repo, and
 * which HTTP answers stop a release. A `select` carrying a non-retrievable field would 400 on a
 * healthy index and read as drift; a 503 that passed would ship the outage this gate exists to
 * prevent; a 404 that passed on its own would make every run of this gate decorative.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startStub, runScript } = require('../helpers/stub-http');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'search-schema-probe.sh');

function runProbe(baseUrl, env = {}) {
  return runScript(SCRIPT, [baseUrl], { cwd: REPO_ROOT, env });
}

/**
 * The body that was POSTed. Every run first GETs the endpoint to learn which indexes the deployed
 * app knows, so the POST is never the first request on the stub.
 */
function postedBody(stub) {
  const posts = stub.requests.filter((r) => r.method === 'POST');
  assert.strictEqual(posts.length, 1, `POSTs: ${posts.length}`);
  return JSON.parse(posts[0].body);
}

test('search-schema-probe.sh', async (t) => {
  await t.test('sends every committed index, with the fields the live index must answer', async () => {
    const stub = await startStub(() => ({ status: 200, json: { ok: true } }));
    let run;
    try {
      run = await runProbe(stub.url);
    } finally {
      await stub.close();
    }

    assert.strictEqual(run.status, 0, run.stderr);
    assert.deepStrictEqual(stub.requests.map((r) => r.method), ['GET', 'POST']);
    assert.deepStrictEqual([...new Set(stub.requests.map((r) => r.url))], ['/health/search-schema']);

    const { indexes } = postedBody(stub);
    assert.deepStrictEqual(Object.keys(indexes).sort(),
      ['activities', 'chunks', 'documents', 'project-notifications', 'projects']);
    // Ids and nothing else: the two keyword indexes rank rows, and the row itself is read back
    // from Cosmos. A searchable field turning retrievable here would start returning index text.
    assert.deepStrictEqual(indexes.activities.select, ['id', 'eagleId', 'projectId']);
    assert.deepStrictEqual(indexes['project-notifications'].select, ['id', 'eagleId']);

    // `fileSize` is the field the 2026-09-08 outage shipped without. If it stops being probed the
    // gate is decorative.
    assert.ok(indexes.documents.select.includes('fileSize'));
    // Not retrievable (azure/search/indexes/documents.json), so it cannot be selected — AI Search
    // answers 400, which this script would report as drift that is not there.
    assert.ok(!indexes.documents.select.includes('fileNameTokens'));
    assert.ok(!indexes.projects.select.includes('nameTokens'));
    // Sortable but not retrievable: still out of the select.
    assert.ok(!indexes.documents.select.includes('displayNameSort'));
    assert.ok(indexes.projects.select.includes('centroid'));
    // No orderby: the endpoint derives the orders from buildOrderBy, which knows the app orders
    // `documents` by displayNameSort and never by displayName. Sending a list built from the
    // `sortable` flags would block a release over fields no query sorts on.
    assert.ok(!('orderby' in indexes.documents));
    assert.ok(!('orderby' in indexes.projects));
    assert.ok(!('orderby' in indexes.chunks));
  });

  await t.test('probes the index definitions it is pointed at, not the ones beside the script', async () => {
    // The prod gate runs the WORKFLOW REF's copy of this script against the DEPLOYED TAG's index
    // definitions, checked out under release/. An ignored argument would gate the release on
    // main's definitions, which is not the version being shipped.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-indexes-'));
    fs.writeFileSync(path.join(dir, 'documents.json'), JSON.stringify({
      name: 'documents',
      fields: [{ name: 'id' }, { name: 'fieldOnlyThisTagHas' }, { name: 'hidden', retrievable: false }]
    }));

    const stub = await startStub(() => ({ status: 200, json: { ok: true } }));
    let run;
    try {
      // Relative, resolved against the working directory, the way the workflow passes it.
      run = await runScript(SCRIPT, [stub.url, path.relative(REPO_ROOT, dir)], { cwd: REPO_ROOT });
    } finally {
      await stub.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }

    assert.strictEqual(run.status, 0, run.stderr);
    const { indexes } = postedBody(stub);
    assert.deepStrictEqual(Object.keys(indexes), ['documents']);
    assert.deepStrictEqual(indexes.documents.select, ['id', 'fieldOnlyThisTagHas']);
  });

  await t.test('probes only the indexes the deployed app knows, naming the ones it skips', async () => {
    // The release that ADDS an index runs against the app that does not have it yet, and that app
    // answers 400 to a body naming more indexes than it compiled in. Posting the whole body would
    // block the release that ships the index, on the one thing about it that is expected.
    const stub = await startStub((req) => (req.method === 'GET'
      ? { status: 200, json: { ok: true, indexes: { chunks: { ok: true }, projects: { ok: true }, documents: { ok: true } } } }
      : { status: 200, json: { ok: true } }));
    let run;
    try {
      run = await runProbe(stub.url);
    } finally {
      await stub.close();
    }

    assert.strictEqual(run.status, 0, run.stderr);
    const { indexes } = postedBody(stub);
    assert.deepStrictEqual(Object.keys(indexes).sort(), ['chunks', 'documents', 'projects']);
    // Silent dropping is how this gate would quietly stop probing an index for good.
    assert.match(run.stdout, /skipping activities: not known to the deployed app at /);
    assert.match(run.stdout, /skipping project-notifications: not known to the deployed app at /);
    assert.strictEqual(run.stdout.match(/^skipping /gm).length, 2);
  });

  await t.test('posts every committed index when the deployed app will not say what it knows', async () => {
    // An unreadable answer is not evidence that an index is unknown. Dropping on it would narrow
    // the gate every time a proxy returned an error page.
    const stub = await startStub((req) => (req.method === 'GET'
      ? { status: 500, body: '<html>gateway error</html>' }
      : { status: 200, json: { ok: true } }));
    let run;
    try {
      run = await runProbe(stub.url);
    } finally {
      await stub.close();
    }

    assert.strictEqual(run.status, 0, run.stderr);
    const { indexes } = postedBody(stub);
    assert.deepStrictEqual(Object.keys(indexes).sort(),
      ['activities', 'chunks', 'documents', 'project-notifications', 'projects']);
    assert.doesNotMatch(run.stdout, /^skipping /m);
  });

  await t.test('fails when the cut leaves nothing to probe', async () => {
    // Every index skipped is a step that exits 0 having asked the live index nothing — the same
    // ungated release an empty base URL would wave through.
    const stub = await startStub((req) => (req.method === 'GET'
      ? { status: 200, json: { ok: true, indexes: { 'some-other-index': { ok: true } } } }
      : { status: 200, json: { ok: true } }));
    let run;
    try {
      run = await runProbe(stub.url);
    } finally {
      await stub.close();
    }

    assert.strictEqual(run.status, 1);
    assert.strictEqual(stub.requests.filter((r) => r.method === 'POST').length, 0);
    assert.match(run.stderr, /shares none of the committed indexes/);
    assert.match(run.stderr, /some-other-index/);
  });

  await t.test('an empty base URL fails instead of reading as a passing gate', async () => {
    // One renamed repository variable away: a step that exits 0 having asked the live index
    // nothing is the ungated release this gate exists to stop.
    for (const args of [[''], []]) {
      const run = await runScript(SCRIPT, args, { cwd: REPO_ROOT });
      assert.strictEqual(run.status, 1, JSON.stringify(args));
      assert.match(run.stderr, /no base URL/);
    }
  });

  await t.test('fails the release on drift, naming the field and how to widen the index', async () => {
    const stub = await startStub(() => ({
      status: 503,
      json: { ok: false, indexes: { documents: { ok: false, missing: ['fileSize'] } } }
    }));
    let run;
    try {
      run = await runProbe(stub.url);
    } finally {
      await stub.close();
    }

    assert.strictEqual(run.status, 1);
    assert.match(run.stderr, /documents: missing fileSize/);
    assert.match(run.stderr, /demi-devbox\.sh apply --env prod/);
    assert.match(run.stderr, /Runbook-Search-Outage\.md/);
  });

  await t.test('names the environment the operator has to widen', async () => {
    const stub = await startStub(() => ({
      status: 503,
      json: { ok: false, indexes: { projects: { ok: false, missing: ['vis'] } } }
    }));
    let run;
    try {
      run = await runProbe(stub.url, { DEMI_ENV: 'test' });
    } finally {
      await stub.close();
    }

    assert.strictEqual(run.status, 1);
    assert.match(run.stderr, /demi-devbox\.sh apply --env test/);
  });

  await t.test('fails on 404 — an endpoint that is not there checked nothing', async () => {
    const stub = await startStub(() => ({ status: 404, body: '{"error":"not found"}' }));
    let run;
    try {
      run = await runProbe(stub.url);
    } finally {
      await stub.close();
    }

    assert.strictEqual(run.status, 1);
    assert.match(run.stderr, /no \/health\/search-schema/);
    assert.match(run.stderr, /allow_missing_schema_probe/);
  });

  await t.test('passes on 404 only when the bootstrap deploy asks for it', async () => {
    const stub = await startStub(() => ({ status: 404, body: '{"error":"not found"}' }));
    let run;
    try {
      run = await runProbe(stub.url, { SEARCH_SCHEMA_ALLOW_MISSING: '1' });
    } finally {
      await stub.close();
    }

    assert.strictEqual(run.status, 0, run.stderr);
    // Silence would be the trap: a deploy that shipped ungated has to say so in the log.
    assert.match(run.stdout, /SEARCH_SCHEMA_ALLOW_MISSING=1/);
  });

  await t.test('fails on any other status rather than assuming the index is fine', async () => {
    const stub = await startStub(() => ({ status: 500, body: 'boom' }));
    let run;
    try {
      run = await runProbe(stub.url);
    } finally {
      await stub.close();
    }

    assert.strictEqual(run.status, 1);
    assert.match(run.stderr, /answered 500/);
  });

  await t.test('fails when the API cannot be reached', async () => {
    // Port 1 on loopback: nothing listens, and the connection is refused rather than hanging.
    const run = await runProbe('http://127.0.0.1:1');
    assert.strictEqual(run.status, 1);
    assert.match(run.stderr, /could not reach/);
  });
});
