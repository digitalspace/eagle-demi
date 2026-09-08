'use strict';

/**
 * The post-deploy check, exercised end to end against a stub API.
 *
 * The 2026-09-08 outage passed every gate the pipeline had, because the app was up: only a real
 * query showed it. So the assertions here are about what counts as an answer — a 200 with no rows
 * is a failure for the unfiltered queries, and a 200 with no rows is fine for the project-filtered
 * one, which can legitimately match nothing.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { startStub, runScript } = require('../helpers/stub-http');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'search-smoke.sh');

/** The API's envelope: src/controllers/search.js wraps every search this way. */
function searchBody(total) {
  return [{
    searchResults: total > 0 ? [{ _id: 'x' }] : [],
    meta: total === null ? [{}] : [{ searchResultsTotal: total }]
  }];
}

function runSmoke(baseUrl, projectId) {
  const args = projectId === undefined ? [baseUrl] : [baseUrl, projectId];
  return runScript(SCRIPT, args, { cwd: REPO_ROOT });
}

/** Answer each of the three queries with a total, or a `{ status }` to answer badly. */
function stubOf(plan) {
  return startStub((req) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const dataset = url.searchParams.get('dataset');
    const filtered = url.searchParams.has('and[project]');
    const key = dataset === 'Project' ? 'project' : (filtered ? 'documentFiltered' : 'document');
    const answer = plan[key];
    if (answer && typeof answer === 'object') return { status: answer.status, body: 'upstream said no' };
    return { status: 200, json: searchBody(answer) };
  });
}

test('search-smoke.sh', async (t) => {
  await t.test('asks the three queries a broken deploy would break', async () => {
    const stub = await stubOf({ document: 42, project: 7, documentFiltered: 3 });
    let run;
    try {
      run = await runSmoke(stub.url);
    } finally {
      await stub.close();
    }

    assert.strictEqual(run.status, 0, run.stderr);
    const asked = stub.requests.map((r) => r.url);
    assert.strictEqual(asked.length, 3);
    assert.ok(asked.every((u) => u.startsWith('/search?')));
    assert.ok(asked.some((u) => u.includes('dataset=Document') && !u.includes('project')));
    assert.ok(asked.some((u) => u.includes('dataset=Project')));
    // The documented default id, url-encoded as a bracketed key.
    assert.ok(asked.some((u) => u.includes('and%5Bproject%5D=5e31dc4462cdea0021d974b4')));
    assert.ok(asked.every((u) => u.includes('pageNum=0') && u.includes('pageSize=1')));
  });

  await t.test('takes the project id from its second argument', async () => {
    const stub = await stubOf({ document: 1, project: 1, documentFiltered: 0 });
    try {
      await runSmoke(stub.url, '588511c4aaecd9001b826192');
    } finally {
      await stub.close();
    }
    assert.ok(stub.requests.some((r) => r.url.includes('and%5Bproject%5D=588511c4aaecd9001b826192')));
  });

  await t.test('accepts zero rows for the project-filtered query, since it can match nothing', async () => {
    const stub = await stubOf({ document: 5, project: 5, documentFiltered: 0 });
    let run;
    try {
      run = await runSmoke(stub.url);
    } finally {
      await stub.close();
    }
    assert.strictEqual(run.status, 0, run.stderr);
  });

  await t.test('fails on a 200 with no documents — an index that answers nothing', async () => {
    const stub = await stubOf({ document: 0, project: 5, documentFiltered: 5 });
    let run;
    try {
      run = await runSmoke(stub.url);
    } finally {
      await stub.close();
    }
    assert.strictEqual(run.status, 1);
    assert.match(run.stderr, /Document search: 200 with searchResultsTotal=0/);
  });

  await t.test('fails when the total was never measured, rather than reading it as zero', async () => {
    const stub = await stubOf({ document: null, project: 5, documentFiltered: 5 });
    let run;
    try {
      run = await runSmoke(stub.url);
    } finally {
      await stub.close();
    }
    assert.strictEqual(run.status, 1);
    assert.match(run.stderr, /searchResultsTotal=none/);
  });

  await t.test('calls a request that never completed no response, not a body', async () => {
    // The three probes share one response file and curl leaves it untouched when no response ever
    // arrives, so printing it here would hand the operator the PREVIOUS probe's successful body as
    // this probe's error.
    const stub = await startStub((req) => {
      const dataset = new URL(req.url, 'http://127.0.0.1').searchParams.get('dataset');
      if (dataset === 'Project') return { destroy: true };
      return { status: 200, json: searchBody(42) };
    });
    let run;
    try {
      run = await runSmoke(stub.url);
    } finally {
      await stub.close();
    }

    assert.strictEqual(run.status, 1);
    assert.match(run.stderr, /Project search: no response/);
    assert.doesNotMatch(run.stderr, /searchResultsTotal":42/);
  });

  await t.test('fails on the 502 the drift outage served, and says so per query', async () => {
    const stub = await stubOf({ document: { status: 502 }, project: 5, documentFiltered: { status: 502 } });
    let run;
    try {
      run = await runSmoke(stub.url);
    } finally {
      await stub.close();
    }
    assert.strictEqual(run.status, 1);
    assert.match(run.stderr, /Document search: HTTP 502/);
    assert.match(run.stderr, /2 of 3 search smoke checks failed/);
    assert.match(run.stderr, /Runbook-Search-Outage\.md/);
    // Every query is asked even after one fails: a rollback decision wants the whole picture.
    assert.strictEqual(stub.requests.length, 3);
  });
});
