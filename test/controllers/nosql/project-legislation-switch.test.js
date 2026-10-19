'use strict';

/** `PUT /projects/:id/level` with a `legislationYear`: eagle-api's publish switch (`project.js:776-801`). */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../../src/utils/audit');
const projects = require('../../../src/repositories/projects');
const projectController = require('../../../src/controllers/nosql/project');
const { mergeEagleOnlyProject } = require('../../../src/merge/project');
const { mockRes } = require('../../helpers/eagle-mirror-fixtures');

audit._setTransport(async () => {});

const WRITER = { realm_access: { roles: ['demi-service-write'] } };
const EAGLE_ID = '5850d1b4652f7e0019b52c0e';

/** A stored Eagle-only row built from a Mongo-shaped push, as the mirror stores it. */
function stored({ current = 'legislation_2002', list = [2002, 2018], blocks = {} } = {}) {
  const raw = {
    _id: EAGLE_ID,
    read: ['public', 'staff', 'sysadmin'],
    currentLegislationYear: current,
    legislationYearList: list,
    legislation_2002: { name: 'Mine 2002', legislationYear: 2002, legislation: '2002 Environmental Assessment Act' },
    legislation_2018: { name: 'Mine 2018', legislationYear: 2018, legislation: '2018 Environmental Assessment Act' },
    legislation_2025: { name: 'Mine 2025', legislationYear: 2025, legislation: 'Building Canada Act' },
    ...blocks
  };
  return { ...mergeEagleOnlyProject(raw), _etag: '"0x1"' };
}

/** Serve `reads` in order, one per getById; capture every upsert. */
function stage(t, reads, upsert = async (doc) => doc) {
  let read = 0;
  t.mock.method(projects, 'getById', async () => structuredClone(reads[Math.min(read++, reads.length - 1)]));
  const writes = [];
  t.mock.method(projects, 'upsert', async (doc) => { writes.push(doc); return upsert(doc); });
  return writes;
}

const publish = async (legislationYear, level = 4) => {
  const res = mockRes();
  const body = { level, confirm: true, reason: 'switch Act', legislationYear };
  await projectController.setLevel({ params: { id: `eagle-${EAGLE_ID}` }, query: {}, user: WRITER, body }, res);
  return res;
};

test('PUT /projects/:id/level legislation year switch', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('another year with content becomes current and its block is lifted', async () => {
    const writes = stage(t, [stored()]);

    const res = await publish(2018);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(writes[0].name, 'Mine 2018');
    assert.strictEqual(writes[0].legislationYear, 2018);
    assert.strictEqual(writes[0].sources.eagle.currentLegislationYear, 'legislation_2018');
  });

  await t.test('the switch keeps every block for the next one', async () => {
    const writes = stage(t, [stored()]);

    await publish('2018');

    assert.strictEqual(writes[0].sources.eagle.legislation_2002.name, 'Mine 2002');
  });

  await t.test('naming the current year publishes without a switch', async () => {
    const writes = stage(t, [stored()]);

    const res = await publish(2002);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(writes[0].name, 'Mine 2002');
  });

  await t.test('a project under a locked Act is a 409 and no write', async () => {
    const writes = stage(t, [stored({ current: 'legislation_2025', list: [2002, 2018, 2025] })]);

    const res = await publish(2018);

    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.error, 'Project is under the Building Canada Act');
    assert.strictEqual(writes.length, 0);
  });

  await t.test('a year outside the registry is a 404', async () => {
    const writes = stage(t, [stored()]);

    const res = await publish(2019);

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(writes.length, 0);
  });

  await t.test('a year not in the project\'s list is a 409', async () => {
    const writes = stage(t, [stored({ list: [2002] })]);

    const res = await publish(2018);

    assert.strictEqual(res.statusCode, 409);
    assert.match(res.body.error, /no content under legislation year 2018/);
    assert.strictEqual(writes.length, 0);
  });

  await t.test('a listed year whose block has no name is a 409', async () => {
    const writes = stage(t, [stored({ blocks: { legislation_2018: { legislationYear: 2018 } } })]);

    const res = await publish(2018);

    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(writes.length, 0);
  });

  await t.test('a project that moved under a locked Act before the write is a 409', async () => {
    const lost = Object.assign(new Error('etag moved'), { code: 412 });
    const moved = stored({ current: 'legislation_2025', list: [2002, 2018, 2025] });
    const writes = stage(t, [stored(), moved], async () => { throw lost; });

    const res = await publish(2018);

    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(writes.length, 1, 'only the write that lost the race was sent');
  });

  await t.test('a year below level 4 is a 400', async () => {
    const writes = stage(t, [stored()]);

    const res = await publish(2018, 3);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(writes.length, 0);
  });
});
