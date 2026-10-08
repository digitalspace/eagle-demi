'use strict';

/**
 * A project visibility change, carried down to its comment periods and their comments.
 *
 * `PUT /api/projects/:id/level` is the surface: everything below it — the controller, both
 * repositories and the derivation in `helpers/acl-cascade` — is real here, and only Cosmos is
 * doubled. What is asserted is therefore what would be STORED: the bulk patch each container
 * receives, in the partition it receives it.
 *
 * The rule the wiring has to get right is that a comment follows ITS PERIOD, not the project. The
 * period is already capped by the project, so passing the project's ACL down a second time would
 * publish a comment under a period Eagle never published.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const projects = require('../../../src/repositories/projects');
const documents = require('../../../src/repositories/documents');
const aiSearch = require('../../../src/search/ai-search');
const cosmos = require('../../../src/db/cosmos-nosql');
const notifications = require('../../../src/repositories/notifications');
const projectController = require('../../../src/controllers/nosql/project');

const SYSADMIN = {
  sub: 'kc-1', preferred_username: 'sys.admin', realm_access: { roles: ['sysadmin'] }
};

// Spelled out rather than taken from readForLevel — see document-acl-cascade.test.js.
const PUBLIC_READ = ['staff', 'idir', 'public'];
const STAFF_READ = ['staff'];

const PROJECT_AT = (level) => ({
  id: '207',
  trackProjectId: 207,
  name: 'Skeena LNG',
  read: level === 4 ? PUBLIC_READ : STAFF_READ,
  isPublished: level === 4
});

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    setHeader() {}
  };
}

/**
 * A fixture row as the SQL projection would return it: a field the repository's `select` does not
 * name does not come back.
 *
 * `isDeleted` reaches `deriveAcls` only through that projection and nothing else reads it, so a
 * stub that handed the whole fixture over would stay green after the field was trimmed out of the
 * query — with the deleted period republished on the next project publish.
 */
function projected(rows, query) {
  if (!query || query.includes('SELECT *')) return rows;
  return rows.map(row => Object.fromEntries(Object.entries(row).filter(
    ([field]) => new RegExp(`\\bc\\.${field}\\b|\\bAS ${field}\\b`).test(query))));
}

/**
 * Cosmos, and only Cosmos. Period rows come back for the `commentPeriods` read; comment rows are
 * keyed by the partition the read asks for, which is the period id. Both are projected through the
 * query the repository actually sent.
 *
 * @returns {{writes: Array, unexpected: Array}} the bulk patches, in the order they were sent
 */
function stubCosmos(t, { periods, commentsByPeriod = {}, updates = null, mirrorRows = [], mirrorError = null }) {
  const writes = [];
  const unexpected = [];
  // `groups` and `inspections` rows, filtered by the partition the read names and every bound
  // `c.<field> = @param` equality it sends, so a read aimed at the wrong project finds nothing.
  const mirrored = (container, spec, options) => {
    const equalities = [...spec.query.matchAll(/c\.(\w+) = (@\w+)/g)]
      .map(([, field, name]) => [field, spec.parameters.find(p => p.name === name).value]);
    const partitionField = container === 'groups' ? 'projectId' : 'inspection';
    return projected(mirrorRows.filter(row => row.container === container &&
      (options.partitionKey === undefined || String(row[partitionField]) === String(options.partitionKey)) &&
      equalities.every(([field, value]) => String(row[field]) === String(value))), spec.query);
  };

  t.mock.method(aiSearch, 'indexes', () => ({
    chunks: 'chunks', projects: 'projects', documents: 'documents'
  }));
  t.mock.method(aiSearch, 'writeAcls', async () => 1);
  // The document leg has its own suite; this one is about engagement.
  t.mock.method(documents, 'setAclForProject', async () => ({ succeeded: 0, failed: 0, rows: [] }));

  t.mock.method(cosmos, 'query', async (container, spec, options = {}) => {
    const query = spec && spec.query;
    if (container === 'commentPeriods') return { items: projected(periods, query) };
    if (container === 'comments') {
      return { items: projected(commentsByPeriod[String(options.partitionKey)] || [], query) };
    }
    if (container === 'updates' && updates) return { items: updates.map(u => ({ ...u })) };
    if (container === 'groups' || container === 'inspections') {
      if (mirrorError) throw mirrorError;
      return { items: mirrored(container, spec, options) };
    }
    unexpected.push(container);
    return { items: [] };
  });
  t.mock.method(cosmos, 'bulkVerified', async (container, operations) => {
    writes.push({ container, operations });
    // Updates are stored as patched, so a second move reads what the first one wrote.
    if (container === 'updates') {
      for (const op of operations) {
        const row = updates.find(u => u.id === op.id);
        row.read = op.resourceBody.operations.find(o => o.path === '/read').value;
      }
    }
    for (const op of operations) {
      const row = mirrorRows.find(r => r.container === container && r.id === op.id);
      if (row) row.read = opValue(op, '/read');
    }
    return { succeeded: operations.length, failed: 0, statusCounts: {}, requestCharge: 1 };
  });

  return { writes, unexpected };
}

/** Move the project to `level` through the real handler. */
async function moveTo(t, level, from, over = {}) {
  t.mock.method(projects, 'getById', async () => ({ ...PROJECT_AT(from), ...over }));
  t.mock.method(projects, 'upsert', async (item) => item);

  const res = mockRes();
  await projectController.setLevel({
    params: { id: '207' }, query: {},
    body: { level, confirm: true, reason: 'engagement cascade' }, user: SYSADMIN
  }, res);
  return res;
}

/** The value one planned patch would write to one path. */
const opValue = (operation, path) =>
  operation.resourceBody.operations.find(o => o.path === path).value;

const patchesTo = (writes, container) => writes.filter(w => w.container === container);

test('publishing a project publishes the engagement Eagle published', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a period stored private because its project was carries through to public',
    async (tt) => {
      const { writes, unexpected } = stubCosmos(tt, {
        periods: [{ id: 'cp1', read: STAFF_READ, eagleRead: ['public'] }],
        commentsByPeriod: { cp1: [{ id: 'c1', read: STAFF_READ, eagleRead: ['public'] }] }
      });

      const res = await moveTo(tt, 4, 2);

      assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
      assert.deepStrictEqual(unexpected, []);

      const [periodWrite] = patchesTo(writes, 'commentPeriods');
      assert.strictEqual(periodWrite.operations[0].partitionKey, '207',
        'periods partition on their project');
      assert.deepStrictEqual(opValue(periodWrite.operations[0], '/read'), PUBLIC_READ);
      assert.strictEqual(opValue(periodWrite.operations[0], '/isPublished'), true);

      const [commentWrite] = patchesTo(writes, 'comments');
      assert.strictEqual(commentWrite.operations[0].partitionKey, 'cp1',
        'comments partition on their period');
      assert.deepStrictEqual(opValue(commentWrite.operations[0], '/read'), PUBLIC_READ,
        'the comment follows its period, or a published period renders an empty thread');
      assert.strictEqual(opValue(commentWrite.operations[0], '/isPublished'), true);
    });

  await t.test('a comment is capped by ITS period, not by the project', async (tt) => {
    // cp2 is a period Eagle never published. Passing the project's ACL down to the comments —
    // rather than each period's newly derived one — publishes c2 under a private period.
    const { writes } = stubCosmos(tt, {
      periods: [
        { id: 'cp1', read: STAFF_READ, eagleRead: ['public'] },
        { id: 'cp2', read: STAFF_READ, eagleRead: ['staff', 'sysadmin'] }
      ],
      commentsByPeriod: {
        cp1: [{ id: 'c1', eagleRead: ['public'] }],
        cp2: [{ id: 'c2', eagleRead: ['public'] }]
      }
    });

    await moveTo(tt, 4, 2);

    const commentWrites = patchesTo(writes, 'comments');
    assert.strictEqual(commentWrites.length, 2, 'one bulk request per period partition');
    assert.deepStrictEqual(commentWrites.map(w => w.operations[0].partitionKey), ['cp1', 'cp2']);

    assert.deepStrictEqual(opValue(commentWrites[0].operations[0], '/read'), PUBLIC_READ,
      'under a public period, a public comment is public');
    assert.deepStrictEqual(opValue(commentWrites[1].operations[0], '/read'), STAFF_READ,
      'under a period Eagle kept private, the same comment stays private');
    assert.strictEqual(opValue(commentWrites[1].operations[0], '/isPublished'), false);
  });
});

test('a takedown takes the engagement down with it', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('both the period and its comments go private again', async (tt) => {
    const { writes } = stubCosmos(tt, {
      periods: [{ id: 'cp1', read: PUBLIC_READ, eagleRead: ['public'] }],
      commentsByPeriod: { cp1: [{ id: 'c1', read: PUBLIC_READ, eagleRead: ['public'] }] }
    });

    const res = await moveTo(tt, 2, 4);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));

    const [periodWrite] = patchesTo(writes, 'commentPeriods');
    assert.deepStrictEqual(opValue(periodWrite.operations[0], '/read'), STAFF_READ);
    assert.strictEqual(opValue(periodWrite.operations[0], '/isPublished'), false);

    const [commentWrite] = patchesTo(writes, 'comments');
    assert.deepStrictEqual(opValue(commentWrite.operations[0], '/read'), STAFF_READ,
      'a comment left public under a private period is readable by anyone who knows the id');
    assert.strictEqual(opValue(commentWrite.operations[0], '/isPublished'), false);
  });

  await t.test('a period Eagle deleted is not handed back to the public on a re-publish',
    async (tt) => {
      // The delete push narrowed it and flagged it (see public-read-push.test.js). Publishing the
      // project re-derives every period from its raw Eagle copy, which still reads `public`, so
      // without the flag this is where a deleted period comes back — and its comments with it.
      const { writes } = stubCosmos(tt, {
        periods: [
          { id: 'cp1', read: STAFF_READ, eagleRead: ['public'], isDeleted: true },
          { id: 'cp2', read: STAFF_READ, eagleRead: ['public'] }
        ],
        commentsByPeriod: {
          cp1: [{ id: 'c1', read: STAFF_READ, eagleRead: ['public'] }],
          cp2: [{ id: 'c2', read: STAFF_READ, eagleRead: ['public'] }]
        }
      });

      const res = await moveTo(tt, 4, 2);

      assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
      const [periodWrite] = patchesTo(writes, 'commentPeriods');
      assert.deepStrictEqual(opValue(periodWrite.operations[0], '/read'), STAFF_READ,
        'the deleted period stays staff-only');
      assert.deepStrictEqual(opValue(periodWrite.operations[1], '/read'), PUBLIC_READ,
        'the live period beside it still publishes');

      const [deletedComments, liveComments] = patchesTo(writes, 'comments');
      assert.deepStrictEqual(opValue(deletedComments.operations[0], '/read'), STAFF_READ,
        'a comment under a deleted period follows its period, not the project');
      assert.deepStrictEqual(opValue(liveComments.operations[0], '/read'), PUBLIC_READ);
    });

  await t.test('a project with no periods writes nothing to either container', async (tt) => {
    const { writes } = stubCosmos(tt, { periods: [] });

    const res = await moveTo(tt, 2, 4);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(writes, []);
  });
});

test('a project visibility change carries to its Updates', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('private then public: the Update follows both ways', async (tt) => {
    const eagleId = '588511d0aaecd9001b825604';
    // `eagleRead` is Eagle's own ACL (`sources.eagle.read`), stored as is under a public project.
    const eagleRead = ['public', 'sysadmin', 'staff'];
    const updates = [{ id: 'u1', read: eagleRead, eagleRead }];
    const { writes, unexpected } = stubCosmos(tt, { periods: [], updates });
    tt.mock.method(notifications, 'readForWrite', async () => null);

    const down = await moveTo(tt, 2, 4, { eagleId });
    assert.strictEqual(down.statusCode, 200, JSON.stringify(down.body));
    assert.deepStrictEqual(updates[0].read, STAFF_READ);

    const up = await moveTo(tt, 4, 2, { eagleId });
    assert.strictEqual(up.statusCode, 200, JSON.stringify(up.body));
    assert.deepStrictEqual(updates[0].read, eagleRead, 'back to Eagle\'s own read, verbatim');

    const [first] = patchesTo(writes, 'updates');
    assert.strictEqual(first.operations[0].partitionKey, 'u1', 'updates partition on their own id');
    assert.deepStrictEqual(unexpected, []);
  });

  await t.test('a partly failed Update cascade 500s and marks the project for the next push',
    async (tt) => {
      const { writes } = stubCosmos(tt, { periods: [], updates: [{ id: 'u1', read: PUBLIC_READ, eagleRead: ['public'] }] });
      tt.mock.method(notifications, 'readForWrite', async () => null);
      tt.mock.method(cosmos, 'bulkVerified', async (container, operations) => {
        writes.push({ container, operations });
        return { succeeded: 0, failed: operations.length, statusCounts: {}, requestCharge: 1 };
      });
      const marked = [];
      tt.mock.method(projects, 'patchCascadePending', async (id, at) => { marked.push({ id, at }); });

      const res = await moveTo(tt, 2, 4, { eagleId: '588511d0aaecd9001b825604' });

      assert.strictEqual(res.statusCode, 500);
      assert.match(res.body.error, /updates were not fully updated/);
      assert.strictEqual(marked.length, 1);
      assert.strictEqual(marked[0].id, '207');
    });

  await t.test('a failed Update cascade is logged and answers 500, as a document one does',
    async (tt) => {
      stubCosmos(tt, { periods: [], updates: [] });
      tt.mock.method(notifications, 'readForWrite', async () => { throw new Error('cosmos down'); });

      const res = await moveTo(tt, 2, 4, { eagleId: '588511d0aaecd9001b825604' });

      assert.strictEqual(res.statusCode, 500);
      assert.match(res.body.error, /updates were not updated/);
    });
});

/**
 * Groups, and the inspection chain under the project, follow it both ways. Each row derives from
 * its own Eagle read under its parent's NEW read: an item follows its element, not the project.
 */
test('a project visibility change carries to its groups and inspections', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const fixture = () => [
    { container: 'groups', id: 'G1', projectId: '207', read: STAFF_READ, eagleRead: ['sysadmin'] },
    { container: 'groups', id: 'G2', projectId: '207', read: STAFF_READ, eagleRead: ['sysadmin', 'staff'] },
    { container: 'groups', id: 'G-other', projectId: '999', read: STAFF_READ, eagleRead: ['sysadmin'] },
    { container: 'inspections', id: 'I1', kind: 'Inspection', inspection: 'I1', projectId: '207',
      read: STAFF_READ, eagleRead: ['sysadmin', 'inspector'] },
    // No ladder token in Eagle, so each row of the chain keeps its own Eagle read, never `team`.
    { container: 'inspections', id: 'E1', kind: 'InspectionElement', inspection: 'I1', projectId: '207',
      read: STAFF_READ, eagleRead: ['sysadmin'] },
    { container: 'inspections', id: 'IT1', kind: 'InspectionItem', inspection: 'I1', element: 'E1',
      projectId: '207', read: STAFF_READ, eagleRead: ['sysadmin', 'inspector'] },
    { container: 'inspections', id: 'I-other', kind: 'Inspection', inspection: 'I-other', projectId: '999',
      read: STAFF_READ, eagleRead: ['sysadmin', 'inspector'] }
  ];
  const readOf = (rows, id) => rows.find(r => r.id === id).read;

  await t.test('narrowed to team, the groups and the whole chain narrow; widened back, they return',
    async (tt) => {
      const rows = fixture();
      const { writes } = stubCosmos(tt, { periods: [], mirrorRows: rows });
      tt.mock.method(notifications, 'readForWrite', async () => null);

      const narrowed = await moveTo(tt, 1, 2);
      assert.strictEqual(narrowed.statusCode, 200, JSON.stringify(narrowed.body));
      assert.deepStrictEqual(readOf(rows, 'G1'), ['sysadmin']);
      assert.deepStrictEqual(readOf(rows, 'G2'), ['team']);
      assert.deepStrictEqual(readOf(rows, 'I1'), ['sysadmin', 'inspector']);
      assert.deepStrictEqual(readOf(rows, 'E1'), ['sysadmin']);
      assert.deepStrictEqual(readOf(rows, 'IT1'), ['sysadmin', 'inspector']);
      assert.ok(patchesTo(writes, 'inspections').every(w => w.operations.every(op => op.partitionKey === 'I1')),
        'the chain is patched in its inspection\'s partition');

      const widened = await moveTo(tt, 2, 1, { read: ['team'] });
      assert.strictEqual(widened.statusCode, 200, JSON.stringify(widened.body));
      assert.deepStrictEqual(readOf(rows, 'G2'), STAFF_READ);
      // No ladder token from Eagle, so nothing to widen back to: each keeps its Eagle read.
      for (const id of ['G1', 'E1']) assert.deepStrictEqual(readOf(rows, id), ['sysadmin'], id);
      for (const id of ['I1', 'IT1']) assert.deepStrictEqual(readOf(rows, id), ['sysadmin', 'inspector'], id);
    });

  await t.test('an element follows its inspection\'s new read, not the project\'s', async (tt) => {
    // Published project; a staff-only inspection; an element Eagle marked public. Capping the
    // element by the project would publish an element of a staff-only inspection.
    const rows = [
      { container: 'inspections', id: 'I1', kind: 'Inspection', inspection: 'I1', projectId: '207',
        read: STAFF_READ, eagleRead: ['sysadmin', 'staff'] },
      { container: 'inspections', id: 'E1', kind: 'InspectionElement', inspection: 'I1', projectId: '207',
        read: STAFF_READ, eagleRead: ['public'] }
    ];
    stubCosmos(tt, { periods: [], mirrorRows: rows });
    tt.mock.method(notifications, 'readForWrite', async () => null);

    const res = await moveTo(tt, 4, 2);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(readOf(rows, 'I1'), STAFF_READ);
    assert.deepStrictEqual(readOf(rows, 'E1'), STAFF_READ);
  });

  await t.test('a container not provisioned yet is skipped; the rest of the cascade still runs',
    async (tt) => {
      const { writes } = stubCosmos(tt, {
        periods: [{ id: 'cp1', read: STAFF_READ, eagleRead: ['public'] }],
        commentsByPeriod: { cp1: [{ id: 'c1', read: STAFF_READ, eagleRead: ['public'] }] },
        mirrorError: Object.assign(new Error('Resource Not Found'), { code: 404 })
      });
      tt.mock.method(notifications, 'readForWrite', async () => null);

      const res = await moveTo(tt, 4, 2);

      assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
      assert.strictEqual(documents.setAclForProject.mock.callCount(), 1, 'documents still re-derived');
      assert.strictEqual(patchesTo(writes, 'commentPeriods').length, 1, 'periods still re-derived');
      assert.strictEqual(patchesTo(writes, 'comments').length, 1, 'comments still re-derived');
    });

  await t.test('any other error from those containers still fails the cascade', async (tt) => {
    stubCosmos(tt, { periods: [], mirrorError: Object.assign(new Error('throttled'), { code: 503 }) });
    tt.mock.method(notifications, 'readForWrite', async () => null);

    const res = await moveTo(tt, 4, 2);

    assert.strictEqual(res.statusCode, 500);
    assert.match(res.body.error, /groups were not updated/);
    assert.match(res.body.error, /inspections were not updated/);
  });

  await t.test('rows of another project are untouched', async (tt) => {
    const rows = fixture();
    const { writes } = stubCosmos(tt, { periods: [], mirrorRows: rows });
    tt.mock.method(notifications, 'readForWrite', async () => null);

    await moveTo(tt, 1, 2);

    const patched = writes.flatMap(w => w.operations.map(op => op.id));
    assert.ok(!patched.includes('G-other') && !patched.includes('I-other'), patched.join(','));
    assert.deepStrictEqual(readOf(rows, 'G-other'), STAFF_READ);
    assert.deepStrictEqual(readOf(rows, 'I-other'), STAFF_READ);
  });
});
