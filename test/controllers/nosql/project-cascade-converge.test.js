'use strict';

/**
 * A project row that moves while a level change or its cascade is in flight. Each writer that
 * moves the level must cascade the level it wrote, and a cascade must end on the stored level.
 */

process.env.NODE_ENV = 'test';
// Before src/config loads: the audit writer is inert without the DCR pair, and a batch of 1 sends each row at once.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';
process.env.AUDIT_MAX_BATCH = '1';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../../src/utils/audit');
const projects = require('../../../src/repositories/projects');
const documents = require('../../../src/repositories/documents');
const commentPeriods = require('../../../src/repositories/comment-periods');
const aiSearch = require('../../../src/search/ai-search');
const updateAcl = require('../../../src/helpers/update-acl');
const projectController = require('../../../src/controllers/nosql/project');
const { logger } = require('../../../src/utils/logger');
const { readForLevel } = require('../../../src/helpers/access-sql');
const {
  mockRes, STAFF, PROJECT_EAGLE_ID, PUBLIC_ACL, PRIVATE_ACL, storedEagleProject
} = require('../../helpers/eagle-mirror-fixtures');

const ETAG_READ = '"0x8DC1"';
const ETAG_LANDED = '"0x8DC2"';
const STAFF_ONLY = { sub: 'kc-2', preferred_username: 'staff.person', realm_access: { roles: ['staff'] } };

const lostRace = () => Object.assign(new Error('lost its etag race'), { code: 412 });
const atLevel2 = (etag) => storedEagleProject({ _etag: etag, isPublished: false, read: [...PRIVATE_ACL] });
const atLevel4 = (etag) => storedEagleProject({ _etag: etag });

let auditRows = [];
audit._setTransport(async (_stream, batch) => { auditRows.push(...batch); });

/**
 * `getById` answers `reads` in turn, the first `losses` upserts 412, and the convergence read
 * answers `stored` (default: whatever the last upsert landed). Returns what each writer was asked.
 */
function race(t, { reads = [], losses = 0, stored, failDocumentsOnce = false } = {}) {
  auditRows = [];
  let read = 0;
  let landed = null;
  const upserted = [];
  const cascaded = [];
  t.mock.method(projects, 'getById', async () => reads[Math.min(read++, reads.length - 1)]);
  t.mock.method(projects, 'upsert', async (item, options) => {
    upserted.push({ item, options });
    if (upserted.length <= losses) throw lostRace();
    landed = item;
    return item;
  });
  t.mock.method(projects, 'readForWrite', async () => (stored === undefined ? landed : stored));
  t.mock.method(aiSearch, 'writeAcls', async (_index, rows) => rows.length);
  t.mock.method(documents, 'setAclForProject', async (_access, projectId, docRead) => {
    cascaded.push(docRead);
    if (failDocumentsOnce && cascaded.length === 1) throw new Error('documents container busy');
    return { succeeded: 0, failed: 0, rows: [] };
  });
  t.mock.method(commentPeriods, 'setAclForProject', async () => ({ succeeded: 0, failed: 0, rows: [] }));
  t.mock.method(updateAcl, 'setAclForProject', async () => ({ succeeded: 0, failed: 0 }));
  for (const level of ['info', 'warn', 'error']) t.mock.method(logger, level, () => {});
  return { upserted, cascaded };
}

const setLevel = (user, body) => projectController.setLevel({ params: { id: '207' }, query: {}, user, body }, mockRes());

test('a level change retried after a race judges and cascades from the row that won', async (t) => {
  // Read at 2, opened to 4 by another request, then this retry writes 2 back over it: the
  // documents that request opened stay public unless this write cascades its own level.
  t.afterEach(() => t.mock.restoreAll());
  const { upserted, cascaded } = race(t, { reads: [atLevel2(ETAG_READ), atLevel4(ETAG_LANDED)], losses: 1 });

  const res = await setLevel(STAFF, { level: 2 });

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(upserted[1].options.etag, ETAG_LANDED);
  assert.deepStrictEqual(cascaded, [readForLevel(2)], 'the retry moved the level, so it owes the cascade');
  const [row] = auditRows;
  assert.deepStrictEqual([row.Action, row.Detail.from], ['record.takedown', 4]);
});

test('a staff level change that finds level 4 on its retry is refused, not written', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const { upserted, cascaded } = race(t, { reads: [atLevel2(ETAG_READ), atLevel4(ETAG_LANDED)], losses: 1 });

  const res = await setLevel(STAFF_ONLY, { level: 2 });

  assert.strictEqual(res.statusCode, 403);
  assert.deepStrictEqual(res.body,
    { error: 'Only sysadmin may pull a record back from level 4. See docs/takedown-runbook.md.' });
  assert.strictEqual(upserted.length, 1, 'only the attempt that lost its race was sent');
  assert.deepStrictEqual(cascaded, []);
});

test('a cascade whose project closed under it runs again with the stored read', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const closed = atLevel2(ETAG_LANDED);
  const { cascaded } = race(t, { stored: closed, failDocumentsOnce: true });
  const pending = [];
  t.mock.method(projects, 'patchCascadePending', async (...args) => { pending.push(args); });

  const failure = await projectController.runCascade(atLevel4(ETAG_READ), PROJECT_EAGLE_ID);

  assert.deepStrictEqual(cascaded, [PUBLIC_ACL, PRIVATE_ACL]);
  assert.strictEqual(failure, null, 'the second pass re-derives every row, so its result is the answer');
  assert.deepStrictEqual(pending, []);
});

test('the owed-cascade marker lands on a row that moved since the write', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  race(t, { stored: atLevel4(ETAG_LANDED) });
  t.mock.method(aiSearch, 'writeAcls', async () => { throw new Error('search is down'); });
  const etags = [];
  t.mock.method(projects, 'patchCascadePending', async (id, at, etag) => {
    etags.push(etag);
    if (etags.length === 1) throw lostRace();
  });

  const failure = await projectController.runCascade(atLevel4(ETAG_READ), PROJECT_EAGLE_ID);

  assert.ok(failure);
  assert.deepStrictEqual(etags, [ETAG_READ, ETAG_LANDED], 'owing a cascade is never wrong, so the 412 is retried once');
});
