'use strict';

/** `PUT /projects/:id` never moves a project off a locked Act (eagle-api `project.js:628-631,743-754`). */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../../src/utils/audit');
const projects = require('../../../src/repositories/projects');
const projectController = require('../../../src/controllers/nosql/project');
const { mockRes } = require('../../helpers/eagle-mirror-fixtures');
const { deriveAssessments } = require('../../../src/merge/assessments');
const fx = require('../../fixtures/act-assessments');

audit._setTransport(async () => {});

const WRITER = { realm_access: { roles: ['demi-service-write'] } };

const put = async (body) => {
  const res = mockRes();
  await projectController.updateProject({ params: { id: '207' }, query: {}, user: WRITER, body }, res);
  return res;
};

const ROW = { id: '207', trackProjectId: 207, name: 'Site C', _etag: '"0x1"' };
const UNDER_BCA = { ...ROW, legislationYear: 2025, legislation: 'Building Canada Act' };
const UNDER_2002 = { ...ROW, legislationYear: 2002, legislation: '2002 Environmental Assessment Act' };

/** Serve `reads` in order, one per getById; capture every upsert. */
function stage(t, reads, upsert = async (doc) => doc) {
  let read = 0;
  t.mock.method(projects, 'getById', async () => structuredClone(reads[Math.min(read++, reads.length - 1)]));
  const writes = [];
  t.mock.method(projects, 'upsert', async (doc) => { writes.push(doc); return upsert(doc, writes.length); });
  return writes;
}

test('PUT /projects/:id locked Act', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('another year on a locked Act is a 409 and no write', async () => {
    const writes = stage(t, [UNDER_BCA]);

    const res = await put({ legislationYear: 2018 });

    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.error, 'Project is under the Building Canada Act');
    assert.strictEqual(writes.length, 0);
  });

  await t.test('an edit that keeps the locked Act saves', async () => {
    const writes = stage(t, [UNDER_BCA]);

    const res = await put({ name: 'Site C Clean Energy', legislationYear: '2025' });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(writes[0].name, 'Site C Clean Energy');
  });

  await t.test('an unlocked project may move to another year', async () => {
    const writes = stage(t, [UNDER_2002]);

    const res = await put({ legislationYear: 2018 });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(writes[0].legislationYear, 2018);
  });

  await t.test('a GET body sent back keeps the stored legislation blocks and current year', async () => {
    const withBlocks = { ...UNDER_2002, currentLegislationYear: 'legislation_2002', legislation_2002: { name: 'Site C' } };
    const writes = stage(t, [withBlocks]);

    const res = await put({ name: 'Site C', currentLegislationYear: 'legislation_2018', legislation_2002: { name: 'Other' } });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual([writes[0].currentLegislationYear, writes[0].legislation_2002.name], ['legislation_2002', 'Site C']);
  });

  await t.test('a project that moved under a locked Act before the write is a 409', async () => {
    const lost = Object.assign(new Error('etag moved'), { code: 412 });
    const writes = stage(t, [UNDER_2002, UNDER_BCA], async () => { throw lost; });

    const res = await put({ legislationYear: 2018 });

    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(writes.length, 1, 'only the write that lost the race was sent');
  });
});

test('PUT /projects/:id derived fields', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const stored = () => {
    const row = { ...fx.only2002(), _etag: '"0x1"' };
    return Object.assign(row, deriveAssessments(row));
  };

  await t.test('the write carries assessments and phase ids derived from the changed row', async () => {
    const writes = stage(t, [stored()]);
    const referral = { _id: fx.PHASES.referral.id, name: fx.PHASES.referral.name };

    const res = await put({ eaCertificate: 'E10-02', currentPhaseName: referral });

    assert.strictEqual(res.statusCode, 200);
    const [written] = writes;
    assert.strictEqual(written.assessments[0].certificate.number, 'E10-02',
      'the stored copy still named E10-01');
    assert.ok(written.phaseIds.includes(fx.PHASES.referral.id));
  });

  for (const key of ['assessments', 'phaseIds', 'activeWork', 'documentPhases']) {
    await t.test(`a body setting ${key} is refused and writes nothing`, async () => {
      const writes = stage(t, [stored()]);

      const res = await put({ name: 'Valley Mine', [key]: [] });

      assert.strictEqual(res.statusCode, 400);
      assert.match(res.body.error, new RegExp(key));
      assert.strictEqual(writes.length, 0);
    });
  }
});
