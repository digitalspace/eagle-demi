'use strict';

process.env.NODE_ENV = 'test';
// Before src/config is first required: the audit writer is inert without a collection rule.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../src/utils/audit');
const updates = require('../../src/repositories/updates');
const documents = require('../../src/repositories/documents');
const updateParent = require('../../src/helpers/update-parent');
const update = require('../../src/domain/updates');
const syncOut = require('../../src/sync-out');
const eagleUpdate = require('../../src/sync-out/eagle-update');
const images = require('../../src/domain/update-images');
const controller = require('../../src/controllers/nosql/update');
const { logger } = require('../../src/utils/logger');
const { fakeImages } = require('../helpers/update-images-store');
const { ctxFor } = require('../helpers/domain-ctx');
const { updatesStore } = require('../helpers/updates-store');
const { parentProject, parentNotification } = require('../helpers/update-parents');

let rows = [];
audit._setTransport(async (stream, batch) => { rows.push(...batch); });

const PUBLIC_PROJECT = '5c1f7a3e9b1d2c0012340001';
const PRIVATE_PROJECT = '5c1f7a3e9b1d2c0012340002';
const UPDATE_ID = '5c1f7a3e9b1d2c0012350001';
const PUBLIC_DOC = '5c1f7a3e9b1d2c0012360001';
const PRIVATE_DOC = '5c1f7a3e9b1d2c0012360002';
const PARENTS = {
  [PUBLIC_PROJECT]: { id: 'p-public', kind: 'project', read: ['public', 'staff', 'sysadmin'] },
  [PRIVATE_PROJECT]: { id: 'p-private', kind: 'project', read: ['staff', 'sysadmin'] }
};
const OWN_IMAGE = '5c1f7a3e9b1d2c0012370001';
// An upload from the Update form under PUBLIC_PROJECT's DEMI id (PARENTS above).
const UPLOAD = { documentSource: 'UPDATE', projectId: 'p-public' };
const PAST = '2024-01-01T00:00:00.000Z';
const STORED = Object.freeze({
  id: UPDATE_ID, eagleId: UPDATE_ID, projectId: PUBLIC_PROJECT, headline: 'Site work begins', type: 'News',
  status: 'published', active: true, pinned: false, publishDate: PAST, dateAdded: PAST, dateUpdated: PAST,
  attachments: [PRIVATE_DOC], read: ['public', 'staff', 'sysadmin'], isPublished: true, _etag: 'e1'
});
const DRAFT = Object.freeze({
  ...STORED, status: 'draft', active: false, attachments: [], read: ['staff', 'sysadmin'], isPublished: false
});

const STAFF = ctxFor(['staff']);

/** Fake storage holding `stored`, the two parents, and PUBLIC_DOC as the one public document. */
function fakeStore(t, stored = STORED) {
  const store = { written: [] };
  t.mock.method(updates, 'getById', async (access, id) => stored && id === stored.id ? { ...stored } : null);
  t.mock.method(updates, 'upsert', async (row) => { store.written.push(row); return { ...row, _etag: 'e2' }; });
  t.mock.method(updateParent, 'readParent', async (eagleId) => PARENTS[eagleId] ? { ...PARENTS[eagleId] } : null);
  t.mock.method(documents, 'listByIdsUnscoped', async (access, ids) =>
    ids.filter(id => id === PUBLIC_DOC).map(id => ({ id })));
  return store;
}

async function audited(fn) {
  await audit.flush();
  rows = [];
  const result = await fn();
  await audit.flush();
  return { result, rows };
}

const TAKEOVER_LINE = '[Update] DEMI write took over an Eagle update';

const createBody = (fields = {}) => ({ projectId: PUBLIC_PROJECT, headline: 'Open house', ...fields });

test('update domain', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.after(() => audit._resetTransport());

  await t.test('create with no status stores a staff-only DEMI draft, audited', async (t) => {
    const store = fakeStore(t, null);
    const { result, rows } = await audited(() => update.create(STAFF, createBody()));
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.created, true);
    const row = store.written[0];
    assert.strictEqual(row.status, 'draft');
    assert.deepStrictEqual(row.read, ['staff', 'sysadmin']);
    assert.strictEqual(row.isPublished, false);
    assert.strictEqual(row.sourceSystem, 'demi');
    assert.strictEqual(row.pinned, false);
    assert.strictEqual(row.addedBy, 'idir-staff');
    assert.ok(row.publishDate, 'the publish gate needs a publishDate on every row');
    assert.strictEqual(rows[0].Action, 'update.create');
    assert.strictEqual(rows[0].TargetId, row.id);
  });

  await t.test('a write queues the stored row for the update sync-out', async (t) => {
    fakeStore(t, null);
    const queued = t.mock.method(syncOut, 'enqueueQuietly', async () => []);
    const result = await update.create(STAFF, createBody());
    assert.deepStrictEqual(queued.mock.calls.map(c => [c.arguments[0].id, c.arguments[0]._etag, c.arguments[1].kind]),
      [[result.value.id, 'e2', 'update']]);
  });

  await t.test('a write is queued even when the image release after it throws', async (t) => {
    fakeStore(t, DRAFT);
    t.mock.method(images, 'release', async () => { throw new Error('release failed'); });
    const queued = t.mock.method(syncOut, 'enqueueQuietly', async () => []);
    await assert.rejects(update.update(STAFF, UPDATE_ID, { headline: 'x' }), /release failed/);
    assert.strictEqual(queued.mock.callCount(), 1);
  });

  await t.test('a write that never lands queues nothing', async (t) => {
    fakeStore(t, DRAFT);
    updates.upsert.mock.mockImplementation(async () => { throw Object.assign(new Error('etag moved'), { code: 412 }); });
    const queued = t.mock.method(syncOut, 'enqueueQuietly', async () => []);
    const result = await update.update(STAFF, UPDATE_ID, { headline: 'x' });
    assert.strictEqual(result.status, 'busy');
    assert.strictEqual(queued.mock.callCount(), 0);
  });

  await t.test('create ignores read, pinned and notifiedAt in the body', async (t) => {
    const store = fakeStore(t, null);
    const result = await update.create(STAFF, createBody({ read: ['public'], pinned: true, notifiedAt: PAST }));
    assert.strictEqual(result.status, 'ok');
    assert.deepStrictEqual(store.written[0].read, ['staff', 'sysadmin']);
    assert.strictEqual(store.written[0].pinned, false);
    assert.strictEqual(store.written[0].notifiedAt, null);
  });

  await t.test('create published with no date opens to the public and stamps publishDate now', async (t) => {
    const store = fakeStore(t, null);
    const before = new Date().toISOString();
    await update.create(STAFF, createBody({ status: 'published' }));
    const row = store.written[0];
    assert.ok(row.read.includes('public'));
    assert.strictEqual(row.active, true);
    assert.ok(row.publishDate >= before);
  });

  await t.test('create with active true and no status publishes, as eagle-api derives it', async (t) => {
    const store = fakeStore(t, null);
    await update.create(STAFF, createBody({ active: true }));
    assert.strictEqual(store.written[0].status, 'published');
  });

  await t.test('create published under a private project reads staff only', async (t) => {
    const store = fakeStore(t, null);
    await update.create(STAFF, createBody({ projectId: PRIVATE_PROJECT, status: 'published' }));
    assert.strictEqual(store.written[0].isPublished, false);
    assert.ok(!store.written[0].read.includes('public'));
  });

  await t.test('create under a project DEMI does not hold is a 400 on projectId', async (t) => {
    const store = fakeStore(t, null);
    const result = await update.create(STAFF, createBody({ projectId: '5c1f7a3e9b1d2c00123400ff' }));
    assert.strictEqual(result.status, 'invalid');
    assert.ok(result.fields.projectId);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('markup in shortHeadline is refused', async (t) => {
    fakeStore(t, null);
    const result = await update.create(STAFF, createBody({ shortHeadline: 'a <b>bold</b> claim' }));
    assert.match(result.fields.shortHeadline, /plain text/);
  });

  await t.test('a summary over 280 characters is refused', async (t) => {
    fakeStore(t, null);
    const result = await update.create(STAFF, createBody({ summary: 'x'.repeat(281) }));
    assert.ok(result.fields.summary);
  });

  await t.test('a non-http engagementUrl is refused', async (t) => {
    fakeStore(t, null);
    const result = await update.create(STAFF, createBody({ engagementUrl: 'javascript:alert(1)' }));
    assert.match(result.fields.engagementUrl, /http/);
  });

  await t.test('a Corporate update needs a subject', async (t) => {
    fakeStore(t, null);
    const result = await update.create(STAFF, { headline: 'Office news', category: 'Corporate' });
    assert.ok(result.fields.subject);
  });

  await t.test('a categorised non-Corporate update needs a project', async (t) => {
    fakeStore(t, null);
    const result = await update.create(STAFF, { headline: 'Site news', category: 'Project' });
    assert.ok(result.fields.projectId);
  });

  await t.test('six images are refused', async (t) => {
    fakeStore(t, null);
    const image = { document: PUBLIC_DOC, alt: 'A creek' };
    const result = await update.create(STAFF, createBody({ images: Array(6).fill(image) }));
    assert.match(result.fields.images, /5 or fewer/);
  });

  await t.test('an image with a document and no alt is refused', async (t) => {
    fakeStore(t, null);
    const result = await update.create(STAFF, createBody({ featuredImage: { document: PUBLIC_DOC } }));
    assert.ok(result.fields['featuredImage.alt']);
  });

  await t.test('a caption over 300 characters is refused', async (t) => {
    fakeStore(t, null);
    const image = { document: PUBLIC_DOC, alt: 'A creek', caption: 'x'.repeat(301) };
    const result = await update.create(STAFF, createBody({ images: [image] }));
    assert.ok(result.fields['images[0].caption']);
  });

  await t.test('publishing with a private attachment is refused and writes nothing', async (t) => {
    const store = fakeStore(t, null);
    const result = await update.create(STAFF, createBody({ status: 'published', attachments: [PRIVATE_DOC] }));
    assert.strictEqual(result.status, 'invalid');
    assert.match(result.fields.documents, new RegExp(PRIVATE_DOC));
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('a draft may show a private document', async (t) => {
    const store = fakeStore(t, null);
    const result = await update.create(STAFF, createBody({ attachments: [PRIVATE_DOC] }));
    assert.strictEqual(result.status, 'ok');
    assert.deepStrictEqual(store.written[0].attachments, [PRIVATE_DOC]);
  });

  await t.test('notificationName is dropped unless the type is the comment period notification', async (t) => {
    const store = fakeStore(t, null);
    await update.create(STAFF, createBody({ type: 'News', notificationName: 'PN-1' }));
    assert.strictEqual(store.written[0].notificationName, null);
  });

  await t.test('notificationName is kept on the comment period notification type', async (t) => {
    const store = fakeStore(t, null);
    await update.create(STAFF, createBody({ type: 'Project Notification Public Comment Period', notificationName: 'PN-1' }));
    assert.strictEqual(store.written[0].notificationName, 'PN-1');
  });

  await t.test('a headline edit keeps a published row published and its publishDate', async (t) => {
    const store = fakeStore(t, { ...STORED, attachments: [] });
    const result = await update.update(STAFF, UPDATE_ID, { headline: 'Site work resumes' });
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(store.written[0].status, 'published');
    assert.strictEqual(store.written[0].publishDate, PAST);
    assert.strictEqual(store.written[0].headline, 'Site work resumes');
  });

  await t.test('a null publishDate keeps the stored one', async (t) => {
    const store = fakeStore(t, { ...STORED, attachments: [] });
    await update.update(STAFF, UPDATE_ID, { headline: 'x', publishDate: null });
    assert.strictEqual(store.written[0].publishDate, PAST);
  });

  await t.test('publishing a draft with no date in the body stamps now', async (t) => {
    const store = fakeStore(t, DRAFT);
    const before = new Date().toISOString();
    await update.update(STAFF, UPDATE_ID, { status: 'published' });
    assert.ok(store.written[0].publishDate >= before);
    assert.ok(store.written[0].read.includes('public'));
  });

  await t.test('active false alone unpublishes and closes the read', async (t) => {
    const store = fakeStore(t, { ...STORED, attachments: [] });
    await update.update(STAFF, UPDATE_ID, { active: false });
    assert.strictEqual(store.written[0].status, 'draft');
    assert.deepStrictEqual(store.written[0].read, ['staff', 'sysadmin']);
  });

  await t.test('active true alone leaves an archived row archived', async (t) => {
    const store = fakeStore(t, { ...DRAFT, status: 'archived' });
    await update.update(STAFF, UPDATE_ID, { active: true });
    assert.strictEqual(store.written[0].status, 'archived');
    assert.ok(!store.written[0].read.includes('public'));
  });

  await t.test('a pin toggle on a published row skips the document check', async (t) => {
    const store = fakeStore(t);
    const result = await update.update(STAFF, UPDATE_ID, { pinned: true });
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(store.written[0].pinned, true);
  });

  await t.test('any other edit of a published row with a private document is refused', async (t) => {
    const store = fakeStore(t);
    const result = await update.update(STAFF, UPDATE_ID, { headline: 'x' });
    assert.ok(result.fields.documents);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('an _etag the row has moved past is a conflict and writes nothing', async (t) => {
    const store = fakeStore(t, DRAFT);
    const result = await update.update(STAFF, UPDATE_ID, { headline: 'x', _etag: 'e0' });
    assert.strictEqual(result.status, 'conflict');
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('the current _etag writes', async (t) => {
    const store = fakeStore(t, DRAFT);
    const result = await update.update(STAFF, UPDATE_ID, { headline: 'x', _etag: 'e1' });
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(store.written[0]._etag, 'e1', 'the guard rides on the row read, not the body');
  });

  await t.test('an empty update body is refused', async (t) => {
    fakeStore(t, DRAFT);
    const result = await update.update(STAFF, UPDATE_ID, {});
    assert.ok(result.fields.body);
  });

  await t.test('update of a missing row is not found', async (t) => {
    fakeStore(t, null);
    const result = await update.update(STAFF, UPDATE_ID, { headline: 'x' });
    assert.strictEqual(result.status, 'not-found');
  });

  await t.test('a DEMI row records its own read for itself', async (t) => {
    const store = fakeStore(t, { ...DRAFT, sourceSystem: 'demi', eagleId: null });
    await update.update(STAFF, UPDATE_ID, { projectId: PRIVATE_PROJECT, status: 'published' });
    assert.ok(store.written[0].sources.demi.read.includes('public'));
    assert.ok(!store.written[0].read.includes('public'), 'still capped by its private project');
  });

  await t.test('delete archives: status archived, inactive, public pulled, audited', async (t) => {
    const store = fakeStore(t, { ...STORED, sourceSystem: 'eagle' });
    const info = t.mock.method(logger, 'info', () => {});
    const { result, rows } = await audited(() => update.remove(STAFF, UPDATE_ID));
    assert.strictEqual(result.status, 'ok');
    const row = store.written[0];
    assert.strictEqual(row.status, 'archived');
    assert.strictEqual(row.active, false);
    assert.deepStrictEqual(row.read, ['staff', 'sysadmin']);
    assert.strictEqual(row.isPublished, false);
    assert.strictEqual(row.sourceSystem, 'demi', 'the archive takes an Eagle row over');
    assert.deepStrictEqual(row.sources.demi, { read: ['staff', 'sysadmin'], status: 'archived' });
    assert.strictEqual(rows[0].Action, 'update.archive');
    assert.strictEqual(info.mock.calls.filter(c => c.arguments[0] === TAKEOVER_LINE).length, 1);
  });

  await t.test('an edit that loses its etag race to a DEMI takeover is not logged as a takeover', async (t) => {
    fakeStore(t, { ...DRAFT, sourceSystem: 'eagle' });
    updates.getById.mock.mockImplementation(async () => ({ ...DRAFT, sourceSystem: 'demi', _etag: 'e9' }));
    updates.getById.mock.mockImplementationOnce(async () => ({ ...DRAFT, sourceSystem: 'eagle' }));
    updates.upsert.mock.mockImplementationOnce(async () => { throw Object.assign(new Error('etag moved'), { code: 412 }); });
    const info = t.mock.method(logger, 'info', () => {});
    const result = await update.update(STAFF, UPDATE_ID, { headline: 'x' });
    assert.strictEqual(result.status, 'ok', JSON.stringify(result));
    assert.strictEqual(updates.upsert.mock.callCount(), 2);
    assert.strictEqual(info.mock.calls.filter(c => c.arguments[0] === TAKEOVER_LINE).length, 0);
  });

  await t.test('listDueForNotify returns a native-published Update', async (t) => {
    const { row } = updatesStore(t, []);
    parentProject(t, { ...PARENTS[PUBLIC_PROJECT] });
    parentNotification(t, null);
    const created = await update.create(STAFF, createBody({ status: 'published' }));
    assert.strictEqual(created.status, 'ok', JSON.stringify(created));
    const id = created.value.id;

    const due = await updates.listDueForNotify(row(id).publishDate, 10);
    assert.deepStrictEqual(due.map(r => r.id), [id]);
  });

  await t.test('edit of an Eagle update takes it over and a later push keeps headline', async (t) => {
    const eagleRow = { ...STORED, attachments: [], sourceSystem: 'eagle', sources: { eagle: { read: STORED.read } } };
    const { row } = updatesStore(t, [eagleRow]);
    parentProject(t, { ...PARENTS[PUBLIC_PROJECT] });
    parentNotification(t, null);
    t.mock.method(syncOut, 'enqueueQuietly', async () => []);
    const infos = [];
    t.mock.method(logger, 'info', (msg, meta) => { infos.push({ msg, meta }); });

    const edited = await update.update(STAFF, UPDATE_ID, { headline: 'Edited in DEMI' });
    assert.strictEqual(edited.status, 'ok', JSON.stringify(edited));
    assert.strictEqual(row(UPDATE_ID).sourceSystem, 'demi');
    assert.deepStrictEqual(row(UPDATE_ID).sources.demi, { read: ['public', 'staff', 'sysadmin'], status: 'published' });
    assert.strictEqual(eagleUpdate.wants(row(UPDATE_ID)), true, 'sync-out sends the taken-over row');
    assert.deepStrictEqual(infos.filter(i => i.msg === TAKEOVER_LINE).map(i => i.meta),
      [{ id: UPDATE_ID, eagleId: UPDATE_ID }]);

    const pushed = await controller.mirrorFromEagle(UPDATE_ID, {
      _id: UPDATE_ID, headline: 'Edited in Eagle', project: PUBLIC_PROJECT, status: 'published', active: true,
      read: ['public', 'staff', 'sysadmin']
    });
    assert.ok(pushed.saved, JSON.stringify(pushed));
    assert.strictEqual(row(UPDATE_ID).headline, 'Edited in DEMI');
    assert.strictEqual(row(UPDATE_ID).sources.eagle.headline, 'Edited in Eagle');

    infos.length = 0;
    const again = await update.update(STAFF, UPDATE_ID, { headline: 'Edited again' });
    assert.strictEqual(again.status, 'ok', JSON.stringify(again));
    assert.ok(!infos.some(i => i.msg.startsWith('[Update] DEMI write took over')), 'a DEMI row is not taken over twice');
  });

  await t.test('publishing with its own private upload passes and publishes the image', async (t) => {
    fakeStore(t, null);
    const images = fakeImages(t, [{ id: OWN_IMAGE, level: 2, ...UPLOAD }]);
    const result = await update.create(STAFF, createBody({ status: 'published', featuredImage: { document: OWN_IMAGE, alt: 'A creek' } }));
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(images.level(OWN_IMAGE), 4);
  });

  await t.test('publishing under a private project leaves its own upload private', async (t) => {
    const store = fakeStore(t, null);
    const images = fakeImages(t, [{ id: OWN_IMAGE, level: 2, documentSource: 'UPDATE', projectId: 'p-private' }]);
    const result = await update.create(STAFF, createBody({
      projectId: PRIVATE_PROJECT, status: 'published', featuredImage: { document: OWN_IMAGE, alt: 'A creek' }
    }));
    assert.strictEqual(result.status, 'ok');
    assert.ok(!store.written[0].read.includes('public'));
    assert.strictEqual(images.level(OWN_IMAGE), 2);
    assert.deepStrictEqual(images.copied, [], 'search index and chunks untouched');
  });

  await t.test('an edit of a published update its project caps releases every image it shows', async (t) => {
    const second = '5c1f7a3e9b1d2c0012370009';
    const upload = { documentSource: 'UPDATE', projectId: 'p-private' };
    fakeStore(t, {
      ...STORED, projectId: PRIVATE_PROJECT, attachments: [], read: ['staff', 'sysadmin'], isPublished: false,
      featuredImage: { document: OWN_IMAGE, alt: 'a' }, images: [{ document: second, alt: 'b' }]
    });
    const images = fakeImages(t, [{ id: OWN_IMAGE, level: 4, ...upload }, { id: second, level: 4, ...upload }]);
    documents.listByIdsUnscoped.mock.mockImplementation(async (access, ids) => ids.map(id => ({ id })));
    const result = await update.update(STAFF, UPDATE_ID, { headline: 'Moved' });
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(images.level(OWN_IMAGE), 2);
    assert.strictEqual(images.level(second), 2);
  });

  await t.test('a save that fails puts the image it published back', async (t) => {
    fakeStore(t, null);
    updates.upsert.mock.mockImplementation(async () => { throw new Error('cosmos down'); });
    const images = fakeImages(t, [{ id: OWN_IMAGE, level: 2, ...UPLOAD }]);
    await assert.rejects(update.create(STAFF, createBody({ status: 'published', images: [{ document: OWN_IMAGE, alt: 'A creek' }] })));
    assert.strictEqual(images.level(OWN_IMAGE), 2);
  });

  await t.test('a live update that drops an image releases that one only', async (t) => {
    const kept = '5c1f7a3e9b1d2c0012370009';
    fakeStore(t, { ...STORED, attachments: [], images: [{ document: OWN_IMAGE, alt: 'a' }, { document: kept, alt: 'b' }] });
    const images = fakeImages(t, [{ id: OWN_IMAGE, level: 4, ...UPLOAD }, { id: kept, level: 4, ...UPLOAD }]);
    documents.listByIdsUnscoped.mock.mockImplementation(async (access, ids) => ids.map(id => ({ id })));
    const result = await update.update(STAFF, UPDATE_ID, { images: [{ document: kept, alt: 'b' }] });
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(images.level(OWN_IMAGE), 2);
    assert.strictEqual(images.level(kept), 4);
  });

  await t.test('delete releases the archived update\'s image', async (t) => {
    fakeStore(t, { ...STORED, attachments: [], featuredImage: { document: OWN_IMAGE, alt: 'a' } });
    const images = fakeImages(t, [{ id: OWN_IMAGE, level: 4, ...UPLOAD }]);
    await update.remove(STAFF, UPDATE_ID);
    assert.strictEqual(images.level(OWN_IMAGE), 2);
  });

  await t.test('delete of a missing row is not found', async (t) => {
    fakeStore(t, null);
    const result = await update.remove(STAFF, UPDATE_ID);
    assert.strictEqual(result.status, 'not-found');
  });
});
