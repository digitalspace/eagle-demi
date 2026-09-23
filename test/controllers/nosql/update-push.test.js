'use strict';

/**
 * The Updates mirror — `PUT /eagle/updates/:eagleId`.
 *
 * Two invariants, both silent when they break because the push still answers 200: the stored row
 * keeps the notification claim across an upsert (Cosmos REPLACES the item), and eagle-notify hears
 * about a publication exactly once. The claim is what makes "once" true, so most of this file is
 * about who holds it.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../../src/db/cosmos-nosql');
const updates = require('../../../src/repositories/updates');
const projects = require('../../../src/repositories/projects');
const notifications = require('../../../src/repositories/notifications');
const notify = require('../../../src/services/notify');
const documents = require('../../../src/repositories/documents');
const { logger } = require('../../../src/utils/logger');
const controller = require('../../../src/controllers/nosql/update');
const { routeChains } = require('../../helpers/router-source');

const {
  UPDATE_EAGLE_ID, PROJECT_EAGLE_ID, PERIOD_EAGLE_ID, NOTIFICATION_EAGLE_ID,
  PRIVATE_ACL: PRIVATE, eagleUpdate, mockRes, STAFF
} = require('../../helpers/eagle-mirror-fixtures');

function push(body, res = mockRes()) {
  return controller.upsertFromEagle(
    { params: { eagleId: UPDATE_EAGLE_ID }, query: {}, body, user: STAFF }, res
  ).then(() => res);
}

/**
 * The mirror with eagle-notify wired up: every claim, send and mark is recorded, no HTTP happens.
 * A granted claim answers the row the test's own `upsert` mock last wrote, as Cosmos answers the
 * patched row.
 */
function wiredNotify(t, {
  claim = null, outcome = notify.OUTCOME.SENT, cancelOutcome = notify.OUTCOME.SENT, publicDocs = []
} = {}) {
  const seen = { claims: [], marks: [], published: [], cancelled: [] };
  t.mock.method(notify, 'configured', () => true);
  t.mock.method(updates, 'claimForNotify', async (id, now) => {
    seen.claims.push({ id, now });
    if (claim) return claim();
    const written = updates.upsert.mock ? updates.upsert.mock.calls.at(-1).arguments[0] : { id };
    return { ...written, notifiedAt: now, notifyAttempts: 1 };
  });
  t.mock.method(updates, 'markNotify', async (id, mark, at) => { seen.marks.push({ id, mark, at }); });
  t.mock.method(documents, 'getById', async (access, id) => {
    assert.strictEqual(access.authenticated, false, 'the image is checked as an anonymous reader');
    return publicDocs.includes(id) ? { id } : null;
  });
  t.mock.method(notify, 'updatePublished', async (item, projectName, image) => {
    seen.published.push({ item, projectName, image });
    return outcome;
  });
  t.mock.method(notify, 'updateCancelled', async (item) => { seen.cancelled.push(item); return cancelOutcome; });
  return seen;
}

/** A row DEMI claimed and emailed. */
const EMAILED = {
  notifiedAt: '2026-08-01T12:00:00.000Z', notifiedBy: 'demi', notifyClaimedAt: '2026-08-01T12:00:00.000Z',
  notifySentAt: '2026-08-01T12:00:01.000Z', notifyAttempts: 1
};

test('PUT /eagle/updates/:eagleId', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('the raw Eagle record is stored as an update row', async () => {
    t.mock.method(updates, 'getById', async () => null);
    let written;
    t.mock.method(updates, 'upsert', async (item) => { written = item; return item; });

    const res = await push({ doc: eagleUpdate() });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { id: UPDATE_EAGLE_ID, action: 'upsert' });
    assert.deepStrictEqual(written, {
      id: UPDATE_EAGLE_ID,
      eagleId: UPDATE_EAGLE_ID,
      projectId: PROJECT_EAGLE_ID,
      headline: 'Public comment period opens',
      content: '<p>The comment period opens on Monday.</p>',
      type: 'News',
      pinned: false,
      dateAdded: '2026-08-01T00:00:00.000Z',
      dateUpdated: '2026-08-02T00:00:00.000Z',
      notificationName: 'Nicomen Wind Energy',
      contentUrl: 'https://projects.eao.gov.bc.ca/p/588511d0aaecd9001b825604/news',
      documentUrl: 'https://projects.eao.gov.bc.ca/api/document/5cf00c03a266b7e187750002/fetch',
      // Both flattened to ids by `refId`, whichever shape the push carried them in.
      pcp: PERIOD_EAGLE_ID,
      projectNotification: NOTIFICATION_EAGLE_ID,
      // An old row carries none of the Updates fields; each lands empty rather than absent.
      category: null,
      subject: null,
      shortHeadline: null,
      summary: null,
      featuredImage: null,
      attachments: [],
      regions: [],
      location: null,
      engagementUrl: null,
      status: null,
      // Filled from dateAdded: the gate and every sort on it read publishDate alone.
      publishDate: '2026-08-01T00:00:00.000Z',
      active: true,
      isPublished: true,
      read: ['public', 'sysadmin', 'staff'],
      notifiedAt: null,
      notifiedBy: null,
      notifyClaimedAt: null,
      notifySentAt: null,
      notifyFailedAt: null,
      notifyCancelledAt: null,
      notifyAttempts: 0,
      sources: { eagle: eagleUpdate() }
    });
  });

  await t.test('an update with no project is site-wide, not orphaned', async () => {
    t.mock.method(updates, 'getById', async () => null);
    let written;
    t.mock.method(updates, 'upsert', async (item) => { written = item; return item; });

    await push({ doc: eagleUpdate({ project: null, active: false, read: PRIVATE }) });

    assert.strictEqual(written.projectId, null);
    assert.strictEqual(written.isPublished, false, 'no public in read[] is unpublished');
  });

  await t.test('the Updates fields are stored, references flattened and dates normalised', async () => {
    t.mock.method(updates, 'getById', async () => null);
    let written;
    t.mock.method(updates, 'upsert', async (item) => { written = item; return item; });

    await push({ doc: eagleUpdate({
      category: 'Engagement',
      subject: 'Policy',
      shortHeadline: 'Comment period opens',
      summary: 'Have your say on the project.',
      featuredImage: { document: { _id: 'D-img' }, alt: 'Site map' },
      attachments: ['D-1', { _id: 'D-2' }],
      regions: ['Lower Mainland'],
      location: 'Merritt',
      engagementUrl: 'https://engage.eao.gov.bc.ca/nicomen',
      status: 'published',
      publishDate: '2026-08-01T09:00:00-07:00'
    }) });

    assert.strictEqual(written.category, 'Engagement');
    assert.strictEqual(written.subject, 'Policy');
    assert.strictEqual(written.shortHeadline, 'Comment period opens');
    assert.strictEqual(written.summary, 'Have your say on the project.');
    assert.deepStrictEqual(written.featuredImage, { document: 'D-img', alt: 'Site map' });
    assert.deepStrictEqual(written.attachments, ['D-1', 'D-2']);
    assert.deepStrictEqual(written.regions, ['Lower Mainland']);
    assert.strictEqual(written.location, 'Merritt');
    assert.strictEqual(written.engagementUrl, 'https://engage.eao.gov.bc.ca/nicomen');
    assert.strictEqual(written.status, 'published');
    // UTC ISO text: the publish gate compares it as a string.
    assert.strictEqual(written.publishDate, '2026-08-01T16:00:00.000Z');
  });

  await t.test('an engagementUrl that is not http(s) is dropped', async () => {
    t.mock.method(updates, 'getById', async () => null);
    let written;
    t.mock.method(updates, 'upsert', async (item) => { written = item; return item; });

    await push({ doc: eagleUpdate({ engagementUrl: 'javascript:alert(1)' }) });

    assert.strictEqual(written.engagementUrl, null);
  });

  await t.test('Eagle\'s notifiedAt marks a first push as already announced', async () => {
    t.mock.method(updates, 'getById', async () => null);
    let written;
    t.mock.method(updates, 'upsert', async (item) => { written = item; return item; });

    await push({ doc: eagleUpdate({ notifiedAt: '2026-08-01T00:00:00.000Z' }) });

    // The claim the send-once patch checks: held, so neither this push nor the timer can take it.
    assert.strictEqual(written.notifiedAt, '2026-08-01T00:00:00.000Z');
  });

  await t.test('DEMI\'s own claim wins over Eagle\'s notifiedAt', async () => {
    t.mock.method(updates, 'getById', async () => ({
      id: UPDATE_EAGLE_ID, isPublished: true, notifiedAt: '2026-09-01T12:00:00.000Z',
      sources: { eagle: {} }
    }));
    let written;
    t.mock.method(updates, 'upsert', async (item) => { written = item; return item; });

    await push({ doc: eagleUpdate({ notifiedAt: '2026-08-01T00:00:00.000Z' }) });

    assert.strictEqual(written.notifiedAt, '2026-09-01T12:00:00.000Z');
  });

  await t.test('a scheduled update is not announced before its publishDate', async () => {
    t.mock.method(updates, 'getById', async () => null);
    t.mock.method(updates, 'upsert', async (item) => item);
    const seen = wiredNotify(t);

    await push({ doc: eagleUpdate({ status: 'published', publishDate: '2999-01-01T00:00:00.000Z' }) });

    assert.deepStrictEqual(seen.claims, [], 'no claim, so the go-live push can still announce');
    assert.deepStrictEqual(seen.published, []);
  });

  await t.test('a published update whose publishDate has passed is announced', async () => {
    t.mock.method(updates, 'getById', async () => null);
    t.mock.method(updates, 'upsert', async (item) => item);
    t.mock.method(projects, 'getByEagleId', async () => ({ id: '207', name: 'Nicomen Wind Energy' }));
    const seen = wiredNotify(t);

    await push({ doc: eagleUpdate({ status: 'published', publishDate: '2026-08-01T00:00:00.000Z' }) });

    assert.strictEqual(seen.published.length, 1);
  });

  await t.test('the notification claim survives an upsert', async () => {
    // Cosmos REPLACES the item, so without this every push of a published update re-notifies.
    t.mock.method(updates, 'getById', async () => ({
      id: UPDATE_EAGLE_ID, isPublished: true, notifiedAt: '2026-08-01T12:00:00.000Z',
      sources: { eagle: {} }
    }));
    let written;
    t.mock.method(updates, 'upsert', async (item) => { written = item; return item; });

    await push({ doc: eagleUpdate() });

    assert.strictEqual(written.notifiedAt, '2026-08-01T12:00:00.000Z');
  });

  await t.test('a publication is announced once, with the project name', async () => {
    t.mock.method(updates, 'getById', async () => null);
    t.mock.method(updates, 'upsert', async (item) => item);
    t.mock.method(projects, 'getByEagleId', async () => ({ id: '207', name: 'Nicomen Wind Energy' }));
    const seen = wiredNotify(t);

    const res = await push({ doc: eagleUpdate() });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(seen.claims.length, 1);
    assert.strictEqual(seen.claims[0].id, UPDATE_EAGLE_ID);
    assert.match(seen.claims[0].now, /^\d{4}-\d{2}-\d{2}T/);
    assert.strictEqual(seen.published.length, 1);
    assert.strictEqual(seen.published[0].projectName, 'Nicomen Wind Energy');
    assert.strictEqual(seen.published[0].item.id, UPDATE_EAGLE_ID);
    assert.deepStrictEqual(seen.marks,
      [{ id: UPDATE_EAGLE_ID, mark: 'notifySentAt', at: seen.claims[0].now }]);
  });

  // Same parent precedence as the mirrors: an update whose `projectId` is really a
  // ProjectNotification _id must not be labelled with the Track project that carries that id in
  // `eagleId` — subscribers would be told about a project the update is not under.
  await t.test('an update under a notification is announced with the notification name', async () => {
    t.mock.method(updates, 'getById', async () => null);
    t.mock.method(updates, 'upsert', async (item) => item);
    t.mock.method(projects, 'getByEagleId', async () => ({ id: '353', name: 'Shadow Track Project' }));
    t.mock.method(notifications, 'getById', async () =>
      ({ id: NOTIFICATION_EAGLE_ID, name: 'Sunny Ridge Quarry' }));
    const seen = wiredNotify(t);

    await push({ doc: eagleUpdate({ project: NOTIFICATION_EAGLE_ID }) });

    assert.strictEqual(seen.published[0].projectName, 'Sunny Ridge Quarry');
  });

  await t.test('a project-less update is announced with no project name', async () => {
    t.mock.method(updates, 'getById', async () => null);
    t.mock.method(updates, 'upsert', async (item) => item);
    t.mock.method(projects, 'getByEagleId', async () => { throw new Error('must not be looked up'); });
    const seen = wiredNotify(t);

    await push({ doc: eagleUpdate({ project: null }) });

    assert.strictEqual(seen.published.length, 1);
    assert.strictEqual(seen.published[0].projectName, null);
  });

  await t.test('a second push of the same active update announces nothing', async () => {
    // The claim is already held, so claimForNotify answers null (Cosmos 412) rather than patching.
    t.mock.method(updates, 'getById', async () => ({
      id: UPDATE_EAGLE_ID, isPublished: true, notifiedAt: '2026-08-01T12:00:00.000Z'
    }));
    t.mock.method(updates, 'upsert', async (item) => item);
    const seen = wiredNotify(t, { claim: () => null });

    const res = await push({ doc: eagleUpdate({ headline: 'Edited headline' }) });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(seen.claims.length, 1, 'the claim is attempted');
    assert.deepStrictEqual(seen.published, [], 'and refused, so nothing is sent');
  });

  await t.test('a refused send (4xx) keeps the claim and records the refusal', async () => {
    t.mock.method(updates, 'getById', async () => null);
    t.mock.method(updates, 'upsert', async (item) => item);
    t.mock.method(projects, 'getByEagleId', async () => ({ id: '207', name: 'Nicomen Wind Energy' }));
    const seen = wiredNotify(t, { outcome: notify.OUTCOME.REJECTED });

    const res = await push({ doc: eagleUpdate() });

    assert.strictEqual(res.statusCode, 200, 'a notification failure never fails the mirror');
    assert.deepStrictEqual(seen.marks.map(m => m.mark), ['notifyFailedAt'],
      'recorded, so no later tick retries a body eagle-notify refused');
  });

  await t.test('a send with no answer keeps the claim unmarked, for the timer to retry', async () => {
    t.mock.method(updates, 'getById', async () => null);
    t.mock.method(updates, 'upsert', async (item) => item);
    t.mock.method(projects, 'getByEagleId', async () => null);
    const seen = wiredNotify(t, { outcome: notify.OUTCOME.FAILED });

    await push({ doc: eagleUpdate() });

    assert.strictEqual(seen.published.length, 1);
    assert.deepStrictEqual(seen.marks, []);
  });

  await t.test('the third send with no answer is logged as given up', async () => {
    t.mock.method(updates, 'getById', async () => null);
    t.mock.method(updates, 'upsert', async (item) => item);
    t.mock.method(projects, 'getByEagleId', async () => null);
    const errors = [];
    t.mock.method(logger, 'error', (msg) => { errors.push(msg); });
    wiredNotify(t, {
      outcome: notify.OUTCOME.FAILED,
      claim: () => ({ id: UPDATE_EAGLE_ID, isPublished: true, notifyAttempts: 3 })
    });

    await push({ doc: eagleUpdate() });

    assert.deepStrictEqual(errors, ['[Update Controller] notify gave up']);
  });

  await t.test('the featured image goes out only when an anonymous reader can fetch it', async () => {
    t.mock.method(updates, 'getById', async () => null);
    t.mock.method(updates, 'upsert', async (item) => item);
    t.mock.method(projects, 'getByEagleId', async () => null);
    const image = { document: '5cf00c03a266b7e187750001', alt: 'The site' };

    let seen = wiredNotify(t, { publicDocs: [image.document] });
    await push({ doc: eagleUpdate({ featuredImage: image }) });
    assert.deepStrictEqual(seen.published[0].image, image);

    t.mock.restoreAll();
    t.mock.method(updates, 'getById', async () => null);
    t.mock.method(updates, 'upsert', async (item) => item);
    t.mock.method(projects, 'getByEagleId', async () => null);
    seen = wiredNotify(t, { publicDocs: [] });
    await push({ doc: eagleUpdate({ featuredImage: image }) });
    assert.strictEqual(seen.published[0].image, null, 'a non-public image would link a 404');
  });

  await t.test('withdrawing an update DEMI emailed sends one cancellation and keeps the claim', async () => {
    t.mock.method(updates, 'getById', async () => ({ id: UPDATE_EAGLE_ID, isPublished: true, ...EMAILED }));
    let written;
    t.mock.method(updates, 'upsert', async (item) => { written = item; return item; });
    const seen = wiredNotify(t);

    await push({ doc: eagleUpdate({ active: false, read: PRIVATE }) });

    assert.strictEqual(seen.cancelled.length, 1);
    assert.strictEqual(seen.cancelled[0].isPublished, false);
    assert.deepStrictEqual(seen.marks.map(m => m.mark), ['notifyCancelledAt']);
    assert.strictEqual(written.notifiedAt, EMAILED.notifiedAt, 'the claim stays, so a republish never emails');
    assert.deepStrictEqual(seen.claims, [], 'an unpublish takes no claim');
  });

  await t.test('a withdrawal already cancelled sends nothing more', async () => {
    t.mock.method(updates, 'getById', async () => ({
      id: UPDATE_EAGLE_ID, isPublished: false, ...EMAILED, notifyCancelledAt: '2026-08-02T00:00:00.000Z'
    }));
    t.mock.method(updates, 'upsert', async (item) => item);
    const seen = wiredNotify(t);

    await push({ doc: eagleUpdate({ active: false, read: PRIVATE }) });

    assert.deepStrictEqual(seen.cancelled, []);
  });

  await t.test('a DEMI claim whose send got no answer is still cancelled: it may have gone out', async () => {
    t.mock.method(updates, 'getById', async () => ({
      id: UPDATE_EAGLE_ID, isPublished: true, ...EMAILED, notifySentAt: null
    }));
    t.mock.method(updates, 'upsert', async (item) => item);
    const seen = wiredNotify(t);

    await push({ doc: eagleUpdate({ active: false, read: PRIVATE }) });

    assert.strictEqual(seen.cancelled.length, 1);
  });

  await t.test('a claim with no marker predates the bookkeeping and is not cancelled', async () => {
    t.mock.method(updates, 'getById', async () => ({
      id: UPDATE_EAGLE_ID, isPublished: true, notifiedAt: '2026-08-01T12:00:00.000Z'
    }));
    t.mock.method(updates, 'upsert', async (item) => item);
    const seen = wiredNotify(t);

    await push({ doc: eagleUpdate({ active: false, read: PRIVATE }) });

    assert.deepStrictEqual(seen.cancelled, []);
  });

  await t.test('a refused cancellation is recorded, so the timer does not ask again', async () => {
    t.mock.method(updates, 'getById', async () => ({ id: UPDATE_EAGLE_ID, isPublished: true, ...EMAILED }));
    t.mock.method(updates, 'upsert', async (item) => item);
    const seen = wiredNotify(t, { cancelOutcome: notify.OUTCOME.REJECTED });

    await push({ doc: eagleUpdate({ active: false, read: PRIVATE }) });

    assert.deepStrictEqual(seen.marks.map(m => m.mark), ['notifyCancelledAt']);
  });

  await t.test('archiving a row the backfill claimed sends no cancellation', async () => {
    t.mock.method(updates, 'getById', async () => ({
      id: UPDATE_EAGLE_ID, isPublished: true, notifiedAt: '2026-08-01T12:00:00.000Z', notifiedBy: 'backfill'
    }));
    t.mock.method(updates, 'upsert', async (item) => item);
    const seen = wiredNotify(t);

    await push({ doc: eagleUpdate({ status: 'archived', active: false, read: PRIVATE }) });

    assert.deepStrictEqual(seen.cancelled, []);
  });

  await t.test('moving publishDate into the future after the email sends nothing', async () => {
    t.mock.method(updates, 'getById', async () => ({ id: UPDATE_EAGLE_ID, isPublished: true, ...EMAILED }));
    t.mock.method(updates, 'upsert', async (item) => item);
    const seen = wiredNotify(t);

    await push({ doc: eagleUpdate({ status: 'published', publishDate: '2999-01-01T00:00:00.000Z' }) });

    assert.deepStrictEqual(seen.cancelled, [], 'no cancellation');
    assert.deepStrictEqual(seen.claims, [], 'and no claim, so no second email when the date passes');
  });

  await t.test('the send bookkeeping and its marker survive an upsert', async () => {
    t.mock.method(updates, 'getById', async () => ({
      id: UPDATE_EAGLE_ID, isPublished: true, ...EMAILED, sources: { eagle: {} }
    }));
    let written;
    t.mock.method(updates, 'upsert', async (item) => { written = item; return item; });

    await push({ doc: eagleUpdate() });

    for (const field of Object.keys(EMAILED)) assert.strictEqual(written[field], EMAILED[field], field);
  });

  await t.test('archiving a backfilled update sends no cancellation', async () => {
    // First push of an Eagle-backfilled row: Eagle's notifiedAt seeds the claim.
    let stored = null;
    t.mock.method(updates, 'getById', async () => stored);
    t.mock.method(updates, 'upsert', async (item) => { stored = item; return item; });
    const seen = wiredNotify(t);
    await push({ doc: eagleUpdate({ notifiedAt: '2026-08-01T00:00:00.000Z', status: 'published' }) });

    // Then it is archived.
    await push({ doc: eagleUpdate({
      notifiedAt: '2026-08-01T00:00:00.000Z', status: 'archived', active: false, read: PRIVATE
    }) });

    assert.deepStrictEqual(seen.cancelled, [], 'DEMI never announced it, so there is nothing to cancel');
    assert.strictEqual(stored.notifiedAt, '2026-08-01T00:00:00.000Z', 'the claim stays held');
    assert.strictEqual(stored.notifiedBy, 'eagle');
  });

  await t.test('read[] decides publication, not the upstream active flag', async () => {
    // read[] is authoritative and isPublished mirrors it (ADR-004). An `active` record the ACL
    // still keeps private is not published, so nobody is told about it.
    t.mock.method(updates, 'getById', async () => null);
    let written;
    t.mock.method(updates, 'upsert', async (item) => { written = item; return item; });
    const seen = wiredNotify(t);

    await push({ doc: eagleUpdate({ active: true, read: PRIVATE }) });

    assert.strictEqual(written.isPublished, false);
    assert.deepStrictEqual(seen.claims, []);
    assert.deepStrictEqual(seen.published, []);
  });

  await t.test('a cancellation that fails keeps the claim, so the next push retries', async () => {
    const stored = { id: UPDATE_EAGLE_ID, isPublished: true, ...EMAILED };
    t.mock.method(updates, 'getById', async () => ({ ...stored }));
    let written;
    t.mock.method(updates, 'upsert', async (item) => { written = item; return item; });
    const seen = wiredNotify(t, { cancelOutcome: notify.OUTCOME.FAILED });

    await push({ doc: eagleUpdate({ active: false, read: PRIVATE }) });

    assert.deepStrictEqual(seen.marks, [], 'an unsent cancellation is not recorded as sent');
    assert.strictEqual(written.notifiedAt, stored.notifiedAt, 'the stored row still holds the claim');

    await push({ doc: eagleUpdate({ active: false, read: PRIVATE }) });

    assert.strictEqual(seen.cancelled.length, 2, 'so the next unpublish push sends it again');
  });

  await t.test('unpublishing an update nobody announced sends nothing', async () => {
    t.mock.method(updates, 'getById', async () => ({
      id: UPDATE_EAGLE_ID, isPublished: false, notifiedAt: null
    }));
    t.mock.method(updates, 'upsert', async (item) => item);
    const seen = wiredNotify(t);

    await push({ doc: eagleUpdate({ active: false, read: PRIVATE }) });

    assert.deepStrictEqual(seen.cancelled, []);
  });

  await t.test('a notify failure is logged, not returned', async () => {
    t.mock.method(updates, 'getById', async () => null);
    t.mock.method(updates, 'upsert', async (item) => item);
    t.mock.method(notify, 'configured', () => true);
    t.mock.method(updates, 'claimForNotify', async () => { throw new Error('Cosmos is down'); });

    const res = await push({ doc: eagleUpdate() });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { id: UPDATE_EAGLE_ID, action: 'upsert' });
  });

  await t.test('dark: no claim is taken and nothing is sent', async () => {
    // A claim taken while dark would suppress the FIRST real notification once the environment is
    // wired up, which is the one that matters.
    t.mock.method(updates, 'getById', async () => null);
    t.mock.method(updates, 'upsert', async (item) => item);
    t.mock.method(notify, 'configured', () => false);
    let claims = 0;
    t.mock.method(updates, 'claimForNotify', async () => { claims++; });
    const fetches = [];
    const realFetch = global.fetch;
    global.fetch = async (...args) => { fetches.push(args); };

    try {
      const res = await push({ doc: eagleUpdate() });
      assert.strictEqual(res.statusCode, 200);
    } finally {
      global.fetch = realFetch;
    }

    assert.strictEqual(claims, 0);
    assert.deepStrictEqual(fetches, []);
  });

  await t.test('a body whose doc._id disagrees with the path is a 400 and no write', async () => {
    t.mock.method(updates, 'getById', async () => { throw new Error('must not be read'); });
    let upserts = 0;
    t.mock.method(updates, 'upsert', async () => { upserts++; });

    for (const body of [{ doc: eagleUpdate({ _id: 'somethingelse' }) }, {}, { doc: null }]) {
      const res = await push(body);
      assert.strictEqual(res.statusCode, 400);
    }
    assert.strictEqual(upserts, 0);
  });
});

test('the notification claim is a conditional patch', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const NOW = '2026-08-01T12:00:00.000Z';

  /** Record every patch, answer the patched row. */
  function recordPatches() {
    const calls = [];
    t.mock.method(cosmos, 'patch', async (container, id, pk, operations, condition) => {
      calls.push({ container, id, pk, operations, condition });
      return { id };
    });
    return calls;
  }

  await t.test('a claim is a DEMI lease: marker, lease start and one more attempt', async () => {
    const calls = recordPatches();

    await updates.claimForNotify(UPDATE_EAGLE_ID, NOW);

    assert.deepStrictEqual(calls[0].operations, [
      { op: 'set', path: '/notifiedAt', value: NOW },
      { op: 'set', path: '/notifiedBy', value: 'demi' },
      { op: 'set', path: '/notifyClaimedAt', value: NOW },
      { op: 'incr', path: '/notifyAttempts', value: 1 }
    ]);
    assert.strictEqual(calls[0].container, 'updates');
    assert.strictEqual(calls[0].pk, UPDATE_EAGLE_ID, 'the partition key is the id');
  });

  await t.test('the claim re-checks, inside Cosmos, that the row is still announceable', async () => {
    const calls = recordPatches();

    await updates.claimForNotify(UPDATE_EAGLE_ID, NOW);

    const { condition } = calls[0];
    assert.match(condition, /c\.isPublished = true/);
    assert.match(condition,
      /c\.status = "published" AND c\.publishDate <= "2026-08-01T12:00:00\.000Z"\)/);
    assert.match(condition, /NOT IS_DEFINED\(c\.notifiedAt\) OR IS_NULL\(c\.notifiedAt\)/);
    // The lease runs out 30 minutes after it was taken.
    assert.match(condition, /c\.notifyClaimedAt < "2026-08-01T11:30:00\.000Z"/);
    assert.match(condition, /NOT IS_STRING\(c\.notifySentAt\) AND NOT IS_STRING\(c\.notifyFailedAt\)/);
    assert.match(condition, /c\.notifyAttempts < 3/);
  });

  await t.test('a backfill claim is marked backfill, and only a live row is claimed', async () => {
    const calls = recordPatches();

    await updates.claimForBackfill(UPDATE_EAGLE_ID, NOW);

    assert.deepStrictEqual(calls[0].operations, [
      { op: 'set', path: '/notifiedAt', value: NOW },
      { op: 'set', path: '/notifiedBy', value: 'backfill' }
    ]);
    assert.match(calls[0].condition, /c\.isPublished = true/);
    assert.match(calls[0].condition, /c\.status = "published" AND .* <= "2026-08-01T12:00:00\.000Z"/);
    assert.match(calls[0].condition, /NOT IS_DEFINED\(c\.notifiedAt\) OR IS_NULL\(c\.notifiedAt\)/);
    assert.doesNotMatch(calls[0].condition, /notifyClaimedAt/, 'never takes over a DEMI lease');
  });

  await t.test('an instant that is not ISO text is refused, never written into the condition', async () => {
    recordPatches();
    await assert.rejects(() => updates.claimForNotify(UPDATE_EAGLE_ID, '" OR true OR "'), /not an ISO instant/);
  });

  await t.test('a 412 means the row is taken or no longer announceable, not an error', async () => {
    t.mock.method(cosmos, 'patch', async () => { throw Object.assign(new Error('precondition'), { code: 412 }); });
    assert.strictEqual(await updates.claimForNotify(UPDATE_EAGLE_ID, NOW), null);
    assert.strictEqual(await updates.claimForBackfill(UPDATE_EAGLE_ID, NOW), null);
  });

  await t.test('any other Cosmos error still throws', async () => {
    t.mock.method(cosmos, 'patch', async () => { throw Object.assign(new Error('throttled'), { code: 429 }); });
    await assert.rejects(() => updates.claimForNotify(UPDATE_EAGLE_ID, NOW), /throttled/);
  });

  await t.test('a mark records one outcome field and never touches the claim', async () => {
    const calls = recordPatches();

    await updates.markNotify(UPDATE_EAGLE_ID, 'notifySentAt', NOW);

    assert.deepStrictEqual(calls[0].operations, [{ op: 'set', path: '/notifySentAt', value: NOW }]);
    await assert.rejects(() => updates.markNotify(UPDATE_EAGLE_ID, 'notifiedAt', null), /unknown notify mark/);
    assert.strictEqual(updates.releaseNotify, undefined, 'nothing gives a claim back');
  });
});

test('an update emails once however often it is withdrawn and re-published', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  // The real claim and marks run against the in-memory container; the mirror write lands there too.
  // Required here, not at load: a load-time throw is swallowed by the logger's uncaughtException
  // handler and node --test then reports the whole file as passing.
  const { updatesStore } = require('../../helpers/updates-store');
  const { store } = updatesStore(t, []);
  t.mock.method(updates, 'getById', async (access, id) => {
    const row = store.get(String(id));
    return row ? { ...row } : null;
  });
  t.mock.method(updates, 'upsert', async (item) => { store.set(String(item.id), { ...item }); return item; });
  t.mock.method(notify, 'configured', () => true);
  t.mock.method(projects, 'getByEagleId', async () => null);
  const sent = { published: 0, cancelled: 0 };
  t.mock.method(notify, 'updatePublished', async () => { sent.published++; return notify.OUTCOME.SENT; });
  t.mock.method(notify, 'updateCancelled', async () => { sent.cancelled++; return notify.OUTCOME.SENT; });

  const published = () => push({ doc: eagleUpdate({ status: 'published', publishDate: '2026-08-01T00:00:00.000Z' }) });
  const archived = () => push({ doc: eagleUpdate({ status: 'archived', active: false, read: PRIVATE }) });

  await published();
  assert.deepStrictEqual(sent, { published: 1, cancelled: 0 });
  await archived();
  assert.deepStrictEqual(sent, { published: 1, cancelled: 1 });
  await published();
  assert.deepStrictEqual(sent, { published: 1, cancelled: 1 }, 're-publishing never emails again');
  await archived();
  assert.deepStrictEqual(sent, { published: 1, cancelled: 1 }, 'and a second withdrawal cancels nothing');
});

// The claim only makes "once" true if the mirror write cannot hand it back. This drives the real
// controller and the real repository against an in-memory Cosmos, so the write path is the thing
// under test rather than a stubbed claim.
test('the mirror write creates a new row and etag-replaces an existing one', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const calls = [];
  t.mock.method(cosmos, 'create', async (container, item) => { calls.push(['create', container, item.id]); return item; });
  t.mock.method(cosmos, 'replace', async (container, id, pk, item, etag) => {
    calls.push(['replace', container, id, pk, etag]);
    return item;
  });

  await updates.upsert({ id: UPDATE_EAGLE_ID }, null);
  await updates.upsert({ id: UPDATE_EAGLE_ID }, { _etag: 'e7' });

  assert.deepStrictEqual(calls, [
    ['create', 'updates', UPDATE_EAGLE_ID],
    ['replace', 'updates', UPDATE_EAGLE_ID, UPDATE_EAGLE_ID, 'e7']
  ], 'the etag is what turns a concurrent write into a 412 instead of a lost claim');
});

test('two pushes that read the same row announce one publication', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  // The update is already mirrored, unpublished and unannounced; both pushes publish it.
  const store = new Map([[UPDATE_EAGLE_ID, {
    id: UPDATE_EAGLE_ID, eagleId: UPDATE_EAGLE_ID, projectId: PROJECT_EAGLE_ID,
    isPublished: false, read: PRIVATE, notifiedAt: null, sources: {}, _etag: 'e0'
  }]]);
  let etags = 0;
  const stamp = (item) => ({ ...item, _etag: `e${++etags}` });

  t.mock.method(cosmos, 'create', async (container, item) => {
    if (store.has(item.id)) throw Object.assign(new Error('conflict'), { code: 409 });
    const row = stamp(item);
    store.set(item.id, row);
    return { ...row };
  });
  t.mock.method(cosmos, 'replace', async (container, id, pk, item, etag) => {
    const row = store.get(String(id));
    if (!row || row._etag !== etag) throw Object.assign(new Error('precondition'), { code: 412 });
    const next = stamp(item);
    store.set(String(id), next);
    return { ...next };
  });
  t.mock.method(cosmos, 'patch', async (container, id, pk, operations, condition) => {
    const row = store.get(String(id));
    // The UNCLAIMED condition, evaluated where Cosmos would evaluate it.
    if (condition && row.notifiedAt != null) throw Object.assign(new Error('precondition'), { code: 412 });
    const next = stamp(row);
    for (const op of operations) next[op.path.slice(1)] = op.value;
    store.set(String(id), next);
    return { ...next };
  });

  // The interleaving: the second push reads the row before the first writes it, and writes after
  // the first has taken the claim.
  let release;
  const parked = new Promise((resolve) => { release = resolve; });
  let reads = 0;
  t.mock.method(cosmos, 'readItem', async (container, id) => {
    const row = store.get(String(id));
    const snapshot = row ? { ...row } : null;
    if (++reads === 2) await parked;
    return snapshot;
  });

  t.mock.method(notify, 'configured', () => true);
  const published = [];
  t.mock.method(notify, 'updatePublished', async (item) => { published.push(item.id); return notify.OUTCOME.SENT; });
  t.mock.method(projects, 'getByEagleId', async () => ({ id: '207', name: 'Nicomen Wind Energy' }));

  const first = push({ doc: eagleUpdate() });
  const second = push({ doc: eagleUpdate({ headline: 'Edited headline' }) });
  const firstRes = await first;
  release();
  const secondRes = await second;

  assert.strictEqual(firstRes.statusCode, 200);
  assert.strictEqual(secondRes.statusCode, 200, 'the loser of the race still mirrors its record');
  assert.deepStrictEqual(published, [UPDATE_EAGLE_ID], 'the publication is announced exactly once');
  const stored = store.get(UPDATE_EAGLE_ID);
  assert.strictEqual(stored.headline, 'Edited headline', 'and the later record is the one stored');
  assert.match(stored.notifiedAt, /^\d{4}-\d{2}-\d{2}T/, 'with the claim still held');
});

test('the updates mirror route is behind authMiddleware + requireWrite', () => {
  // The handler reads and writes through systemAccess(), so the route chain is the whole gate.
  const route = routeChains().find(r => r.path === '/eagle/updates/:eagleId');
  assert.ok(route, 'no PUT /eagle/updates/:eagleId route');
  assert.strictEqual(route.method, 'put');
  assert.match(route.chain, /\bauthMiddleware\b/);
  assert.match(route.chain, /\brequireWrite\b/);
});
