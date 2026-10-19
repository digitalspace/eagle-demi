'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { resolveAccess } = require('../../src/helpers/access-sql');
const images = require('../../src/domain/update-images');
const { fakeImages } = require('../helpers/update-images-store');

const PARENT = 'p-1';
const OWN = '5c1f7a3e9b1d2c0012370001';
const OTHER_PROJECT = '5c1f7a3e9b1d2c0012370002';
const NOT_UPLOADED = '5c1f7a3e9b1d2c0012370003';
const SECOND = '5c1f7a3e9b1d2c0012370004';
const UPLOAD = { documentSource: 'UPDATE', projectId: PARENT };

const req = { user: { sub: 'kc-1', preferred_username: 'idir-staff', realm_access: { roles: ['staff'] } }, headers: {} };
const CTX = { access: resolveAccess(req), req };
const showingAll = (ids, read = ['public', 'staff', 'sysadmin']) => ({ read, images: ids.map(document => ({ document, alt: 'x' })) });

test('update image cascade', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('publishFor publishes only private uploads of the same parent', async (t) => {
    const store = fakeImages(t, [
      { id: OWN, level: 2, ...UPLOAD },
      { id: OTHER_PROJECT, level: 2, ...UPLOAD, projectId: 'p-2' },
      { id: NOT_UPLOADED, level: 2, documentSource: 'PROJECT', projectId: PARENT }
    ]);
    const published = await images.publishFor(CTX, showingAll([OWN, OTHER_PROJECT, NOT_UPLOADED]), PARENT);
    assert.deepStrictEqual(published.map(doc => doc.id), [OWN]);
    assert.strictEqual(store.level(OWN), 4);
    assert.strictEqual(store.level(OTHER_PROJECT), 2);
    assert.strictEqual(store.level(NOT_UPLOADED), 2);
  });

  await t.test('publishFor leaves the images of an update its parent caps below public', async (t) => {
    const store = fakeImages(t, [{ id: OWN, level: 2, ...UPLOAD }]);
    const published = await images.publishFor(CTX, showingAll([OWN], ['staff', 'sysadmin']), PARENT);
    assert.deepStrictEqual(published, []);
    assert.strictEqual(store.level(OWN), 2);
    assert.deepStrictEqual(store.copied, [], 'search index and chunks untouched');
  });

  await t.test('a failed publish reverts what it published and throws', async (t) => {
    const store = fakeImages(t, [{ id: OWN, level: 2, ...UPLOAD }, { id: SECOND, level: 2, ...UPLOAD }],
      { failPublish: SECOND });
    await assert.rejects(images.publishFor(CTX, showingAll([OWN, SECOND]), PARENT), /patch failed/);
    assert.strictEqual(store.level(OWN), 2);
  });

  await t.test('release unpublishes an upload no published update shows', async (t) => {
    const store = fakeImages(t, [{ id: OWN, level: 4, ...UPLOAD }]);
    await images.release(CTX, [OWN], 'u-1');
    assert.strictEqual(store.level(OWN), 2);
  });

  await t.test('release keeps an upload another published update still shows', async (t) => {
    const store = fakeImages(t, [{ id: OWN, level: 4, ...UPLOAD }], { showing: [showingAll([OWN])] });
    await images.release(CTX, [OWN], 'u-1');
    assert.strictEqual(store.level(OWN), 4);
  });

  await t.test('release leaves a document that was not uploaded from the Update form', async (t) => {
    const store = fakeImages(t, [{ id: NOT_UPLOADED, level: 4, documentSource: 'PROJECT', projectId: PARENT }]);
    await images.release(CTX, [NOT_UPLOADED], 'u-1');
    assert.strictEqual(store.level(NOT_UPLOADED), 4);
  });

  await t.test('release publishes back an upload a published update started showing meanwhile', async (t) => {
    const store = fakeImages(t, [{ id: OWN, level: 4, ...UPLOAD }],
      { showing: (call) => (call === 1 ? [] : [showingAll([OWN])]) });
    await images.release(CTX, [OWN], 'u-1');
    assert.strictEqual(store.level(OWN), 4);
  });

  await t.test('release never throws: the update change already stands', async (t) => {
    fakeImages(t, [{ id: OWN, level: 4, ...UPLOAD }], { showing: () => { throw new Error('query failed'); } });
    await assert.doesNotReject(images.release(CTX, [OWN], 'u-1'));
  });
});
