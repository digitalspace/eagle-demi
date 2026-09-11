'use strict';

/**
 * The committed-vs-live schema gate.
 *
 * Two tests already hold the selects against the committed `azure/search/indexes/*.json`, and both
 * were green through the 2026-09-08 prod outage: no workflow applies an index definition, so the
 * app shipped a `fileSize` select to a live index that did not carry it and every document query
 * became a 502. What is asserted here is that this route asks the LIVE service the same question,
 * with the selects and the orders the app actually emits, and that a CI step can gate on its
 * status alone.
 */

process.env.NODE_ENV = 'test';
// Set before the controller reads it. Unconfigured is its own answer (asserted last), so without an
// endpoint every case here would pass while probing nothing.
process.env.SEARCH_ENDPOINT = 'https://demi-search-test.search.windows.net';
// Deliberately NOT the schema names: the response keys and the request override speak the schema
// names, the probe speaks whatever the app settings point at.
process.env.SEARCH_INDEX = 'chunks-live';
process.env.SEARCH_INDEX_PROJECTS = 'projects-live';
process.env.SEARCH_INDEX_DOCUMENTS = 'documents-live';
process.env.SEARCH_INDEX_ACTIVITIES = 'activities-live';
process.env.SEARCH_INDEX_PROJECT_NOTIFICATIONS = 'project-notifications-live';

const test = require('node:test');
const assert = require('node:assert');

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
 * Record every probe and answer them all `ok`, unless `fail` claims one.
 *
 * @param {function} [fail] `(opts) => missingField | null`
 * @returns {Array} the probe arguments, in order
 */
function stubProbe(t, fail = () => null) {
  const probes = [];
  t.mock.method(aiSearch, 'probeIndexSchema', async (opts) => {
    probes.push(opts);
    const missing = fail(opts);
    return missing
      ? { ok: false, index: opts.indexName, missing: [missing] }
      : { ok: true, index: opts.indexName };
  });
  return probes;
}

const request = (body) => ({ query: {}, body, header: () => null });

test('search schema health', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('an index that answers everything is a 200', async (tt) => {
    stubProbe(tt);

    const { out, res } = capture();
    await searchSchema.searchSchema(request(), res);

    assert.strictEqual(out.status, 200);
    assert.deepStrictEqual(out.body, {
      ok: true,
      indexes: {
        chunks: { ok: true },
        projects: { ok: true },
        documents: { ok: true },
        activities: { ok: true },
        'project-notifications': { ok: true }
      }
    });
  });

  // The probe has to carry what the app carries. A gate that invented its own field list would go
  // green on exactly the release that widens a select without widening the index — the outage.
  await t.test('it probes each live index with the select the app emits', async (tt) => {
    const probes = stubProbe(tt);

    const { res } = capture();
    await searchSchema.searchSchema(request(), res);

    const selects = new Map(probes.filter(p => p.select).map(p => [p.indexName, p.select]));
    assert.deepStrictEqual(selects, new Map([
      ['chunks-live', aiSearch.CHUNK_SELECT],
      ['projects-live', aiSearch.PROJECT_SELECT],
      ['documents-live', aiSearch.DOCUMENT_SELECT],
      // Ids only: these two indexes rank rows, and the row is read back from Cosmos.
      ['activities-live', aiSearch.KEYWORD_INDEXES.activities.select],
      ['project-notifications-live', aiSearch.KEYWORD_INDEXES.notifications.select]
    ]), 'the schema names are the response keys; the live names come from the app settings');
  });

  // `displayNameSort` is in NO select — it is the padded copy `SORT_KEYS` orders documents by, and
  // it is the second field the plan records as null on the live prod index. A gate that probed
  // selects only would pass a deploy whose every document page is a 400.
  await t.test('it probes the orders the app emits, not only the selects', async (tt) => {
    const probes = stubProbe(tt);

    const { res } = capture();
    await searchSchema.searchSchema(request(), res);

    const ordered = probes
      .filter(p => p.indexName === 'documents-live' && p.orderby)
      .flatMap(p => p.orderby)
      .map(clause => clause.split(' ')[0]);

    for (const field of ['displayNameSort', 'datePosted', 'id']) {
      assert.ok(ordered.includes(field), `${field} is orderable by this app but never probed`);
    }
    assert.ok(!ordered.includes('centroid'),
      'centroid is sortable in the index and still a 400 — probing it would report false drift');
  });

  // `chunks` has no sortable field at all, so there is no order to probe and no request to spend.
  await t.test('an index that can carry no order is probed for its select alone', async (tt) => {
    const probes = stubProbe(tt);

    const { res } = capture();
    await searchSchema.searchSchema(request(), res);

    assert.deepStrictEqual(probes.filter(p => p.indexName === 'chunks-live').map(p => p.orderby),
      [undefined]);
  });

  await t.test('a live index missing a field is a 503 that names it', async (tt) => {
    const warnings = [];
    tt.mock.method(logger, 'warn', message => warnings.push(message));
    stubProbe(tt, opts => (opts.indexName === 'documents-live' ? 'fileSize' : null));

    const { out, res } = capture();
    await searchSchema.searchSchema(request(), res);

    assert.strictEqual(out.status, 503, 'the deploy job gates on the status alone');
    assert.deepStrictEqual(out.body, {
      ok: false,
      indexes: {
        chunks: { ok: true },
        projects: { ok: true },
        documents: { ok: false, missing: ['fileSize'] },
        activities: { ok: true },
        'project-notifications': { ok: true }
      }
    });
    assert.ok(warnings.some(w => w.includes('documents-live') && w.includes('fileSize')),
      `the log names the index and the field; got: ${warnings.join(' | ')}`);
  });

  // Not drift: a role, a wrong index name, a timeout. Reported as a failure, never as a missing
  // field, and the service's own message stays in the log — this route is anonymous and that text
  // carries the endpoint and the index name.
  await t.test('a probe that fails for another reason is a 503 carrying no upstream text',
    async (tt) => {
      tt.mock.method(logger, 'error', () => {});
      tt.mock.method(aiSearch, 'probeIndexSchema', async () => {
        throw Object.assign(
          new Error('HTTP 403 Forbidden. demi-search-prod.search.windows.net'), { status: 403 });
      });

      const { out, res } = capture();
      await searchSchema.searchSchema(request(), res);

      assert.strictEqual(out.status, 503);
      assert.deepStrictEqual(out.body.indexes.documents, { ok: false, missing: [], error: 'probe failed' });
      assert.ok(!JSON.stringify(out.body).includes('search.windows.net'));
    });

  // The whole point of the override: the prod job posts the INCOMING tag's selects to the CURRENTLY
  // deployed app, so a release that outruns the index is refused before the code is swapped.
  await t.test('a posted select is probed instead of the deployed one', async (tt) => {
    const probes = stubProbe(tt, opts => (String(opts.select).includes('newColumn') ? 'newColumn' : null));

    const { out, res } = capture();
    await searchSchema.searchSchema(
      request({ indexes: { documents: { select: ['id', 'newColumn'], orderby: ['newColumn'] } } }), res);

    assert.strictEqual(out.status, 503);
    assert.deepStrictEqual(out.body.indexes.documents, { ok: false, missing: ['newColumn'] });
    assert.deepStrictEqual(
      probes.filter(p => p.indexName === 'projects-live' && p.select).map(p => p.select),
      [aiSearch.PROJECT_SELECT], 'an override for one index leaves the others on the deployed select');
  });

  // A bare field name in `orderby` is a field name; the direction is not the question a schema
  // probe asks, and a workflow should not have to know that.
  await t.test('a posted order is probed as a clause, with or without a direction', async (tt) => {
    const probes = stubProbe(tt);

    const { res } = capture();
    await searchSchema.searchSchema(
      request({ indexes: { projects: { orderby: ['name', 'decisionDate desc'] } } }), res);

    assert.deepStrictEqual(
      probes.filter(p => p.indexName === 'projects-live' && p.orderby).map(p => p.orderby),
      [['name asc', 'decisionDate desc']]);
  });

  // What `scripts/search-schema-probe.sh` posts: the tag's selects, and no order at all. The
  // orders have to keep coming from `buildOrderBy` — a probe body built from the index files'
  // `sortable` flags would order `documents` by `displayName`, which no query does, and a live
  // index that made that one unsortable would block a release it cannot affect.
  await t.test('a select-only override leaves the orders derived from the query builder', async (tt) => {
    const probes = stubProbe(tt);

    const { out, res } = capture();
    await searchSchema.searchSchema(
      request({ indexes: { documents: { select: ['id', 'fileSize'] } } }), res);

    assert.strictEqual(out.status, 200);
    const documents = probes.filter(p => p.indexName === 'documents-live');
    assert.deepStrictEqual(documents.filter(p => p.select).map(p => p.select), [['id', 'fileSize']]);

    const ordered = documents.filter(p => p.orderby).flatMap(p => p.orderby)
      .map(clause => clause.split(' ')[0]);
    assert.ok(ordered.includes('displayNameSort'));
    assert.ok(!ordered.includes('displayName'));
  });

  // The committed definition file, posted as it sits in the repo: every field it declares must
  // exist live. Its `sortable` flags are not turned into an order — see `overridesFrom`.
  await t.test('a committed index definition is accepted as the select', async (tt) => {
    const probes = stubProbe(tt);

    const { res } = capture();
    await searchSchema.searchSchema(request({
      indexes: {
        documents: {
          name: 'documents',
          fields: [
            { name: 'id', type: 'Edm.String' },
            { name: 'fileSize', type: 'Edm.Int64', sortable: true },
            { name: 'secretly', type: 'Edm.String', retrievable: false }
          ]
        }
      }
    }), res);

    const documents = probes.filter(p => p.indexName === 'documents-live');
    assert.deepStrictEqual(documents.map(p => p.select), [['id', 'fileSize']],
      'a non-retrievable field cannot be selected, and asking is a 400 that means nothing');
    assert.deepStrictEqual(documents.map(p => p.orderby), [undefined]);
  });

  // Silently ignoring an unknown key would answer 200 off the app's own selects, which is a green
  // gate for a workflow that thinks it probed the file it posted.
  await t.test('a body naming an index this app does not query is refused', async (tt) => {
    stubProbe(tt);

    const { out, res } = capture();
    await searchSchema.searchSchema(request({ indexes: { document: { select: ['id'] } } }), res);

    assert.strictEqual(out.status, 400);
    assert.match(out.body.error, /chunks, projects, documents/);
  });

  // The route is anonymous and the gateway has no per-caller throttle for an anonymous product
  // (azure/modules/apim.bicep:473), so a posted list is a request multiplier against the shared
  // search service: 32 orders per probe, three indexes, one curl. The bound is the only thing
  // between a 10 MB body and tens of thousands of sequential live queries.
  await t.test('an oversized orderby is refused before a single probe is issued', async (tt) => {
    const probes = stubProbe(tt);

    const { out, res } = capture();
    await searchSchema.searchSchema(request({
      indexes: { documents: { orderby: Array.from({ length: 200000 }, () => 'id') } }
    }), res);

    assert.strictEqual(out.status, 400);
    assert.strictEqual(out.body.error, 'schema override out of bounds');
    assert.strictEqual(probes.length, 0, 'nothing upstream is asked, not even the other indexes');
  });

  await t.test('the bound is a count, not a size: 65 names is already too many', async (tt) => {
    const probes = stubProbe(tt);

    const { out, res } = capture();
    await searchSchema.searchSchema(request({
      indexes: { documents: { select: Array.from({ length: 65 }, (_, i) => `field${i}`) } }
    }), res);

    assert.strictEqual(out.status, 400);
    assert.strictEqual(out.body.error, 'schema override out of bounds');
    assert.strictEqual(probes.length, 0);
  });

  // An entry is a field name, optionally with its direction. Anything else is not a question this
  // endpoint can ask, and a probe that carries it is a live query built from caller text.
  await t.test('an entry that is not a bare field name is refused', async (tt) => {
    const probes = stubProbe(tt);

    for (const entry of ['id desc, fileSize asc', 'search.score() desc', "id asc'", 'x'.repeat(65)]) {
      const { out, res } = capture();
      await searchSchema.searchSchema(request({ indexes: { documents: { orderby: [entry] } } }), res);

      assert.strictEqual(out.status, 400, `refused: ${entry}`);
      assert.strictEqual(out.body.error, 'schema override out of bounds');
    }
    assert.strictEqual(probes.length, 0);
  });

  // The bounds exist for the anonymous caller, not for CI: what the deploy workflow posts is every
  // committed definition, and they have to keep passing or the gate stops being runnable.
  await t.test('the committed index definitions still fit inside the bounds', async (tt) => {
    const probes = stubProbe(tt);

    const { out, res } = capture();
    await searchSchema.searchSchema(request({
      indexes: {
        chunks: require('../../azure/search/indexes/chunks.json'),
        projects: require('../../azure/search/indexes/projects.json'),
        documents: require('../../azure/search/indexes/documents.json'),
        activities: require('../../azure/search/indexes/activities.json'),
        'project-notifications': require('../../azure/search/indexes/project-notifications.json')
      }
    }), res);

    assert.strictEqual(out.status, 200);
    assert.strictEqual(probes.length, 5, 'one select probe per index, and no order to batch');
  });

  // The widest index emits 14 orders, so the app's own probe costs one call per index plus its
  // batches. The cap is what stops a body from turning the same route into an arbitrary number of
  // them: the longest override a caller may send is 64 entries, two batches, for each index.
  await t.test('the longest body a caller may send stays inside the probe cap', async (tt) => {
    const probes = stubProbe(tt);
    const orderby = Array.from({ length: 64 }, (_, i) => `field${i}`);

    const { out, res } = capture();
    await searchSchema.searchSchema(request({
      indexes: {
        chunks: { orderby },
        projects: { orderby },
        documents: { orderby },
        activities: { orderby },
        'project-notifications': { orderby }
      }
    }), res);

    assert.strictEqual(out.status, 200, '5 x (1 select + 2 order batches) = 15 is inside the cap');
    assert.strictEqual(probes.length, 15);
  });

  await t.test('no search endpoint is a 503, not a clean bill of health', async (tt) => {
    const probes = stubProbe(tt);
    const endpoint = process.env.SEARCH_ENDPOINT;
    delete process.env.SEARCH_ENDPOINT;
    tt.after(() => { process.env.SEARCH_ENDPOINT = endpoint; });

    const { out, res } = capture();
    await searchSchema.searchSchema(request(), res);

    assert.strictEqual(out.status, 503);
    assert.strictEqual(out.body.ok, false);
    assert.strictEqual(probes.length, 0, 'nothing was probed, so nothing may be reported as ok');
  });
});
