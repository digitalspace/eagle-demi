'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const controller = require('../../src/controllers/project-summary');
const projectsRepo = require('../../src/repositories/projects');
const summariesRepo = require('../../src/repositories/projectSummaries');
const config = require('../../src/config');

const RECORD = {
  id: '272', projectId: '272', generatedAt: '2026-09-09T02:00:00Z',
  // The generator's assertion that every cited document was public. Without it the project gate
  // would not be enough, so the write route refuses a record that omits it.
  sourceAccess: 'public',
  model: 'gpt-4.1-mini', pricedAs: 'gpt-4.1-mini', estimatedCostCad: 0.08,
  facts: { documentTotal: 2158 },
  sections: { status: { sentence: 'A sentence.', citations: [1] } },
  citations: [{ n: 1, chunkId: 'docB::p2::c0', documentId: 'docB', pageNumber: 2 }]
};

function mockRes() {
  const res = {
    body: null,
    statusCode: 200,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; }
  };
  return res;
}

const req = (id, body) => ({ params: { id }, query: {}, body });

test('GET /projects/:id/summary', async (t) => {
  const originalEnabled = config.summaryEnabled;
  t.afterEach(() => { config.summaryEnabled = originalEnabled; });

  await t.test('404s when the caller cannot read the project', async () => {
    // The record carries no ACL of its own. The project read under the CALLER's access is the whole
    // gate, so a caller who 404s on `GET /projects/:id` must 404 here — otherwise a private
    // project's summary is readable by anyone with a staff token.
    config.summaryEnabled = true;
    t.mock.method(projectsRepo, 'getById', async () => null);
    let summaryReads = 0;
    t.mock.method(summariesRepo, 'getById', async () => { summaryReads++; return RECORD; });

    const res = mockRes();
    await controller.getProjectSummary(req('272'), res);

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(summaryReads, 0, 'the record is not even read for a project it cannot see');
  });

  await t.test('404s with no_summary when the project has no stored record', async () => {
    // A distinct body from "project not found": the page renders facts either way, but only one of
    // the two means "run the generator".
    config.summaryEnabled = true;
    t.mock.method(projectsRepo, 'getById', async () => ({ id: '272', name: 'Site C' }));
    t.mock.method(summariesRepo, 'getById', async () => null);

    const res = mockRes();
    await controller.getProjectSummary(req('272'), res);

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.error, 'no_summary');
  });

  await t.test('reports the feature flag rather than a missing record', async () => {
    config.summaryEnabled = false;
    const res = mockRes();
    await controller.getProjectSummary(req('272'), res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { summary: null, reason: 'disabled' });
  });

  await t.test('returns the stored record unchanged', async () => {
    config.summaryEnabled = true;
    t.mock.method(projectsRepo, 'getById', async () => ({ id: '272', name: 'Site C' }));
    t.mock.method(summariesRepo, 'getById', async () => RECORD);

    const res = mockRes();
    await controller.getProjectSummary(req('272'), res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, RECORD);
  });

  await t.test('withholds a record that does not assert public sources', async () => {
    // Records written before the generator filtered its sources are already in the container. The
    // write gate cannot reach them, and the project gate alone would serve prose about a document
    // this caller may not read, so the read side checks the same claim.
    config.summaryEnabled = true;
    t.mock.method(projectsRepo, 'getById', async () => ({ id: '272', name: 'Site C' }));
    const { sourceAccess, ...stale } = RECORD;
    t.mock.method(summariesRepo, 'getById', async () => stale);

    const res = mockRes();
    await controller.getProjectSummary(req('272'), res);

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.error, 'no_summary');
    assert.strictEqual(sourceAccess, 'public', 'the field the stale record is missing');
  });

  await t.test('looks the record up by the DEMI id, not the id in the URL', async () => {
    // eagle-public holds Eagle ObjectIds; the record is stored under the DEMI project id. Keying on
    // the URL id would 404 every request that arrived through an Eagle id.
    config.summaryEnabled = true;
    t.mock.method(projectsRepo, 'getByEagleId', async () => ({ id: '272', name: 'Site C' }));
    let lookedUp = null;
    t.mock.method(summariesRepo, 'getById', async (id) => { lookedUp = id; return RECORD; });

    await controller.getProjectSummary(req('588511a0aaecd9001b82316d'), mockRes());

    assert.strictEqual(lookedUp, '272');
  });
});

test('PUT /projects/:id/summary', async (t) => {
  await t.test('404s when the caller cannot read the project', async () => {
    t.mock.method(projectsRepo, 'getById', async () => null);
    let writes = 0;
    t.mock.method(summariesRepo, 'upsert', async (r) => { writes++; return r; });

    const res = mockRes();
    await controller.putProjectSummary(req('272', RECORD), res);

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(writes, 0);
  });

  await t.test('400s a body that is not a summary record', async () => {
    t.mock.method(projectsRepo, 'getById', async () => ({ id: '272' }));
    let writes = 0;
    t.mock.method(summariesRepo, 'upsert', async (r) => { writes++; return r; });

    const res = mockRes();
    await controller.putProjectSummary(req('272', { sections: {}, citations: [] }), res);

    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /generatedAt/);
    assert.strictEqual(writes, 0);
  });

  await t.test('400s a record that does not assert public sources', async () => {
    // The record is read back under the PROJECT's ACL alone. A record that does not say every
    // document it cites was public has no gate of its own, so it is refused rather than stored and
    // served to a caller who cannot read those documents.
    t.mock.method(projectsRepo, 'getById', async () => ({ id: '272' }));
    let writes = 0;
    t.mock.method(summariesRepo, 'upsert', async (r) => { writes++; return r; });

    for (const sourceAccess of [undefined, 'staff', true]) {
      const res = mockRes();
      await controller.putProjectSummary(req('272', { ...RECORD, sourceAccess }), res);

      assert.strictEqual(res.statusCode, 400, `sourceAccess ${JSON.stringify(sourceAccess)}`);
      assert.match(res.body.error, /sourceAccess/);
    }
    assert.strictEqual(writes, 0);
  });

  await t.test('400s a body whose citations are not a list', async () => {
    t.mock.method(projectsRepo, 'getById', async () => ({ id: '272' }));
    const res = mockRes();
    await controller.putProjectSummary(
      req('272', { ...RECORD, citations: 'one' }), res);

    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /citations/);
  });

  await t.test('400s a body citing a source its own citation list does not hold', async () => {
    // A section citing source 2 of a one-entry list renders as a footnote link to nothing, and it
    // is what a half-finished or stale generator run writes. Both sides of the check are in the
    // body, which is why this one belongs here and the grounding checks do not.
    t.mock.method(projectsRepo, 'getById', async () => ({ id: '272' }));
    let writes = 0;
    t.mock.method(summariesRepo, 'upsert', async (r) => { writes++; return r; });

    const res = mockRes();
    await controller.putProjectSummary(req('272', {
      ...RECORD,
      sections: { conditions: { items: [{ title: 'Water quality', citations: [1, 2] }] } }
    }), res);

    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /outside 1\.\.1/);
    assert.strictEqual(writes, 0);
  });

  await t.test('stores under the resolved project, never the id the body claims', async () => {
    // Otherwise a body naming project 999 would be written into that project's partition through
    // project 272's ACL check.
    t.mock.method(projectsRepo, 'getById', async () => ({ id: '272' }));
    let stored = null;
    t.mock.method(summariesRepo, 'upsert', async (record) => { stored = record; return record; });

    const res = mockRes();
    await controller.putProjectSummary(
      req('272', { ...RECORD, id: '999', projectId: '999' }), res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(stored.id, '272');
    assert.strictEqual(stored.projectId, '272');
  });
});
