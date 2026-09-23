'use strict';

/**
 * The scheduled announce: which rows it lists, and that each goes through the claim so a scheduled
 * Update is emailed once, only once it is due, and never from a stale read.
 *
 * The container is in memory (helpers/updates-store) and enforces the claim's own condition, so the
 * race between listing a row and claiming it is played out rather than asserted.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const updates = require('../../src/repositories/updates');
const notify = require('../../src/services/notify');
const { logger } = require('../../src/utils/logger');
const { updatesStore } = require('../helpers/updates-store');
// Required per call, not at load: a load-time throw lands in the logger's uncaughtException handler
// and node --test then reports the file as passing.
const script = () => require('../../src/scripts/announce-updates');
const run = (opts) => script().run(opts);

// Years before the wall clock, so a run that reads the clock instead of `now` gets it wrong.
const NOW = '2020-03-01T12:00:00.000Z';
const at = (minutes) => new Date(Date.parse(NOW) + minutes * 60000).toISOString();

const due = (id, extra = {}) => ({
  id, projectId: null, headline: `Update ${id}`, content: '<p>Body</p>', isPublished: true,
  status: 'published', publishDate: at(-60), dateAdded: at(-120), notifiedAt: null, notifyAttempts: 0,
  ...extra
});
/** A DEMI claim taken at `claimedAt`. */
const lease = (claimedAt, extra = {}) => ({
  notifiedAt: claimedAt, notifiedBy: 'demi', notifyClaimedAt: claimedAt, notifyAttempts: 1, ...extra
});

test('scheduled announce', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  /** Notify wired, every send recorded and answered with `outcome`. */
  function wire(outcome = notify.OUTCOME.SENT) {
    const sent = [];
    t.mock.method(notify, 'configured', () => true);
    t.mock.method(notify, 'updatePublished', async (item) => { sent.push({ ...item }); return outcome; });
    return sent;
  }

  await t.test('lists what the claim would take, published in the last 7 days, oldest first', async () => {
    wire();
    const { store } = updatesStore(t, []);
    let listed;
    t.mock.method(updates, 'listDueForNotify', async (now, limit) => { listed = { now, limit }; return []; });

    await run({ now: NOW });
    assert.deepStrictEqual(listed, { now: NOW, limit: 20 });
    assert.strictEqual(script().BATCH, 20);
    assert.strictEqual(store.size, 0);
  });


  await t.test('each due row is claimed, sent, and recorded as sent', async () => {
    const sent = wire();
    const { row } = updatesStore(t, [due('u1'), due('u2')]);

    const result = await run({ now: NOW });

    assert.deepStrictEqual(result, { due: 2 });
    assert.deepStrictEqual(sent.map(s => s.id).sort(), ['u1', 'u2']);
    for (const id of ['u1', 'u2']) {
      assert.strictEqual(row(id).notifiedBy, 'demi');
      assert.strictEqual(row(id).notifyClaimedAt, NOW);
      assert.strictEqual(row(id).notifySentAt, NOW);
      assert.strictEqual(row(id).notifyAttempts, 1);
    }
  });

  await t.test('a row somebody else claimed first is not sent again', async () => {
    const sent = wire();
    updatesStore(t, [due('u1', { notifiedAt: at(-5), notifiedBy: 'eagle' }), due('u2')]);

    await run({ now: NOW });

    assert.deepStrictEqual(sent.map(s => s.id), ['u2']);
  });

  await t.test('a row archived or rescheduled after listing is not sent; an edited one is sent as edited',
    async () => {
      const sent = wire();
      const { row } = updatesStore(t, [due('archived'), due('rescheduled'), due('edited')], {
        // Once the due query has listed them, not before: the claim is what must catch the change.
        onQuery: (store, items) => {
          if (items.length === 0) return;
          store.set('archived', { ...store.get('archived'), isPublished: false, status: 'archived' });
          store.set('rescheduled', { ...store.get('rescheduled'), publishDate: at(24 * 60) });
          store.set('edited', { ...store.get('edited'), headline: 'Edited after listing' });
        }
      });

      await run({ now: NOW });

      assert.deepStrictEqual(sent.map(s => s.id), ['edited']);
      assert.strictEqual(sent[0].headline, 'Edited after listing', 'the claimed row is sent, not the listed one');
      assert.strictEqual(row('archived').notifiedAt, null, 'no claim taken');
      assert.strictEqual(row('rescheduled').notifiedAt, null, 'still unclaimed for its new date');
    });

  await t.test('the tick\'s own time decides what is due, not the wall clock', async () => {
    const sent = wire();
    updatesStore(t, [due('soon', { publishDate: at(1) })]);

    await run({ now: NOW });
    assert.deepStrictEqual(sent, [], 'not due at NOW');

    await run({ now: at(2) });
    assert.deepStrictEqual(sent.map(s => s.id), ['soon']);
  });

  await t.test('a refused send (4xx) keeps the claim, is recorded, and is never retried', async () => {
    const sent = wire(notify.OUTCOME.REJECTED);
    const { row } = updatesStore(t, [due('u1')]);

    await run({ now: NOW });
    await run({ now: at(31) });
    await run({ now: at(120) });

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(row('u1').notifyFailedAt, NOW);
    assert.strictEqual(row('u1').notifiedAt, NOW, 'the claim is held');
  });

  await t.test('a send with no answer is retried after the lease runs out, three times in all', async () => {
    const sent = wire(notify.OUTCOME.FAILED);
    const errors = [];
    t.mock.method(logger, 'error', (msg, meta) => { errors.push({ msg, meta }); });
    const { row } = updatesStore(t, [due('u1')]);

    await run({ now: NOW });
    await run({ now: at(10) });
    assert.strictEqual(sent.length, 1, 'the lease is still live after 10 minutes');

    await run({ now: at(31) });
    await run({ now: at(62) });
    await run({ now: at(93) });
    await run({ now: at(200) });

    assert.strictEqual(sent.length, 3);
    assert.strictEqual(row('u1').notifyAttempts, 3);
    assert.strictEqual(row('u1').notifySentAt, undefined);
    assert.deepStrictEqual(errors.map(e => e.msg), ['[Update Controller] notify gave up']);
  });

  await t.test('a claim a killed run left behind is taken over once its lease runs out', async () => {
    const sent = wire();
    const { row } = updatesStore(t, [due('u1', {
      notifiedAt: at(-40), notifiedBy: 'demi', notifyClaimedAt: at(-40), notifyAttempts: 1
    })]);

    await run({ now: NOW });

    assert.deepStrictEqual(sent.map(s => s.id), ['u1']);
    assert.strictEqual(row('u1').notifyAttempts, 2);
    assert.strictEqual(row('u1').notifySentAt, NOW);
  });

  await t.test('a lease on its last attempt cannot be taken over, even from a stale list', async () => {
    const { row } = updatesStore(t, [due('u1', lease(at(-40), { notifyAttempts: 3 }))]);

    assert.strictEqual(await updates.claimForNotify('u1', NOW), null);
    assert.strictEqual(row('u1').notifyAttempts, 3);
  });

  await t.test('a sent row is never sent again, however old its claim', async () => {
    const sent = wire();
    updatesStore(t, [due('u1', {
      notifiedAt: at(-90), notifiedBy: 'demi', notifyClaimedAt: at(-90), notifySentAt: at(-90), notifyAttempts: 1
    })]);

    await run({ now: NOW });

    assert.deepStrictEqual(sent, []);
  });

  await t.test('a withdrawal whose cancellation got no answer is retried until it goes out', async () => {
    wire();
    const cancelled = [];
    const outcomes = [notify.OUTCOME.FAILED, notify.OUTCOME.SENT];
    t.mock.method(notify, 'updateCancelled', async (item) => { cancelled.push(item.id); return outcomes.shift(); });
    const withdrawn = (id, extra) => due(id, {
      isPublished: false, status: 'archived', notifiedAt: at(-60), notifiedBy: 'demi',
      notifyClaimedAt: at(-60), notifySentAt: at(-60), notifyAttempts: 1, ...extra
    });
    const { row } = updatesStore(t, [
      withdrawn('w1'),
      withdrawn('done', { notifyCancelledAt: at(-30) }),
      withdrawn('backfilled', { notifiedBy: 'backfill' }),
      withdrawn('old', { notifyClaimedAt: at(-8 * 24 * 60) })
    ]);

    await run({ now: NOW });
    await run({ now: at(5) });
    await run({ now: at(10) });

    assert.deepStrictEqual(cancelled, ['w1', 'w1']);
    assert.strictEqual(row('w1').notifyCancelledAt, at(5));
  });

  await t.test('dark: no query, no claim', async () => {
    const sent = wire();
    notify.configured.mock.mockImplementation(() => false);
    const { patches } = updatesStore(t, [due('u1')]);
    let listed = 0;
    t.mock.method(updates, 'listDueForNotify', async () => { listed++; return []; });

    assert.deepStrictEqual(await run({ now: NOW }), { due: 0 });
    assert.strictEqual(listed, 0);
    assert.deepStrictEqual(patches, []);
    assert.deepStrictEqual(sent, []);
  });
});

test('the due list', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const DAY = 24 * 60;
  const ids = (rows) => rows.map(r => r.id);

  await t.test('unclaimed rows: published, due, in the last 7 days by publishDate, oldest first', async () => {
    updatesStore(t, [
      due('newer', { publishDate: at(-60) }),
      due('older', { publishDate: at(-6 * DAY) }),
      due('stale', { publishDate: at(-8 * DAY) }),
      due('scheduled', { publishDate: at(60) }),
      due('draft', { status: 'draft' }),
      due('legacy', { status: null }),
      due('private', { isPublished: false }),
      due('taken', { notifiedAt: at(-5), notifiedBy: 'eagle' })
    ]);

    assert.deepStrictEqual(ids(await updates.listDueForNotify(NOW, 20)), ['older', 'newer']);
  });

  await t.test('a DEMI lease is windowed from its claim, not from publishDate', async () => {
    updatesStore(t, [
      due('oldNews', { publishDate: at(-30 * DAY), ...lease(at(-40)) }),
      due('oldClaim', { publishDate: at(-60), ...lease(at(-8 * DAY)) }),
      due('live', lease(at(-10))),
      due('sent', lease(at(-40), { notifySentAt: at(-40) })),
      due('refused', lease(at(-40), { notifyFailedAt: at(-40) })),
      due('spent', lease(at(-40), { notifyAttempts: 3 })),
      due('eagle', lease(at(-40), { notifiedBy: 'eagle' }))
    ]);

    assert.deepStrictEqual(ids(await updates.listDueForNotify(NOW, 20)), ['oldNews']);
  });

  await t.test('retries come first, and the list stops at the limit', async () => {
    updatesStore(t, [
      due('fresh1', { publishDate: at(-90) }),
      due('fresh2', { publishDate: at(-80) }),
      due('fresh3', { publishDate: at(-70) }),
      due('lease', lease(at(-40))),
      due('cancel', { isPublished: false, status: 'archived', ...lease(at(-50)) })
    ]);

    assert.deepStrictEqual(ids(await updates.listDueForNotify(NOW, 4)), ['cancel', 'lease', 'fresh1', 'fresh2']);
  });

  await t.test('short pages are followed to the limit', async () => {
    const { queries } = updatesStore(t, ['a', 'b', 'c', 'd', 'e'].map((id, i) => due(id, { publishDate: at(-100 + i) })),
      { pageSize: 2 });

    assert.deepStrictEqual(ids(await updates.listDueForNotify(NOW, 4)), ['a', 'b', 'c', 'd']);
    const fresh = queries.filter(q => /ORDER BY c\.publishDate/.test(q.spec.query));
    assert.deepStrictEqual(fresh.map(q => q.options.continuationToken), [undefined, '2']);
  });

  await t.test('and stop at the page cap, saying so', async () => {
    const warnings = [];
    t.mock.method(logger, 'warn', (msg) => { warnings.push(msg); });
    updatesStore(t, Array.from({ length: 15 }, (_, i) => due(`r${String(i).padStart(2, '0')}`, { publishDate: at(-100 + i) })),
      { pageSize: 1 });

    assert.strictEqual((await updates.listDueForNotify(NOW, 20)).length, 10);
    assert.deepStrictEqual(warnings, ['[updates] due list stopped at the page cap']);
  });
});
