'use strict';

process.env.NODE_ENV = 'test';
// Before src/config is first required: without both the audit writer records nothing.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../../src/utils/audit');
const { logger } = require('../../../src/utils/logger');
const projects = require('../../../src/repositories/projects');
const inspections = require('../../../src/repositories/inspections');
const { upsertInspectionFromEagle } = require('../../../src/controllers/nosql/inspection');
const {
  MIRRORS, captureMirror, storedStamped, storedProject, eagleInspection, mockRes, STAFF, INSPECTION_EAGLE_ID
} = require('../../helpers/eagle-mirror-fixtures');

const OLDER = 1757980000000;
const NEWER = 1757980005000;

let rows = [];
audit._setTransport(async (stream, batch) => {
  if (stream === audit.AUDIT_STREAM) rows.push(...batch);
});
test.after(() => audit._resetTransport());

async function auditRowsOf(fn) {
  rows = [];
  const result = await fn();
  await audit.flush();
  return { ...result, rows };
}

const published = (row, eagleId) => ({ eagleId, isPublishedFrom: false, isPublishedTo: row.isPublished });
const deleted = (row, eagleId) => ({ eagleId, isDeleted: row.isDeleted });

const KINDS = [
  ['lists', 'organization.push', 'organization', false, published],
  ['notifications', 'notification.push', 'notification', false, published],
  ['users', 'user.push', 'user', false, deleted],
  ['groups', 'group.push', 'group', true, deleted],
  ['updates', 'update.push', 'update', true, published],
  ['comments', 'comment.push', 'comment', true,
    (row, eagleId) => ({ eagleId, periodId: row.periodId, isPublishedFrom: false, isPublishedTo: row.isPublished })],
  ['inspections', 'inspections.push', 'inspections', true,
    (row, eagleId) => ({ eagleId, inspection: row.inspection, isDeleted: row.isDeleted })]
];

test('each push audits its own action and detail, with a project only on project-scoped kinds', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  for (const [entity, action, targetType, scoped, detail] of KINDS) {
    await t.test(entity, async () => {
      const { eagleId } = MIRRORS[entity];
      const stored = { ...storedStamped(entity, OLDER), isPublished: false };

      const written = await auditRowsOf(() => captureMirror(t, entity, null, { existing: stored, pushedAt: NEWER }));
      assert.strictEqual(written.res.statusCode, 200);
      assert.strictEqual(written.rows.length, 1);
      const [row] = written.rows;
      assert.deepStrictEqual(
        { Action: row.Action, Outcome: row.Outcome, TargetType: row.TargetType, TargetId: row.TargetId },
        { Action: action, Outcome: 'success', TargetType: targetType, TargetId: eagleId });
      assert.strictEqual(row.ProjectId, scoped ? String(written.row.projectId) : '');
      assert.deepStrictEqual(row.Detail, detail(written.row, eagleId));

      const stale = await auditRowsOf(() => captureMirror(t, entity, null,
        { existing: storedStamped(entity, NEWER), pushedAt: OLDER }));
      assert.deepStrictEqual(stale.rows.map(r => [r.Action, r.Outcome, r.ProjectId]),
        [[action, 'ignored', scoped ? '207' : '']]);
    });
  }
});

test('a failed push is logged under its own controller name', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  for (const [entity, action] of KINDS) {
    await t.test(entity, async () => {
      const logged = [];
      t.mock.method(logger, 'error', (message) => logged.push(message));
      const { res } = await captureMirror(t, entity, null, { existing: new Error('read failed') });
      assert.strictEqual(res.statusCode, 500);
      const name = action === 'inspections.push' ? 'inspection' : action.split('.')[0];
      assert.deepStrictEqual(logged, [`${name} controller failed`]);
    });
  }
});

test('an inspection whose cascade fails answers 500 after its push is audited', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(projects, 'getByEagleId', async () => storedProject());
  t.mock.method(inspections, 'readForWrite', async () => ({
    id: INSPECTION_EAGLE_ID, inspection: INSPECTION_EAGLE_ID, projectId: '207', read: ['sysadmin']
  }));
  t.mock.method(inspections, 'upsert', async (item) => item);
  t.mock.method(inspections, 'setAclForInspection', async () => ({ succeeded: 1, failed: 2 }));
  t.mock.method(logger, 'error', () => {});

  const res = mockRes();
  const { rows: audited } = await auditRowsOf(() => upsertInspectionFromEagle(
    { params: { eagleId: INSPECTION_EAGLE_ID }, query: {}, user: STAFF, body: { doc: eagleInspection() } }, res));

  assert.strictEqual(res.statusCode, 500);
  assert.deepStrictEqual(res.body, { error: `ACL cascade failed for 2 row(s) under ${INSPECTION_EAGLE_ID}` });
  assert.deepStrictEqual(audited.map(r => r.Action), ['inspections.push']);
});
