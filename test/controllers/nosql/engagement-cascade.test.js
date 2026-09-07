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
 * Cosmos, and only Cosmos. Period rows come back for the `commentPeriods` read; comment rows are
 * keyed by the partition the read asks for, which is the period id.
 *
 * @returns {{writes: Array, unexpected: Array}} the bulk patches, in the order they were sent
 */
function stubCosmos(t, { periods, commentsByPeriod = {} }) {
  const writes = [];
  const unexpected = [];

  t.mock.method(aiSearch, 'indexes', () => ({
    chunks: 'chunks', projects: 'projects', documents: 'documents'
  }));
  t.mock.method(aiSearch, 'writeAcls', async () => 1);
  // The document leg has its own suite; this one is about engagement.
  t.mock.method(documents, 'setAclForProject', async () => ({ succeeded: 0, failed: 0, rows: [] }));

  t.mock.method(cosmos, 'query', async (container, spec, options = {}) => {
    if (container === 'commentPeriods') return { items: periods };
    if (container === 'comments') {
      return { items: commentsByPeriod[String(options.partitionKey)] || [] };
    }
    unexpected.push(container);
    return { items: [] };
  });
  t.mock.method(cosmos, 'bulkVerified', async (container, operations) => {
    writes.push({ container, operations });
    return { succeeded: operations.length, failed: 0, statusCounts: {}, requestCharge: 1 };
  });

  return { writes, unexpected };
}

/** Move the project to `level` through the real handler. */
async function moveTo(t, level, from) {
  t.mock.method(projects, 'getById', async () => PROJECT_AT(from));
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
