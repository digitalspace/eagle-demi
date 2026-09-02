'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const projects = require('../../src/repositories/projects');
const documents = require('../../src/repositories/documents');
const chunks = require('../../src/repositories/chunks');
const { TIER, systemAccess } = require('../../src/helpers/access-sql');

const PUBLIC = { tier: TIER.PUBLIC, roles: ['public'], projectScope: null };
const ADMIN = { tier: TIER.PRIVILEGED, roles: ['public', 'sysadmin'], projectScope: null };
const SCOPED = { tier: TIER.SCOPED, roles: ['public', 'project-team'], projectScope: ['207'] };
const COMPLIANCE = { tier: TIER.PUBLIC, roles: ['public', 'compliance'], projectScope: null };

/**
 * Capture the spec and options a repository hands to the data layer.
 *
 * Both entry points are mocked: queryValue() calls the module-internal query() reference
 * rather than the export, so mocking query() alone would miss every count.
 */
function captureQuery(t) {
  const calls = [];
  const record = (container, spec, options = {}) => {
    // Run the real validator so a malformed spec fails the test rather than passing silently.
    cosmos.assertQuerySpec(spec, container);
    calls.push({ container, spec, options });
  };

  t.mock.method(cosmos, 'query', async (container, spec, options = {}) => {
    record(container, spec, options);
    return { items: [], continuationToken: undefined, requestCharge: 0 };
  });
  // Returns 1, not 0: a count of zero can short-circuit a caller before it emits the query the
  // test is asserting on. No test asserts on the scalar itself.
  t.mock.method(cosmos, 'queryValue', async (container, spec, options = {}) => {
    record(container, spec, options);
    return 1;
  });
  return calls;
}

test('projects repository', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('anonymous list applies the ACL predicate and never a bare SELECT', async () => {
    const calls = captureQuery(t);
    await projects.listVisible(PUBLIC, {});

    const { spec } = calls[0];
    // A catalog projection, not `*` — PUBLIC carries no level, which is the anonymous one.
    assert.match(spec.query, /^SELECT c\.\w+(, c\.\w+)* FROM c WHERE /);
    assert.match(spec.query, /EXISTS\(SELECT VALUE r FROM r IN c\.read/);
    assert.ok(spec.parameters.some(p => p.value === 'public'));
  });

  await t.test('listVisible projects through selectFor', async () => {
    // The projection is level-driven: a sysadmin reads the whole row, and every other caller gets
    // the catalog's ceiling for their level. Asserted on the SPEC because the narrowing happens in
    // Cosmos, where no response assertion can see it.
    const calls = captureQuery(t);
    await projects.listVisible({ ...PUBLIC, level: 4 }, {});
    await projects.listVisible(systemAccess(), {});

    assert.match(calls[0].spec.query, /^SELECT c\./, 'an anonymous read projects named fields');
    assert.ok(!calls[0].spec.query.includes('c._etag'),
      'the concurrency token has maxVis 2 and must not leave Cosmos for an anonymous caller');
    assert.match(calls[1].spec.query, /^SELECT \* FROM c WHERE /, 'level 0 reads the whole row');
  });

  await t.test('privileged list is unrestricted but for the sealed compartment', async () => {
    const calls = captureQuery(t);
    await projects.listVisible(ADMIN, {});
    assert.match(calls[0].spec.query, /WHERE \(\(NOT ARRAY_CONTAINS\(c\.read, 'compliance'\)\)\)/);
    assert.ok(!/EXISTS/.test(calls[0].spec.query), 'the role predicate is still lifted');
  });

  await t.test('scoped list restricts to the caller partitions, keeping the ACL', async () => {
    const calls = captureQuery(t);
    await projects.listVisible(SCOPED, {});

    const { spec } = calls[0];
    assert.match(spec.query, /EXISTS/, 'role ACL must still apply');
    assert.match(spec.query, /c\.id IN \(@scope0\)/, 'partition restriction must apply');
    assert.ok(spec.parameters.some(p => p.value === '207'));
  });

  await t.test('list criteria carry no provenance predicate', async () => {
    const calls = captureQuery(t);
    await projects.listVisible(PUBLIC, { trackOnly: true, municipality: 'Vancouver' });

    // The PREDICATE, not the whole statement: `c.sourceSystem` is a catalogued field, so the
    // level projection names it in the SELECT list without filtering on it.
    const where = calls[0].spec.query.split(' WHERE ')[1];
    assert.ok(!where.includes('sourceSystem'),
      'a public project read is scoped by the ACL, never by which system wrote the row');
    const { spec } = calls[0];
    assert.match(spec.query, /c\.municipality = @muni/, 'the real criteria still build');
  });

  await t.test('filter values are bound, never interpolated', async () => {
    const calls = captureQuery(t);
    await projects.listVisible(PUBLIC, { regionalDistrict: "'; DROP--" });

    const { spec } = calls[0];
    assert.ok(!spec.query.includes('DROP'), 'caller input must not reach the SQL text');
    assert.ok(spec.parameters.some(p => p.value === "'; DROP--"));
  });

  await t.test('count uses the IDENTICAL predicate as the list', async () => {
    const calls = captureQuery(t);
    await projects.listVisible(PUBLIC, { municipality: 'Vancouver' });
    await projects.countVisible(PUBLIC, { municipality: 'Vancouver' });

    const listWhere = calls[0].spec.query.split(' WHERE ')[1].split(' ORDER BY ')[0];
    const countWhere = calls[1].spec.query.split(' WHERE ')[1];
    assert.strictEqual(countWhere, listWhere,
      'a count built from a different filter leaks the size of an unreadable set');
    assert.match(calls[1].spec.query, /SELECT VALUE COUNT\(1\)/);
  });

  await t.test('ORDER BY targets an indexed path', async () => {
    const calls = captureQuery(t);
    await projects.listVisible(PUBLIC, {});
    // /name is in the container indexing policy. Cosmos rejects an ORDER BY on an unindexed
    // path outright rather than degrading, so this must stay in step with the Bicep.
    assert.match(calls[0].spec.query, /ORDER BY c\.name ASC$/);
  });

  await t.test('countWithCentroid uses the IDENTICAL predicate as listWithCentroid', async () => {
    const calls = captureQuery(t);
    await projects.listWithCentroid(PUBLIC);
    await projects.countWithCentroid(PUBLIC);

    assert.strictEqual(calls[1].spec.query.split(' WHERE ')[1], calls[0].spec.query.split(' WHERE ')[1]);
    assert.match(calls[1].spec.query, /SELECT VALUE COUNT\(1\)/);
  });

  await t.test('getById gates the point read', async () => {
    t.mock.method(cosmos, 'readItem', async () => ({
      id: '207', read: ['sysadmin'], isPublished: false
    }));
    assert.strictEqual(await projects.getById(PUBLIC, '207'), null,
      'a point read must not return what a list would hide');
    assert.ok(await projects.getById(ADMIN, '207'));
  });
});

test('documents repository', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a project filter scopes the query to one partition', async () => {
    const calls = captureQuery(t);
    await documents.listVisible(PUBLIC, { projectId: '207' });

    const { spec, options } = calls[0];
    assert.match(spec.query, /c\.projectId = @projectId/);
    assert.strictEqual(options.partitionKey, '207',
      'the dominant list should be single-partition');
  });

  await t.test('listVisible projects through selectFor', async () => {
    const calls = captureQuery(t);
    await documents.listVisible({ ...PUBLIC, level: 4 }, {});
    await documents.listVisible(systemAccess(), {});

    assert.match(calls[0].spec.query, /^SELECT c\./, 'an anonymous read projects named fields');
    assert.ok(!calls[0].spec.query.includes('c.s3Key'),
      'the object key has maxVis 0 and must not leave Cosmos');
    assert.match(calls[1].spec.query, /^SELECT \* FROM c WHERE /, 'level 0 reads the whole row');
  });

  // The search controller pages this list by re-running it and slicing. WITHOUT an ORDER BY the
  // SQL API guarantees no order at all, so two requests can return the same row twice and never
  // return another — the same failure DEFAULT_ORDER prevents on the AI Search side. `c.id` because
  // it is the one path always present and always indexed: a single-property ORDER BY DROPS rows
  // that lack the property, so sorting on a display field would hide untitled documents.
  await t.test('the list has a deterministic order, or paging repeats and omits rows', async () => {
    const calls = captureQuery(t);
    await documents.listVisible(PUBLIC, {});
    assert.match(calls[0].spec.query, /ORDER BY c\.id ASC$/);
  });

  // `project=a,b` is one request naming two projects. Dropping the extra ids would answer the whole
  // corpus to a request that named two — the same failure as forgetting the filter entirely.
  await t.test('two projects become an IN clause, not a dropped filter', async () => {
    const calls = captureQuery(t);
    await documents.listVisible(PUBLIC, { projectId: ['207', '208'] });

    const { spec, options } = calls[0];
    assert.match(spec.query, /c\.projectId IN \(@projectId0, @projectId1\)/);
    assert.deepStrictEqual(
      spec.parameters.filter(p => p.name.startsWith('@projectId')).map(p => p.value),
      ['207', '208']
    );
    assert.strictEqual(options.partitionKey, undefined,
      'two projects are two partitions — this one cannot be pinned');
  });

  // The count has to carry the same scope as the read, or one project's document list reports the
  // size of the corpus.
  await t.test('the count is built from the same project scope as the read', async () => {
    const calls = captureQuery(t);
    await documents.countVisible(PUBLIC, { projectId: ['207'] });

    assert.match(calls[0].spec.query, /SELECT VALUE COUNT\(1\)/);
    assert.match(calls[0].spec.query, /c\.projectId = @projectId/);
    assert.strictEqual(calls[0].options.partitionKey, '207');
  });

  await t.test('without a project it stays cross-partition but still ACL-filtered', async () => {
    const calls = captureQuery(t);
    await documents.listVisible(PUBLIC, {});
    assert.strictEqual(calls[0].options.partitionKey, undefined);
    assert.match(calls[0].spec.query, /EXISTS/);
  });

  await t.test("projectId '' selects the unlinked partition here too", async () => {
    // Nothing passes `''` to documents
    // today; this test is what keeps a falsy check from creeping back before something does, at
    // which point "the unlinked partition" would silently mean "every document".
    const calls = captureQuery(t);
    await documents.listVisible(ADMIN, { projectId: '' });

    assert.match(calls[0].spec.query, /c\.projectId = @projectId/);
    assert.deepStrictEqual(
      calls[0].spec.parameters.filter(p => p.name === '@projectId'),
      [{ name: '@projectId', value: '' }]
    );
    assert.strictEqual(calls[0].options.partitionKey, '');
  });

  await t.test('extracted:false emits an equality, not a $ne translation', async () => {
    const calls = captureQuery(t);
    await documents.listVisible(ADMIN, { extracted: false });
    // Mongo's {$ne: true} matches missing fields; SQL `!= true` excludes them. Translating
    // naively here would silently skip every document. Defaults-on-write make it an equality.
    assert.match(calls[0].spec.query, /c\.contentExtracted = @extracted/);
    assert.ok(!calls[0].spec.query.includes('!='));
  });

  // A successful extraction writes the field back as an explicit null, so IS_DEFINED alone would
  // count every document ever extracted as a failure.
  await t.test('extractionError:true excludes the null the success path writes', async () => {
    const calls = captureQuery(t);
    await documents.countVisible(ADMIN, { extractionError: true });

    assert.match(calls[0].spec.query, /SELECT VALUE COUNT\(1\)/);
    assert.match(calls[0].spec.query,
      /IS_DEFINED\(c\.contentExtractionError\) AND NOT IS_NULL\(c\.contentExtractionError\)/);
  });

  await t.test('a junk, zero or negative pageSize still caps maxItemCount', async () => {
    // Without maxItemCount cosmos.query takes the fetchAll() branch and drains the whole
    // container cross-partition — reachable anonymously via /api/search?pageSize=0.
    for (const pageSize of [NaN, 0, -5, 'abc', 99999]) {
      const calls = captureQuery(t);
      await documents.listVisible(PUBLIC, { pageSize });
      const { maxItemCount } = calls[0].options;
      assert.ok(maxItemCount >= 1 && maxItemCount <= 1000,
        `pageSize ${String(pageSize)} gave maxItemCount ${String(maxItemCount)}`);
      t.mock.restoreAll();
    }
  });

  await t.test('no pageSize at all still means fetchAll, as countVisible relies on', async () => {
    const calls = captureQuery(t);
    await documents.listVisible(PUBLIC, {});
    assert.strictEqual(calls[0].options.maxItemCount, undefined);
  });

  await t.test('getById without a project id filters in the query, not after', async () => {
    const calls = captureQuery(t);
    await documents.getById(PUBLIC, 'doc1');
    assert.match(calls[0].spec.query, /EXISTS/,
      'an unreadable document must never reach this process');
  });

  // `listSealed` is mocked at its only call site, so the SQL it emits is invisible to every
  // controller test: without this, dropping its criterion turns GET /api/sealed into a projected
  // list of every document the caller can see, with the whole suite green.
  await t.test('listSealed narrows to level 0 ON TOP OF the visibility predicate', async () => {
    const calls = captureQuery(t);
    await documents.listSealed({ ...COMPLIANCE, compartment: true }, {});

    const { spec } = calls[0];
    assert.match(spec.query, /ARRAY_CONTAINS\(c\.read, 'compliance'\)/,
      'the criterion is what makes this the sealed list rather than a document list');
    assert.match(spec.query, /EXISTS\(SELECT VALUE r FROM r IN c\.read/,
      'the ACL predicate composes first — the criterion narrows, it never replaces');
    assert.ok(spec.parameters.some(p => p.value === 'compliance'),
      'the caller\'s own role is bound in, not assumed');
    assert.ok(!spec.query.includes('NOT ARRAY_CONTAINS'),
      'a compartment read is the one read that lifts the exclusion');
  });

  await t.test('listSealed answers a caller outside the compartment with nothing', async () => {
    const calls = captureQuery(t);
    // Both halves of the seal: the role without the compartment flag, and the flag without the
    // role. Each keeps the exclusion, which contradicts the criterion — the query matches nothing.
    await documents.listSealed(COMPLIANCE, {});
    await documents.listSealed({ ...ADMIN, compartment: true }, {});

    for (const { spec } of calls) {
      assert.match(spec.query, /NOT ARRAY_CONTAINS\(c\.read, 'compliance'\)/);
      assert.match(spec.query, /ARRAY_CONTAINS\(c\.read, 'compliance'\)/);
    }
  });
});

test('chunks repository', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('anonymous list applies the ACL predicate', async () => {
    const calls = captureQuery(t);
    await chunks.listVisible(PUBLIC, {});

    const { spec, container } = calls[0];
    // One container for chunks. `chunks_fts` existed briefly for Cosmos full-text search and is
    // gone; this constant addresses every chunk WRITE too, so a wrong value splits the corpus.
    assert.strictEqual(container, 'chunks');
    assert.match(spec.query, /^SELECT \* FROM c WHERE /);
    assert.match(spec.query, /EXISTS\(SELECT VALUE r FROM r IN c\.read/);
  });

  await t.test('privileged list is the whole-corpus read source, bar the sealed compartment', async () => {
    const calls = captureQuery(t);
    await chunks.listVisible(ADMIN, {});
    assert.match(calls[0].spec.query, /WHERE \(\(NOT ARRAY_CONTAINS\(c\.read, 'compliance'\)\)\)/);
    assert.ok(!/EXISTS/.test(calls[0].spec.query), 'the role predicate is still lifted');
  });

  // THE regression test for this repository. `chunks` is the only container whose partition key
  // is not the project, and visibilityFor() uses its argument for BOTH the partition key and the
  // project-scope field. Scoping on 'documentId' would compare PROJECT ids against DOCUMENT ids
  // and silently match nothing — invisible today because only systemAccess() reads chunks.
  await t.test('scoped callers are restricted on projectId, NEVER on documentId', async () => {
    const calls = captureQuery(t);
    await chunks.listVisible(SCOPED, {});

    const { spec } = calls[0];
    assert.match(spec.query, /c\.projectId IN \(/, 'scope must ride projectId');
    assert.ok(!/c\.documentId IN \(/.test(spec.query),
      'scope must NOT be applied to the partition key');
    assert.ok(spec.parameters.some(p => p.value === '207'));
  });

  await t.test('a documentId filter is bound and becomes a single-partition read', async () => {
    const calls = captureQuery(t);
    await chunks.listVisible(ADMIN, { documentId: 'd1' });

    const { spec, options } = calls[0];
    assert.match(spec.query, /c\.documentId = @documentId/);
    assert.ok(spec.parameters.some(p => p.name === '@documentId' && p.value === 'd1'));
    assert.strictEqual(options.partitionKey, 'd1', 'must target the documentId partition');
  });

  await t.test('a hostile documentId is bound, never interpolated', async () => {
    const calls = captureQuery(t);
    await chunks.listVisible(ADMIN, { documentId: "x' OR 1=1 --" });
    assert.ok(!calls[0].spec.query.includes('OR 1=1'));
  });

  await t.test('chunkId is deterministic, so re-extraction upserts instead of duplicating', () => {
    assert.strictEqual(chunks.chunkId('d1', 3, 7), 'd1::p3::c7');
    assert.strictEqual(chunks.chunkId('d1', 3, 7), chunks.chunkId('d1', 3, 7));
    assert.notStrictEqual(chunks.chunkId('d1', 3, 7), chunks.chunkId('d1', 3, 8));
  });

  await t.test('replaceForDocument upserts new chunks and deletes only the surplus', async (tt) => {
    tt.mock.method(cosmos, 'query', async () => ({
      items: ['d1::p0::c0', 'd1::p0::c1', 'd1::p0::c2'], continuationToken: undefined
    }));
    let ops = null;
    tt.mock.method(cosmos, 'bulkVerified', async (container, operations) => {
      ops = operations;
      return { succeeded: operations.length, failed: 0, statusCounts: {} };
    });
    // bulk does not throw on partial failure — using it here is the bug that reported 60,578
    // writes when 56,317 landed.
    tt.mock.method(cosmos, 'bulk', async () => assert.fail('must use bulkVerified, not bulk'));

    await chunks.replaceForDocument(ADMIN, 'd1', [
      { id: 'd1::p0::c0', documentId: 'd1', projectId: '207', content: 'a', read: ['public'] },
      { id: 'd1::p0::c1', documentId: 'd1', projectId: '207', content: 'b', read: ['public'] }
    ]);

    const upserts = ops.filter(o => o.operationType === 'Upsert');
    const deletes = ops.filter(o => o.operationType === 'Delete');
    assert.strictEqual(upserts.length, 2);
    assert.deepStrictEqual(deletes.map(d => d.id), ['d1::p0::c2'], 'only the surplus is removed');
    assert.ok(ops.every(o => o.partitionKey === 'd1'), 'one partition, so one bulk request');
  });

  await t.test('a chunk with no read[] is refused — it would fall back to isPublished', async (tt) => {
    tt.mock.method(cosmos, 'query', async () => ({ items: [], continuationToken: undefined }));
    await assert.rejects(
      () => chunks.replaceForDocument(ADMIN, 'd1', [
        { id: 'd1::p0::c0', documentId: 'd1', projectId: '207', content: 'a', read: [] }
      ]),
      /non-empty read/
    );
  });

  await t.test('removeForDocument deletes every chunk of the document', async (tt) => {
    tt.mock.method(cosmos, 'query', async () => ({
      items: ['d1::p0::c0', 'd1::p0::c1'], continuationToken: undefined
    }));
    let ops = null;
    tt.mock.method(cosmos, 'bulkVerified', async (container, operations) => {
      ops = operations;
      return { succeeded: operations.length, failed: 0, statusCounts: {} };
    });

    await chunks.removeForDocument(ADMIN, 'd1');
    assert.strictEqual(ops.length, 2);
    assert.ok(ops.every(o => o.operationType === 'Delete' && o.partitionKey === 'd1'));
  });
});

test('fetchAll and the reconcile/extraction reads it backs', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const SYSTEM = systemAccess();

  /** Mock cosmos.query with a fixed list of pages, recording every call. */
  const paged = (t, pages) => {
    const calls = [];
    let n = 0;
    t.mock.method(cosmos, 'query', async (container, spec, options = {}) => {
      cosmos.assertQuerySpec(spec, container);
      calls.push({ container, spec, options });
      return pages[n++] || { items: [], continuationToken: undefined };
    });
    return calls;
  };

  await t.test('a continuation token is followed and every page is returned', async () => {
    // Without this the reconcile set stops at the 1000-row page cap and everything past it is
    // computed as surplus — 60k documents deleted off a partial read.
    const calls = paged(t, [
      { items: [{ id: 'a' }, { id: 'b' }], continuationToken: 'page2' },
      { items: [{ id: 'c' }], continuationToken: undefined }
    ]);

    const rows = await documents.listSeededIds(SYSTEM);

    assert.deepStrictEqual(rows.map(r => r.id), ['a', 'b', 'c']);
    assert.strictEqual(calls.length, 2, 'the loop must issue a second request');
    assert.strictEqual(calls[0].options.continuationToken, undefined);
    assert.strictEqual(calls[1].options.continuationToken, 'page2',
      'the second request must carry the token the first returned');
    // maxItemCount must stay ABSENT: setting it makes cosmos.query page by hand, and the SDK
    // drops `x-ms-continuation` on a cross-partition query, which is how the 2026-08-25 run read
    // 1,000 of 60,578 documents and computed the rest as surplus.
    assert.ok(calls.every(c => c.options.maxItemCount === undefined));
  });

  await t.test('extractionRowsForProject pins the partition and selects only the state', async () => {
    const calls = paged(t, [{ items: [], continuationToken: undefined }]);
    await documents.extractionRowsForProject(SYSTEM, 207);

    const { spec, options } = calls[0];
    assert.strictEqual(options.partitionKey, '207',
      'a cross-partition drain per project would scan the whole container');
    assert.match(spec.query, /c\.projectId = @projectId/);
    // Exactly id + the four extraction fields: a wider projection reads 60k whole documents back.
    assert.strictEqual(spec.query.split(' FROM ')[0].replace('SELECT ', ''),
      ['c.id', ...documents.EXTRACTION_FIELDS.map(f => `c.${f}`)].join(', '));
    assert.ok(spec.parameters.some(p => p.name === '@projectId' && p.value === '207'));
  });

  await t.test('listSeededIds is scoped to sourceSystem eagle', async () => {
    // The SOLE guard against reconcile deleting an epic.submit upload, which this seed never
    // produces and so would compute as surplus every run.
    const calls = paged(t, [{ items: [], continuationToken: undefined }]);
    await documents.listSeededIds(SYSTEM);

    const { spec } = calls[0];
    assert.match(spec.query, /c\.sourceSystem = @sourceSystem/);
    assert.ok(spec.parameters.some(p => p.name === '@sourceSystem' && p.value === 'eagle'));
    assert.match(spec.query, /^SELECT c\.id, c\.projectId FROM c/);
    // A cross-partition ORDER BY takes the SDK's query-plan path, which never copies
    // `x-ms-continuation` into the merged headers — fetchAll then stops at the first page.
    assert.doesNotMatch(spec.query, /ORDER BY/,
      'the 2026-08-25 run enumerated 1,000 of 60,578 documents with the sort in place');
  });

  await t.test('listEagleOnlyIds is scoped to sourceSystem eagle', async () => {
    // Track-sourced rows exist whether or not Eagle still carries a counterpart; without this
    // the reconcile deletes the master registry.
    const calls = paged(t, [{ items: [], continuationToken: undefined }]);
    await projects.listEagleOnlyIds(SYSTEM);

    const { spec } = calls[0];
    assert.match(spec.query, /c\.sourceSystem = @sourceSystem/);
    assert.ok(spec.parameters.some(p => p.name === '@sourceSystem' && p.value === 'eagle'));
    assert.match(spec.query, /^SELECT c\.id, c\.eagleId FROM c/);
    assert.doesNotMatch(spec.query, /ORDER BY/, 'same continuation-token drop as listSeededIds');
  });

  await t.test('listWithEagleId spans every source system, not just eagle', async () => {
    // WIDER than listEagleOnlyIds on purpose: the merge writes `eagleId` onto Track-sourced rows
    // too, so a membership test over the Eagle-sourced rows alone reports every matched project
    // as missing from DEMI. `sourceSystem` is projected because only the Eagle-sourced rows are
    // the push's to answer for.
    const calls = paged(t, [{ items: [], continuationToken: undefined }]);
    await projects.listWithEagleId(SYSTEM);

    const { spec } = calls[0];
    assert.match(spec.query, /^SELECT c\.id, c\.eagleId, c\.sourceSystem FROM c/);
    assert.match(spec.query, /IS_DEFINED\(c\.eagleId\) AND NOT IS_NULL\(c\.eagleId\)/);
    assert.doesNotMatch(spec.query, /c\.sourceSystem = /,
      'filtering by sourceSystem here reports ~350 matched projects as missing from DEMI');
    assert.doesNotMatch(spec.query, /ORDER BY/, 'same continuation-token drop as listSeededIds');
  });

  await t.test('countWithEagleId shares the listWithEagleId predicate exactly', async () => {
    const calls = captureQuery(t);
    await projects.listWithEagleId(SYSTEM);
    await projects.countWithEagleId(SYSTEM);

    const where = q => q.split(' WHERE ')[1];
    assert.strictEqual(where(calls[1].spec.query), where(calls[0].spec.query));
    assert.match(calls[1].spec.query, /^SELECT VALUE COUNT\(1\) FROM c/);
    assert.deepStrictEqual(calls[1].spec.parameters, calls[0].spec.parameters);
  });

  await t.test('the reconcile COUNTs share the enumeration predicate exactly', async () => {
    // The seeder's truncation guard is only meaningful if the COUNT and the read filter
    // identically: a wider COUNT refuses every run, a narrower one never catches a short read.
    const calls = captureQuery(t);
    await documents.listSeededIds(SYSTEM);
    await documents.countSeededIds(SYSTEM);
    await projects.listEagleOnlyIds(SYSTEM);
    await projects.countEagleOnlyIds(SYSTEM);

    const where = q => q.split(' WHERE ')[1];
    assert.strictEqual(where(calls[1].spec.query), where(calls[0].spec.query));
    assert.strictEqual(where(calls[3].spec.query), where(calls[2].spec.query));
    assert.match(calls[1].spec.query, /^SELECT VALUE COUNT\(1\) FROM c/);
    assert.match(calls[3].spec.query, /^SELECT VALUE COUNT\(1\) FROM c/);
  });
});
