'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const projects = require('../../src/repositories/projects');
const documents = require('../../src/repositories/documents');
const records = require('../../src/repositories/records');
const fragments = require('../../src/repositories/fragments');
const chunks = require('../../src/repositories/chunks');
const { TIER } = require('../../src/helpers/access-sql');

const PUBLIC = { tier: TIER.PUBLIC, roles: ['public'], projectScope: null };
const ADMIN = { tier: TIER.PRIVILEGED, roles: ['public', 'sysadmin'], projectScope: null };
const SCOPED = { tier: TIER.SCOPED, roles: ['public', 'project-team'], projectScope: ['207'] };

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
  // Returns 1, not 0: chunk search now runs a COUNT pre-flight and short-circuits on zero, so a
  // 0 here would stop every ranked query before it was ever emitted and the SQL assertions below
  // would silently assert nothing. No test asserts on the scalar itself.
  t.mock.method(cosmos, 'queryValue', async (container, spec, options = {}) => {
    record(container, spec, options);
    return 1;
  });
  // Ranked reads go through their own entry point — mocking query() alone would miss every
  // chunk search and the test would assert nothing.
  t.mock.method(cosmos, 'queryRanked', async (container, spec, options = {}) => {
    record(container, spec, options);
    return { items: [], requestCharge: 0, pages: 1, truncated: false };
  });

  return calls;
}

test('projects repository', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('anonymous list applies the ACL predicate and never a bare SELECT', async () => {
    const calls = captureQuery(t);
    await projects.listVisible(PUBLIC, {});

    const { spec } = calls[0];
    assert.match(spec.query, /^SELECT \* FROM c WHERE /);
    assert.match(spec.query, /EXISTS\(SELECT VALUE r FROM r IN c\.read/);
    assert.ok(spec.parameters.some(p => p.value === 'public'));
  });

  await t.test('privileged list is unrestricted but still well-formed', async () => {
    const calls = captureQuery(t);
    await projects.listVisible(ADMIN, {});
    assert.match(calls[0].spec.query, /WHERE true/);
  });

  await t.test('scoped list restricts to the caller partitions, keeping the ACL', async () => {
    const calls = captureQuery(t);
    await projects.listVisible(SCOPED, {});

    const { spec } = calls[0];
    assert.match(spec.query, /EXISTS/, 'role ACL must still apply');
    assert.match(spec.query, /c\.id IN \(@scope0\)/, 'partition restriction must apply');
    assert.ok(spec.parameters.some(p => p.value === '207'));
  });

  await t.test('trackOnly uses an indexed equality, not an EXISTS/!=null test', async () => {
    const calls = captureQuery(t);
    await projects.listVisible(PUBLIC, { trackOnly: true });

    const { spec } = calls[0];
    assert.match(spec.query, /c\.sourceSystem = @sourceSystem/);
    assert.ok(!spec.query.includes('sources.track'),
      'the old $exists/$ne provenance test should be gone');
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
    await projects.listVisible(PUBLIC, { trackOnly: true, municipality: 'Vancouver' });
    await projects.countVisible(PUBLIC, { trackOnly: true, municipality: 'Vancouver' });

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

  await t.test('without a project it stays cross-partition but still ACL-filtered', async () => {
    const calls = captureQuery(t);
    await documents.listVisible(PUBLIC, {});
    assert.strictEqual(calls[0].options.partitionKey, undefined);
    assert.match(calls[0].spec.query, /EXISTS/);
  });

  await t.test('extracted:false emits an equality, not a $ne translation', async () => {
    const calls = captureQuery(t);
    await documents.listVisible(ADMIN, { extracted: false });
    // Mongo's {$ne: true} matches missing fields; SQL `!= true` excludes them. Translating
    // naively here would silently skip every document. Defaults-on-write make it an equality.
    assert.match(calls[0].spec.query, /c\.contentExtracted = @extracted/);
    assert.ok(!calls[0].spec.query.includes('!='));
  });

  await t.test('getById without a project id filters in the query, not after', async () => {
    const calls = captureQuery(t);
    await documents.getById(PUBLIC, 'doc1');
    assert.match(calls[0].spec.query, /EXISTS/,
      'an unreadable document must never reach this process');
  });
});

test('records repository', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('project name search uses CONTAINS, not a regex', async () => {
    const calls = captureQuery(t);
    await records.listVisible(PUBLIC, { projectName: 'Site C' });
    assert.match(calls[0].spec.query, /CONTAINS\(c\.projectName, @projectName, true\)/);
    assert.ok(!calls[0].spec.query.includes('RegexMatch'),
      'caller input must not become a pattern — no ReDoS surface');
  });

  await t.test('count matches the list predicate', async () => {
    const calls = captureQuery(t);
    await records.listVisible(PUBLIC, { projectId: '207', dataset: 'Inspection' });
    await records.countVisible(PUBLIC, { projectId: '207', dataset: 'Inspection' });

    const listWhere = calls[0].spec.query.split(' WHERE ')[1].split(' ORDER BY ')[0];
    assert.strictEqual(calls[1].spec.query.split(' WHERE ')[1], listWhere);
  });
});

test('fragments repository', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('ids are deterministic so a re-seed updates rather than duplicates', () => {
    assert.strictEqual(fragments.fragmentId('207', 'nrpti'), '207:nrpti');
  });

  await t.test('put refuses an empty ACL — fragments must fail closed', async () => {
    await assert.rejects(() => fragments.put('207', 'nrpti', {}, []), /non-empty read/);
    await assert.rejects(() => fragments.put('207', 'nrpti', {}, undefined), /non-empty read/);
  });

  await t.test('a caller without the fragment role gets nothing, not a stripped item', async () => {
    t.mock.method(cosmos, 'readItem', async () => ({
      id: '207:nrpti', projectId: '207', fragmentType: 'nrpti', read: ['sysadmin'], data: { x: 1 }
    }));
    assert.strictEqual(await fragments.get(PUBLIC, '207', 'nrpti'), null);
    assert.ok(await fragments.get(ADMIN, '207', 'nrpti'));
  });
});

test('chunks repository', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('anonymous list applies the ACL predicate', async () => {
    const calls = captureQuery(t);
    await chunks.listVisible(PUBLIC, {});

    const { spec, container } = calls[0];
    // chunks_fts, not chunks: the full-text policy is immutable, so search needed a new container.
    assert.strictEqual(container, 'chunks_fts');
    assert.match(spec.query, /^SELECT \* FROM c WHERE /);
    assert.match(spec.query, /EXISTS\(SELECT VALUE r FROM r IN c\.read/);
  });

  await t.test('privileged list is unrestricted — the Typesense sync source', async () => {
    const calls = captureQuery(t);
    await chunks.listVisible(ADMIN, {});
    assert.match(calls[0].spec.query, /WHERE true/);
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

  await t.test('searchText composes the ACL into the SAME where clause as the match', async () => {
    const calls = captureQuery(t);
    await chunks.searchText(PUBLIC, { keywords: 'peace river' });

    // calls[0] is the COUNT pre-flight, calls[1] is the ranked query.
    assert.match(calls[0].spec.query, /SELECT VALUE COUNT\(1\)/, 'pre-flight must be a count');
    assert.ok(!/ORDER BY RANK/.test(calls[0].spec.query),
      'the pre-flight must NOT be a ranked query — that is the shape being avoided');

    const { spec, options } = calls[1];
    assert.match(spec.query, /FULLTEXTCONTAINSALL\(c\.content, @term0, @term1\)/);
    assert.match(spec.query, /EXISTS\(SELECT VALUE r FROM r IN c\.read/);
    assert.match(spec.query, /ORDER BY RANK FULLTEXTSCORE\(c\.content, @term0, @term1\)/);
    assert.deepStrictEqual(
      spec.parameters.filter(p => p.name.startsWith('@term')).map(p => p.value),
      ['peace', 'river']
    );
    // Must go through queryRanked, which drains with a page cap. query()'s fetchAll branch
    // never terminates on a ranked query that matches nothing against a non-empty container.
    assert.strictEqual(options.top, 20, 'ranked reads must pass top to queryRanked');
    assert.match(spec.query, /SELECT TOP @top /);
  });

  // THE defence against the outage. A ranked query that matches nothing spins synchronously
  // inside the SDK's client-side merge and blocks the event loop, so no timeout or AbortSignal
  // can rescue it — the query simply must not be issued.
  await t.test('zero matches means the ranked query is never issued', async (tt) => {
    const calls = [];
    tt.mock.method(cosmos, 'queryValue', async (container, spec) => {
      cosmos.assertQuerySpec(spec, container);
      calls.push({ kind: 'count', spec });
      return 0; // nothing matches
    });
    tt.mock.method(cosmos, 'queryRanked', async (container, spec) => {
      calls.push({ kind: 'ranked', spec });
      return { items: [], requestCharge: 0, pages: 0, truncated: false };
    });

    const res = await chunks.searchText(PUBLIC, { keywords: 'zzznotpresent' });

    assert.deepStrictEqual(res.items, []);
    assert.strictEqual(res.matched, 0);
    assert.deepStrictEqual(calls.map(c => c.kind), ['count'],
      'a ranked query must NOT follow a zero count');
  });

  await t.test('scoped callers are restricted on projectId in a ranked search too', async () => {
    const calls = captureQuery(t);
    await chunks.searchText(SCOPED, { keywords: 'river' });

    const { spec } = calls[0];
    assert.match(spec.query, /c\.projectId IN \(/);
    assert.ok(!/c\.documentId IN \(/.test(spec.query));
  });

  // Measured on the live account: the fuzzy {term, distance} form returns ZERO rows, and the
  // frontend sends fuzzy=true on EVERY Deep Search. Honouring it would blank the whole feature,
  // so an unavailable fuzzy degrades to exact matching instead of to silence.
  await t.test('fuzzy degrades to exact matching when it is not enabled', async () => {
    assert.strictEqual(chunks.FUZZY_ENABLED, false, 'default must be off');
    const calls = captureQuery(t);
    const res = await chunks.searchText(PUBLIC, { keywords: 'rivver propnent', fuzzy: true });

    const { spec } = calls[1];
    assert.match(spec.query, /FULLTEXTCONTAINSALL\(c\.content, @term0, @term1\)/,
      'must fall back to the exact form, not emit a fuzzy object');
    for (const p of spec.parameters.filter(x => x.name.startsWith('@term'))) {
      assert.strictEqual(typeof p.value, 'string', 'no object parameters when fuzzy is off');
    }
    assert.strictEqual(res.fuzzyUnavailable, true, 'the degradation must be reported, not hidden');
  });

  // ORDER BY RANK with no full-text predicate returns the WHOLE container, ranked but unfiltered.
  await t.test('no usable terms means no query at all, never a bare ORDER BY RANK', async () => {
    const calls = captureQuery(t);
    const empty = await chunks.searchText(PUBLIC, { keywords: '   !!!  ' });

    assert.deepStrictEqual(empty.items, []);
    assert.strictEqual(calls.length, 0, 'must not reach the data layer');
  });

  await t.test('hostile search input is bound, never interpolated', async () => {
    const calls = captureQuery(t);
    await chunks.searchText(PUBLIC, { keywords: "river') OR 1=1 --" });
    assert.ok(!calls[0].spec.query.includes('OR 1=1'));
  });

  await t.test('top is capped so a caller cannot ask for the whole corpus', async () => {
    const calls = captureQuery(t);
    await chunks.searchText(PUBLIC, { keywords: 'river', top: 100000 });
    const top = calls[1].spec.parameters.find(p => p.name === '@top');
    assert.strictEqual(top.value, chunks.MAX_TOP);
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
