'use strict';

/**
 * The value-level health check: a row count over a committed maximum has to reach the status a CI
 * step gates on, and an index that is not there must not pass as a zero.
 * Background: `docs/runbook-search-outage.md`, "Fields null on every row".
 */

process.env.NODE_ENV = 'test';
// Set before the controller reads it. Unconfigured is its own answer (asserted last), so without an
// endpoint every case here would pass while counting nothing.
process.env.SEARCH_ENDPOINT = 'https://demi-search-test.search.windows.net';
// Deliberately NOT the schema name: the committed checks and the response speak the schema name,
// the count goes to whatever the app setting points at.
process.env.SEARCH_INDEX_PROJECTS = 'projects-live';

const test = require('node:test');
const assert = require('node:assert');

// Before the app modules: they install an `uncaughtException` handler, which would turn a missing
// committed check list into a clean exit instead of a failed run.
const CHECKS = require('../../azure/search/data-checks.json');
const searchSchema = require('../../src/controllers/search-schema');
const aiSearch = require('../../src/search/ai-search');
const { logger } = require('../../src/utils/logger');

function capture() {
  const out = {};
  const res = {
    json: (data) => { out.body = data; return res; },
    status: (code) => { out.status = code; return res; }
  };
  return { out, res };
}

/**
 * Record every count and answer them all zero, unless `counts` claims one by field name.
 *
 * The field is read off the filter's first token rather than looked up in the committed file: the
 * expectations below are written out, so nothing here may derive them from the same source the
 * controller reads.
 *
 * @param {Object<string, number|null>} [counts] field -> the count to answer
 * @returns {Array<{indexName: string, filter: string}>} the calls, in order
 */
function stubCount(t, counts = {}) {
  const calls = [];
  t.mock.method(aiSearch, 'countMatching', async (indexName, filter) => {
    calls.push({ indexName, filter });
    const field = String(filter).split(' ')[0];
    return field in counts ? counts[field] : 0;
  });
  return calls;
}

const request = () => ({ query: {}, body: undefined, header: () => null });

test('search data health', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('every count within its maximum is a 200', async (tt) => {
    stubCount(tt);

    const { out, res } = capture();
    await searchSchema.searchData(request(), res);

    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.ok, true);
    // Written out, not mapped from the committed file: an expectation derived from the same source
    // the controller reads would hold whatever that file happened to say.
    assert.deepStrictEqual(out.body.checks, [
      { index: 'projects', field: 'currentPhaseNameId', count: 0, max: 0, ok: true },
      { index: 'projects', field: 'eacDecisionId', count: 0, max: 0, ok: true }
    ]);
  });

  // The count has to be asked of the index the app settings point at, with the filter as committed.
  // A check built here instead would go green against an index nothing serves.
  await t.test('it counts against the live index name, with the committed filter', async (tt) => {
    const calls = stubCount(tt);

    const { res } = capture();
    await searchSchema.searchData(request(), res);

    assert.deepStrictEqual(calls, [
      { indexName: 'projects-live', filter: 'currentPhaseNameId eq null and isPublished eq true' },
      { indexName: 'projects-live', filter: 'eacDecisionId eq null and isPublished eq true' }
    ]);
  });

  await t.test('a count over its maximum is a 503 naming the field and the number', async (tt) => {
    const warnings = [];
    tt.mock.method(logger, 'warn', (message) => warnings.push(message));
    stubCount(tt, { currentPhaseNameId: 359 });

    const { out, res } = capture();
    await searchSchema.searchData(request(), res);

    assert.strictEqual(out.status, 503, 'the deploy job and the schedule gate on the status alone');
    assert.strictEqual(out.body.ok, false);
    assert.deepStrictEqual(
      out.body.checks.find((c) => c.field === 'currentPhaseNameId'),
      { index: 'projects', field: 'currentPhaseNameId', count: 359, max: 0, ok: false });
    // The checks that passed stay in the body: an operator needs to know the fault is one field.
    assert.ok(out.body.checks.some((c) => c.ok === true), 'the passing checks are still reported');
    assert.ok(warnings.some((w) => w.includes('currentPhaseNameId') && w.includes('359')),
      `the log names the field and the count; got: ${warnings.join(' | ')}`);
  });

  // "The service answered without a count" is not zero, and zero is the passing answer here.
  await t.test('a missing count is a failure, not a zero', async (tt) => {
    tt.mock.method(logger, 'warn', () => {});
    stubCount(tt, { eacDecisionId: null });

    const { out, res } = capture();
    await searchSchema.searchData(request(), res);

    assert.strictEqual(out.status, 503);
    assert.strictEqual(out.body.checks.find((c) => c.field === 'eacDecisionId').ok, false);
  });

  // An index that does not exist matches no rows, so a count would be the greenest answer possible.
  await t.test('an index that is not deployed is a 503, never a passing zero', async (tt) => {
    tt.mock.method(logger, 'warn', () => {});
    tt.mock.method(aiSearch, 'countMatching', async () => {
      throw Object.assign(
        new Error("No index with the name 'projects-live' was not found in the service"),
        { status: 404 });
    });

    const { out, res } = capture();
    await searchSchema.searchData(request(), res);

    assert.strictEqual(out.status, 503);
    assert.strictEqual(out.body.ok, false);
    // No `count` key at all: a count of zero is the passing answer here.
    assert.deepStrictEqual(out.body.checks, [
      { index: 'projects', field: 'currentPhaseNameId', ok: false, error: 'missing' },
      { index: 'projects', field: 'eacDecisionId', ok: false, error: 'missing' }
    ]);
  });

  // Not a data fault: a role, a timeout, a bad filter. The upstream text names the endpoint and the
  // index, and this route is anonymous, so it must not reach the body.
  await t.test('a check that fails for another reason is a 503 carrying no upstream text',
    async (tt) => {
      tt.mock.method(logger, 'error', () => {});
      tt.mock.method(aiSearch, 'countMatching', async () => {
        throw Object.assign(
          new Error('HTTP 403 Forbidden. demi-search-prod.search.windows.net'), { status: 403 });
      });

      const { out, res } = capture();
      await searchSchema.searchData(request(), res);

      assert.strictEqual(out.status, 503);
      assert.strictEqual(out.body.checks[0].error, 'check failed');
      assert.ok(!JSON.stringify(out.body).includes('search.windows.net'));
    });

  // Not "no bad rows". An app with no SEARCH_ENDPOINT has counted nothing, and a green answer here
  // would sign off a deploy whose search cannot run at all.
  await t.test('an app with no search endpoint is a 503, not an empty pass', async (tt) => {
    const endpoint = process.env.SEARCH_ENDPOINT;
    delete process.env.SEARCH_ENDPOINT;
    tt.after(() => { process.env.SEARCH_ENDPOINT = endpoint; });
    const calls = stubCount(tt);

    const { out, res } = capture();
    await searchSchema.searchData(request(), res);

    assert.strictEqual(out.status, 503);
    assert.strictEqual(out.body.ok, false);
    assert.strictEqual(calls.length, 0);
  });
});

/**
 * The committed list itself. It is the whole content of this gate — an entry silently dropped or
 * given a maximum above zero turns the endpoint into a 200 that means nothing.
 */
test('azure/search/data-checks.json', async (t) => {
  await t.test('every entry is a runnable check', () => {
    assert.ok(Array.isArray(CHECKS) && CHECKS.length, 'the committed list must not be empty');
    for (const check of CHECKS) {
      assert.strictEqual(typeof check.index, 'string');
      assert.strictEqual(typeof check.field, 'string');
      assert.strictEqual(typeof check.filter, 'string');
      assert.ok(Number.isInteger(check.max) && check.max >= 0, `${check.field} needs a maximum`);
      // The filter names the field it is about. One that does not is checking something else under
      // that field's name, and its failure would send an operator to the wrong place.
      assert.ok(check.filter.includes(check.field), `${check.filter} does not name ${check.field}`);
    }
  });

  // An unfilterable field is a 400 on every run: a check that can never answer.
  await t.test('every field a filter names is filterable in the committed definition', () => {
    for (const check of CHECKS) {
      const definition = require(`../../azure/search/indexes/${check.index}.json`);
      const named = definition.fields.filter(
        (f) => new RegExp(`\\b${f.name}\\b`).test(check.filter));
      assert.ok(named.some((f) => f.name === check.field),
        `${check.index} filter does not name ${check.field}`);
      for (const field of named) {
        assert.strictEqual(field.filterable, true, `${field.name} cannot be filtered on`);
      }
    }
  });

  await t.test('the two fields the public project list renders are still checked', () => {
    for (const field of ['currentPhaseNameId', 'eacDecisionId']) {
      const check = CHECKS.find((c) => c.index === 'projects' && c.field === field);
      assert.ok(check, `${field} is no longer checked, and it is why this gate exists`);
      assert.strictEqual(check.max, 0, `${field} tolerating a null row would let the empty rows through`);
    }
  });
});
