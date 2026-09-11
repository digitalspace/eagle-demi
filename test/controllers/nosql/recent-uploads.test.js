'use strict';

/**
 * GET /documents/recent-uploads — the five projects that most recently received a public upload.
 *
 * The ranking comes from an aggregate over projects, not from a window over the newest documents,
 * because one Eagle bulk push stamps hundreds of documents in ONE project with the same instant.
 * So what is asserted here is the shape that survives that: the aggregate carries the caller's read
 * predicate, a bulk-imported project takes one row rather than the whole panel, ties resolve the
 * same way twice, and a project whose row cannot be stated is skipped rather than emitted.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../../src/db/cosmos-nosql');
const apiKeys = require('../../../src/repositories/api-keys');
const { generateKey } = require('../../../src/helpers/api-key');
const { forgetCachedKey } = require('../../../src/helpers/auth');
const { logger } = require('../../../src/utils/logger');
const { withServer } = require('../../helpers/with-server');
const documentController = require('../../../src/controllers/nosql/document');

const PUBLIC_ACL = ['public'];
const PRIVATE_ACL = ['eao'];

function doc(id, projectId, dateUploaded, extra = {}) {
  return {
    id,
    projectId,
    read: PUBLIC_ACL,
    eagleId: `eagle-${id}`,
    displayName: `${id} name`,
    documentFileName: `${id}.pdf`,
    type: 'Letter',
    dateUploaded,
    ...extra
  };
}

function project(id, read = PUBLIC_ACL, extra = {}) {
  return { id, read, name: `Project ${id}`, eagleId: `eagle-proj-${id}`, ...extra };
}

/**
 * Cosmos as this endpoint uses it: one aggregate over the documents container, then one
 * single-partition read per candidate project, then a point read of each project.
 *
 * `corpus` is the stored documents. The maxima the aggregate would return are DERIVED from it
 * rather than stated, so a test cannot accidentally describe a corpus the aggregate could never
 * produce — which is exactly the mistake that hid the bulk-import bug.
 */
function stubCosmos(t, corpus, projectRows = {}) {
  const aggregates = [];
  const partitionReads = [];
  const reads = [];

  t.mock.method(cosmos, 'query', async (container, spec, options) => {
    if (container !== 'documents') return { items: [] };

    if (/GROUP BY/.test(spec.query)) {
      aggregates.push({ spec, options });
      const maxima = new Map();
      for (const row of corpus) {
        if (!row.dateUploaded) continue;
        const held = maxima.get(row.projectId);
        if (!held || held < row.dateUploaded) maxima.set(row.projectId, row.dateUploaded);
      }
      return {
        items: [...maxima].map(([projectId, dateUploaded]) => ({ projectId, dateUploaded }))
      };
    }

    const projectId = spec.parameters.find(p => p.name === '@projectId').value;
    partitionReads.push({ projectId, query: spec.query, partitionKey: options.partitionKey });
    // `TOP 5 ... ORDER BY c.dateUploaded DESC`, served the way Cosmos serves it: the sort key is
    // honoured, the order among rows SHARING one instant is not. Highest id first inside a tie, so
    // the deterministic `id ASC` tie-break is actually load-bearing here.
    return {
      items: corpus
        .filter(row => String(row.projectId) === String(projectId) && row.dateUploaded)
        .sort((a, b) => (a.dateUploaded !== b.dateUploaded
          ? (a.dateUploaded < b.dateUploaded ? 1 : -1)
          : (a.id < b.id ? 1 : -1)))
        .slice(0, 5)
    };
  });

  t.mock.method(cosmos, 'readItem', async (container, id) => {
    reads.push(`${container}:${id}`);
    return projectRows[id] || null;
  });

  return { aggregates, partitionReads, reads };
}

/**
 * A clock the handler's memo reads through `Date.now`, moved by the test rather than by waiting.
 * The memo itself is emptied per test — module state must not make one test's result depend on
 * whether another ran first.
 */
let clock = Date.parse('2026-09-11T00:00:00.000Z');

function setup(t) {
  clock += 3_600_000;
  t.mock.method(Date, 'now', () => clock);
  documentController._resetRecentUploadsMemo();
  return { advance: (ms) => { clock += ms; } };
}

test('GET /documents/recent-uploads', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('ranks distinct projects by their newest upload and honours limit', async (t2) => {
    setup(t2);
    const { aggregates, partitionReads, reads } = stubCosmos(t2, [
      doc('d1', '101', '2026-09-10T10:00:00.000Z'),
      doc('d2', '101', '2026-09-09T10:00:00.000Z'),
      doc('d3', '202', '2026-09-08T10:00:00.000Z'),
      doc('d4', '303', '2026-09-07T10:00:00.000Z')
    ], { 101: project('101'), 202: project('202'), 303: project('303') });

    await withServer(async (call) => {
      const res = await call('/documents/recent-uploads?limit=2');
      assert.strictEqual(res.status, 200);

      const body = await res.json();
      assert.deepStrictEqual(body.items.map(i => i.projectId), ['101', '202'],
        'one row per project, newest first, cut at the caller\'s limit');
      assert.deepStrictEqual(body.items[0], {
        projectId: '101',
        eagleProjectId: 'eagle-proj-101',
        projectName: 'Project 101',
        dateUploaded: '2026-09-10T10:00:00.000Z',
        documents: [
          {
            id: 'd1',
            eagleId: 'eagle-d1',
            displayName: 'd1 name',
            documentFileName: 'd1.pdf',
            type: 'Letter',
            dateUploaded: '2026-09-10T10:00:00.000Z'
          },
          {
            id: 'd2',
            eagleId: 'eagle-d2',
            displayName: 'd2 name',
            documentFileName: 'd2.pdf',
            type: 'Letter',
            dateUploaded: '2026-09-09T10:00:00.000Z'
          }
        ]
      }, 'the row expands to the project\'s newest documents, newest first, pill fields as stored');
    });

    // ONE aggregate, carrying the caller's ACL and no ORDER BY — Cosmos rejects the two together,
    // which is why the sort is in JS.
    assert.strictEqual(aggregates.length, 1);
    assert.match(aggregates[0].spec.query, /^SELECT c\.projectId, MAX\(c\.dateUploaded\) AS dateUploaded /);
    assert.match(aggregates[0].spec.query, /GROUP BY c\.projectId$/);
    assert.match(aggregates[0].spec.query, /IS_DEFINED\(c\.dateUploaded\)/);
    assert.match(aggregates[0].spec.query, /EXISTS\(SELECT VALUE r FROM r IN c\.read/,
      'an anonymous caller must be filtered by the same read predicate GET /documents uses');
    assert.ok(!/ORDER BY/.test(aggregates[0].spec.query));

    // The document behind each answer comes from that project's OWN partition, so the cost does
    // not grow with the corpus.
    assert.deepStrictEqual(partitionReads.map(r => [r.projectId, r.partitionKey]),
      [['101', '101'], ['202', '202']]);
    assert.match(partitionReads[0].query, /^SELECT TOP 5 /);
    assert.match(partitionReads[0].query, /ORDER BY c\.dateUploaded DESC$/,
      'a single-partition ORDER BY is served by the default execution context, so it is safe here');
    assert.match(partitionReads[0].query, /IS_DEFINED\(c\.dateUploaded\)/);
    assert.deepStrictEqual(reads, ['projects:101', 'projects:202']);
  });

  // Ten is the maximum swagger documents, so it is the one limit a caller may send that the
  // endpoint must accept but no default exercises.
  await t.test('accepts the documented maximum limit of ten', async (t2) => {
    setup(t2);
    // Eleven readable projects, one per hour, so a limit that arrived as anything less than ten
    // would show up as a shorter panel rather than as the same answer.
    const ids = ['101', '102', '103', '104', '105', '106', '107', '108', '109', '110', '111'];
    const corpus = ids.map((id, i) =>
      doc(`d-${id}`, id, `2026-09-10T${String(20 - i).padStart(2, '0')}:00:00.000Z`));
    const projectRows = Object.fromEntries(ids.map(id => [id, project(id)]));
    stubCosmos(t2, corpus, projectRows);

    await withServer(async (call) => {
      const res = await call('/documents/recent-uploads?limit=10');
      assert.strictEqual(res.status, 200, 'limit=10 is the documented maximum, not caller error');

      const body = await res.json();
      assert.deepStrictEqual(body.items.map(i => i.projectId),
        ['101', '102', '103', '104', '105', '106', '107', '108', '109', '110'],
        'ten rows are ranked and the eleventh project is cut, so the limit reached the ranking');
    });
  });

  // The bug the aggregate exists for: an Eagle bulk push mirrors hundreds of documents into one
  // project at one instant. A window over the newest documents returns that project alone.
  await t.test('a bulk import takes one row, not the whole panel', async (t2) => {
    setup(t2);
    const bulk = Array.from({ length: 300 }, (_, i) =>
      doc(`bulk-${String(i).padStart(3, '0')}`, '101', '2026-09-10T10:00:00.000Z'));
    const others = ['202', '303', '404', '505', '606'].map((id, i) =>
      doc(`d-${id}`, id, `2026-09-0${9 - i}T10:00:00.000Z`));

    const projectRows = {};
    for (const id of ['101', '202', '303', '404', '505', '606']) projectRows[id] = project(id);
    stubCosmos(t2, [...bulk, ...others], projectRows);

    await withServer(async (call) => {
      const res = await call('/documents/recent-uploads?limit=6');
      const body = await res.json();
      assert.deepStrictEqual(body.items.map(i => i.projectId),
        ['101', '202', '303', '404', '505', '606'],
        'all six projects rank; the 300-document import is one of them');
      // WHICH five of the 300 come back is Cosmos's choice — every row carries the same sort key,
      // so `TOP 5` may return any of them. What this endpoint owns is the order they are listed in,
      // and the stub hands them over highest id first to prove the tie-break runs.
      const bulkIds = body.items[0].documents.map(d => d.id);
      assert.strictEqual(bulkIds.length, 5, 'at most five documents per project row');
      assert.ok(bulkIds.every(id => id.startsWith('bulk-')), 'all five come from the import');
      assert.deepStrictEqual(bulkIds, [...bulkIds].sort(),
        'documents sharing one instant are listed by id ascending, not in arrival order');
      assert.deepStrictEqual(body.items[1].documents.map(d => d.id), ['d-202'],
        'a project with fewer than five documents lists what it has');
    });
  });

  await t.test('a tie between projects resolves the same way on every call', async (t2) => {
    setup(t2);
    stubCosmos(t2, [
      doc('d1', '202', '2026-09-10T10:00:00.000Z'),
      doc('d2', '101', '2026-09-10T10:00:00.000Z')
    ], { 101: project('101'), 202: project('202') });

    await withServer(async (call) => {
      const first = await (await call('/documents/recent-uploads?limit=2')).json();
      // Past the memo, so the second answer is computed rather than replayed.
      clock += 61_000;
      const second = await (await call('/documents/recent-uploads?limit=2')).json();

      assert.deepStrictEqual(first.items.map(i => i.projectId), ['101', '202'],
        'same instant, so project id breaks the tie — a stable order, not insertion order');
      assert.deepStrictEqual(second.items, first.items,
        'two computations of the same data must not reorder the panel');
    });
  });

  await t.test('returns a short list rather than padding it, and says so', async (t2) => {
    setup(t2);
    stubCosmos(t2, [
      doc('d1', '101', '2026-09-10T10:00:00.000Z'),
      doc('d2', '101', '2026-09-09T10:00:00.000Z')
    ], { 101: project('101') });

    const infos = [];
    const originalInfo = logger.info;
    logger.info = (message) => infos.push(String(message));

    try {
      await withServer(async (call) => {
        const res = await call('/documents/recent-uploads');
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.deepStrictEqual(body.items.map(i => i.projectId), ['101'],
          'one readable project means one row, not five');
      });
    } finally {
      logger.info = originalInfo;
    }

    assert.ok(infos.some(m => /recent uploads: 1 of 5 projects/.test(m)),
      'a short answer is logged, so a homepage panel that quietly thins out is visible');
  });

  await t.test('skips a project the caller may not read and keeps scanning', async (t2) => {
    setup(t2);
    const { reads, partitionReads } = stubCosmos(t2, [
      doc('d1', '101', '2026-09-10T10:00:00.000Z'),
      doc('d2', '202', '2026-09-09T10:00:00.000Z'),
      doc('d3', '303', '2026-09-08T10:00:00.000Z')
    ], {
      101: project('101', PRIVATE_ACL),
      202: null,
      303: project('303')
    });

    await withServer(async (call) => {
      const res = await call('/documents/recent-uploads?limit=2');
      const body = await res.json();
      assert.deepStrictEqual(body.items.map(i => i.projectId), ['303'],
        'a restricted project and a missing one are skipped, not returned and not fatal');
    });

    assert.deepStrictEqual(reads, ['projects:101', 'projects:202', 'projects:303']);
    assert.deepStrictEqual(partitionReads.map(r => r.projectId), ['303'],
      'an unreadable project costs a point read, never a document read');
  });

  await t.test('ignores documents with no dateUploaded', async (t2) => {
    setup(t2);
    stubCosmos(t2, [
      doc('d1', '101', null),
      doc('d2', '101', '2026-09-09T10:00:00.000Z'),
      { id: 'd3', projectId: '202', read: PUBLIC_ACL, displayName: 'no date' }
    ], { 101: project('101'), 202: project('202') });

    await withServer(async (call) => {
      const res = await call('/documents/recent-uploads');
      const body = await res.json();
      assert.deepStrictEqual(body.items.map(i => i.documents.map(d => d.id)), [['d2']],
        'an undated document is never listed, and cannot claim a project on its own either');
      assert.deepStrictEqual(body.items.map(i => i.projectId), ['101'],
        'a project whose only document is undated is not in the aggregate at all');
    });
  });

  await t.test('lists documents newest first, ties broken by id', async (t2) => {
    setup(t2);
    stubCosmos(t2, [
      doc('zeta', '101', '2026-09-10T10:00:00.000Z'),
      doc('beta', '101', '2026-09-09T10:00:00.000Z'),
      doc('alpha', '101', '2026-09-09T10:00:00.000Z')
    ], { 101: project('101') });

    await withServer(async (call) => {
      const body = await (await call('/documents/recent-uploads')).json();
      assert.deepStrictEqual(body.items[0].documents.map(d => d.id), ['zeta', 'alpha', 'beta'],
        'date decides first; id breaks a tie, whatever order Cosmos returned the rows in');
      assert.strictEqual(body.items[0].dateUploaded, '2026-09-10T10:00:00.000Z',
        'the project is stamped with the first document it lists');
    });
  });

  await t.test('drops a document the redactor withheld, keeping the project', async (t2) => {
    setup(t2);
    stubCosmos(t2, [
      doc('d1', '101', '2026-09-10T10:00:00.000Z'),
      doc('d2', '101', '2026-09-09T10:00:00.000Z', { vis: { id: 2 } }),
      doc('d3', '101', '2026-09-08T10:00:00.000Z')
    ], { 101: project('101') });

    await withServer(async (call) => {
      const body = await (await call('/documents/recent-uploads')).json();
      assert.deepStrictEqual(body.items.map(i => i.documents.map(d => d.id)), [['d1', 'd3']],
        'the unstatable document leaves the list; the project keeps its place and its other rows');
    });
  });

  // A dial can withhold a field below its catalog default. A row that cannot name its project, its
  // newest document, or the instant it ranks by is not emitted at all.
  await t.test('a project whose row cannot be stated is skipped', async (t2) => {
    setup(t2);
    stubCosmos(t2, [
      doc('d1', '101', '2026-09-10T10:00:00.000Z', { vis: { id: 2 } }),
      doc('d2', '202', '2026-09-09T10:00:00.000Z', { vis: { dateUploaded: 2 } }),
      doc('d3', '303', '2026-09-08T10:00:00.000Z')
    ], {
      101: project('101'),
      202: project('202'),
      303: project('303', PUBLIC_ACL, { vis: { id: 2 } })
    });

    await withServer(async (call) => {
      const res = await call('/documents/recent-uploads');
      const body = await res.json();
      assert.deepStrictEqual(body.items, [],
        'a withheld document id, a withheld upload date and a withheld project id each drop the ' +
        'project rather than emitting a row with a hole in it');
    });
  });

  await t.test('rejects a limit that is not a plain whole number 1-10', async (t2) => {
    setup(t2);
    const { aggregates } = stubCosmos(t2, [doc('d1', '101', '2026-09-10T10:00:00.000Z')],
      { 101: project('101') });

    await withServer(async (call) => {
      // `05`, `5.0`, `5e0`, `0x5` and `+5` all mean five to Number() — five cache keys for one
      // answer, which is how a shared cache and the memo get walked around.
      for (const raw of ['50', 'abc', '0', '-1', '2.5', '05', '5.0', '5e0', '0x5', '%2B5', '']) {
        const res = await call(`/documents/recent-uploads?limit=${raw}`);
        assert.strictEqual(res.status, 400, `limit=${raw} must be rejected`);
        const body = await res.json();
        assert.match(body.error, /limit/);
      }

      // Repeated keys arrive as an array; one value only.
      const repeated = await call('/documents/recent-uploads?limit=5&limit=5');
      assert.strictEqual(repeated.status, 400);
    });

    assert.strictEqual(aggregates.length, 0, 'a refused limit must not reach Cosmos');
  });

  await t.test('caches the anonymous answer for a minute and recomputes after it', async (t2) => {
    const { advance } = setup(t2);
    const { aggregates } = stubCosmos(t2, [doc('d1', '101', '2026-09-10T10:00:00.000Z')],
      { 101: project('101') });

    await withServer(async (call) => {
      const first = await call('/documents/recent-uploads?limit=3');
      const second = await call('/documents/recent-uploads?limit=3');
      assert.deepStrictEqual(await second.json(), await first.json());
      assert.strictEqual(aggregates.length, 1, 'the second hit inside the TTL must not touch Cosmos');

      // A different limit is a different answer, not a hit on this one.
      await call('/documents/recent-uploads?limit=4');
      assert.strictEqual(aggregates.length, 2);

      advance(61_000);
      await call('/documents/recent-uploads?limit=3');
      assert.strictEqual(aggregates.length, 3, 'the entry expires rather than living forever');
    });
  });

  await t.test('an identified caller is never served, or filled, from the anonymous memo', async (t2) => {
    setup(t2);
    const { aggregates } = stubCosmos(t2, [doc('d1', '101', '2026-09-10T10:00:00.000Z')],
      { 101: project('101') });

    const { keyId, plaintext, hash } = generateKey('test');
    forgetCachedKey(keyId);
    t2.mock.method(apiKeys, 'getById', async () => ({
      id: keyId, name: 'recent-uploads', hash, roles: ['compliance'],
      projectScope: null, expiresAt: null, revokedAt: null
    }));
    t2.mock.method(apiKeys, 'touchLastUsed', async () => {});

    try {
      await withServer(async (call) => {
        const anonymous = await call('/documents/recent-uploads?limit=6');
        assert.strictEqual(anonymous.headers.get('vary'), 'Authorization, X-Api-Key',
          'a shared cache keyed on the URL alone would hand this answer to the next caller');
        assert.strictEqual(anonymous.headers.get('cache-control'), 'public, max-age=300');
        assert.strictEqual(aggregates.length, 1);

        // `compliance` resolves to the SAME tier as an anonymous visitor while seeing different
        // rows, which is why the memo key cannot be the tier alone.
        const keyed = await call('/documents/recent-uploads?limit=6',
          { headers: { 'X-Api-Key': plaintext } });
        assert.strictEqual(keyed.status, 200);
        assert.strictEqual(keyed.headers.get('cache-control'), 'private, no-store',
          'an answer computed for one credential must not be stored by a shared cache');
        assert.strictEqual(keyed.headers.get('vary'), 'Authorization, X-Api-Key');
        assert.strictEqual(aggregates.length, 2, 'the identified caller was served from the memo');

        // ...and it did not leave its own answer behind for the next anonymous visitor.
        await call('/documents/recent-uploads?limit=6');
        assert.strictEqual(aggregates.length, 2, 'the anonymous entry is still the one being served');
      });
    } finally {
      forgetCachedKey(keyId);
    }
  });
});
