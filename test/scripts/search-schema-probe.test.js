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
const path = require('node:path');

const { startStub, runScript } = require('../helpers/stub-http');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'search-schema-probe.sh');

function runProbe(baseUrl, env = {}) {
  return runScript(SCRIPT, [baseUrl], { cwd: REPO_ROOT, env });
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
    assert.strictEqual(stub.requests.length, 1);
    assert.strictEqual(stub.requests[0].method, 'POST');
    assert.strictEqual(stub.requests[0].url, '/health/search-schema');

    const { indexes } = JSON.parse(stub.requests[0].body);
    assert.deepStrictEqual(Object.keys(indexes).sort(), ['chunks', 'documents', 'projects']);

    // `fileSize` is the field the 2026-09-08 outage shipped without. If it stops being probed the
    // gate is decorative.
    assert.ok(indexes.documents.select.includes('fileSize'));
    // Not retrievable (azure/search/indexes/documents.json), so it cannot be selected — AI Search
    // answers 400, which this script would report as drift that is not there.
    assert.ok(!indexes.documents.select.includes('fileNameTokens'));
    assert.ok(!indexes.projects.select.includes('nameTokens'));
    // Sortable but not retrievable: wrong for select, right for orderby.
    assert.ok(!indexes.documents.select.includes('displayNameSort'));
    assert.ok(indexes.documents.orderby.includes('displayNameSort'));
    // A geography point is sortable only through geo.distance(), never as a bare orderby field.
    assert.ok(indexes.projects.select.includes('centroid'));
    assert.ok(!indexes.projects.orderby.includes('centroid'));
    // Collection fields are not sortable at all.
    assert.ok(!indexes.documents.orderby.includes('read'));
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
