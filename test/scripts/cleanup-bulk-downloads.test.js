'use strict';

/**
 * The zip sweeper. Storage and the repository are stubbed: the behaviour worth pinning is that
 * every part key is deleted before the row is marked expired, that the row itself survives, and
 * that marking it does not hand it a fresh retention window.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../src/config');
const storage = require('../../src/storage');
const bulkDownloads = require('../../src/repositories/bulk-downloads');

const cleanup = require('../../src/scripts/cleanup-bulk-downloads');

const DAY_MS = 24 * 60 * 60 * 1000;

function row(id, extra = {}) {
  return {
    id,
    requesterKey: `key-${id}`,
    finishedAt: new Date(Date.now() - 8 * DAY_MS).toISOString(),
    parts: [{ n: 1, key: `zips/${id}-part1.zip` }],
    ...extra
  };
}

const EXPIRED = [
  row('job-1', { parts: [{ n: 1, key: 'zips/job-1-part1.zip' }, { n: 2, key: 'zips/job-1-part2.zip' }] }),
  row('job-2')
];

test('cleanup-bulk-downloads', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('deletes every part of an expired job, then marks the row expired', async () => {
    const removed = [];
    const patches = [];
    let page = 0;
    t.mock.method(bulkDownloads, 'listExpired', async () => (page++ === 0 ? EXPIRED : []));
    t.mock.method(storage, 'removeObject', async key => { removed.push(key); });
    t.mock.method(bulkDownloads, 'patch', async (id, fields) => { patches.push({ id, fields }); });

    const summary = await cleanup.run();

    assert.deepStrictEqual(removed, [
      'zips/job-1-part1.zip', 'zips/job-1-part2.zip', 'zips/job-2-part1.zip'
    ], 'a part left behind is storage nobody will ever delete — the row is gone after this');
    assert.deepStrictEqual(patches.map(p => p.id), ['job-1', 'job-2']);
    assert.strictEqual(patches[0].fields.status, 'expired',
      'the row stays so a late poll reads "expired" rather than "never existed"');
    assert.deepStrictEqual(patches[0].fields.parts, []);
    assert.deepStrictEqual(summary, { jobs: 2, objects: 3, failures: 0 });
  });

  await t.test('a cancelled job keeps its status, and loses the parts it named', async () => {
    // Its worker deletes them when it stops, so these are the ones a dead instance left behind.
    const cancelled = row('job-9', {
      status: 'cancelled',
      parts: [{ n: 1, key: 'zips/job-9-part1.zip' }, { n: 2, key: 'zips/job-9-part2.zip' }]
    });
    const removed = [];
    const patches = [];
    let page = 0;
    t.mock.method(bulkDownloads, 'listExpired', async () => (page++ === 0 ? [cancelled] : []));
    // Resolving on a key that is already gone is what both storage backends do, and for a
    // cancelled job that is the usual case: its own worker deleted the parts before it stopped.
    t.mock.method(storage, 'removeObject', async key => { removed.push(key); });
    t.mock.method(bulkDownloads, 'patch', async (id, fields) => { patches.push({ id, fields }); });

    const summary = await cleanup.run();

    assert.deepStrictEqual(removed, ['zips/job-9-part1.zip', 'zips/job-9-part2.zip']);
    assert.strictEqual(patches[0].fields.status, undefined,
      'cancelled is terminal and says why the parts went; expired would say the timer took them');
    assert.deepStrictEqual(patches[0].fields.parts, []);
    assert.ok(patches[0].fields.ttl > 0, 'and the row keeps what is left of its own TTL');
    assert.deepStrictEqual(summary, { jobs: 1, objects: 2, failures: 0 });
  });

  await t.test('a full page of cancelled rows is swept once, not re-queried forever', async () => {
    // A cancelled row KEEPS its status, so the only thing taking it out of the sweep's query is
    // losing its parts. The loop reads another page whenever a full one expired something, so a
    // row that stays selectable pages over the same work until the timer is killed.
    // 500 is the script's page size: a shorter page ends the loop on its own and proves nothing.
    const rows = Array.from({ length: 500 }, (_, i) => row(`job-${i}`, { status: 'cancelled' }));
    let queries = 0;
    t.mock.method(bulkDownloads, 'listExpired', async () => {
      queries += 1;
      if (queries > 3) throw new Error('the sweep re-queried rows it had already swept');
      // The query's own predicate: finished, and still naming parts to delete.
      return rows.filter(job => job.parts.length > 0).map(job => ({ ...job }));
    });
    t.mock.method(storage, 'removeObject', async () => {});
    t.mock.method(bulkDownloads, 'patch', async (id, fields) => {
      Object.assign(rows.find(job => job.id === id), fields);
    });

    const summary = await cleanup.run();

    assert.strictEqual(queries, 2, 'one page of work, then one page with nothing left to sweep');
    assert.deepStrictEqual(summary, { jobs: 500, objects: 500, failures: 0 });
  });

  await t.test('only a row still running gives its quota slot back', async () => {
    const released = [];
    let page = 0;
    const rows = [
      row('job-done', { status: 'ready' }),
      row('job-dead', { status: 'running', finishedAt: undefined,
        startedAt: new Date(Date.now() - 8 * DAY_MS).toISOString() }),
      row('job-released', { status: 'running', finishedAt: undefined,
        startedAt: new Date(Date.now() - 8 * DAY_MS).toISOString(),
        slotReleasedAt: new Date(Date.now() - 8 * DAY_MS).toISOString() })
    ];
    t.mock.method(bulkDownloads, 'listExpired', async () => (page++ === 0 ? rows : []));
    t.mock.method(storage, 'removeObject', async () => {});
    t.mock.method(bulkDownloads, 'patch', async () => {});
    t.mock.method(bulkDownloads, 'claimSlotRelease', async () => true);
    t.mock.method(bulkDownloads, 'releaseSlot', async key => { released.push(key); });

    await cleanup.run();

    // The worker released the finished job's slot when it finished, and stamped slotReleasedAt on
    // the one it failed; releasing either again frees a slot the requester's other jobs hold. Only
    // the dead instance's slot was never released by anyone.
    assert.deepStrictEqual(released, ['key-job-dead']);
  });

  await t.test('the row keeps the retention it had left instead of starting over', async () => {
    let fields;
    t.mock.method(bulkDownloads, 'listExpired', async () => {
      const once = fields ? [] : [row('job-1')];
      return once;
    });
    t.mock.method(storage, 'removeObject', async () => {});
    t.mock.method(bulkDownloads, 'patch', async (id, patched) => { fields = patched; });

    await cleanup.run();

    // Cosmos measures ttl from the last write, so a patch without one gives the row another full
    // bulkJobTtlDays — the sweep would keep it alive rather than let it go.
    const expected = (config.bulkJobTtlDays - 8) * 24 * 60 * 60;
    assert.ok(Math.abs(fields.ttl - expected) < 60,
      `ttl ${fields.ttl} should be the ~${expected}s the row had left, not the full window`);
  });

  await t.test('a row that never finished is dated from when it was created', async () => {
    let fields;
    const running = row('job-dead', {
      status: 'running',
      finishedAt: undefined,
      createdAt: new Date(Date.now() - 8 * DAY_MS).toISOString(),
      startedAt: new Date(Date.now() - 8 * DAY_MS).toISOString()
    });
    t.mock.method(bulkDownloads, 'listExpired', async () => (fields ? [] : [running]));
    t.mock.method(storage, 'removeObject', async () => {});
    t.mock.method(bulkDownloads, 'releaseSlot', async () => {});
    t.mock.method(bulkDownloads, 'patch', async (id, patched) => { fields = patched; });

    await cleanup.run();

    // Without a ttl the patch hands the row another full bulkJobTtlDays, and a row nobody ever
    // finished is exactly the one that must not be kept alive by the sweep that found it.
    const expected = (config.bulkJobTtlDays - 8) * 24 * 60 * 60;
    assert.ok(Math.abs(fields.ttl - expected) < 60,
      `ttl ${fields.ttl} should be the ~${expected}s left of the window, dated from createdAt`);
  });

  await t.test('failed jobs are swept too, not only ready ones', async () => {
    let seen;
    t.mock.method(bulkDownloads, 'listExpired', async (cutoff, opts) => { seen = opts; return []; });

    await cleanup.run();

    assert.deepStrictEqual(seen.statuses, ['ready', 'failed', 'cancelled'],
      'a failed job keeps the parts it built before it died, and a cancelled one keeps them when ' +
      'its worker died before it could delete them — nothing else frees either');
    assert.ok(seen.limit > 0, 'an unbounded read of a container that only grows');
  });

  await t.test('asks for jobs older than the retention window', async () => {
    let cutoff;
    t.mock.method(bulkDownloads, 'listExpired', async value => { cutoff = value; return []; });

    await cleanup.run();

    const days = (Date.now() - Date.parse(cutoff)) / DAY_MS;
    assert.ok(Math.abs(days - config.bulkZipRetentionDays) < 0.01,
      'a cutoff of "now" would delete zips the caller is still downloading');
  });

  await t.test('nothing expired deletes nothing', async () => {
    t.mock.method(bulkDownloads, 'listExpired', async () => []);
    const removed = t.mock.method(storage, 'removeObject', async () => {});
    const patched = t.mock.method(bulkDownloads, 'patch', async () => {});

    const summary = await cleanup.run();

    assert.strictEqual(removed.mock.callCount(), 0);
    assert.strictEqual(patched.mock.callCount(), 0);
    assert.deepStrictEqual(summary, { jobs: 0, objects: 0, failures: 0 });
  });

  await t.test('one undeletable job does not stop the next', async () => {
    let page = 0;
    t.mock.method(bulkDownloads, 'listExpired', async () => (page++ === 0 ? EXPIRED : []));
    t.mock.method(storage, 'removeObject', async key => {
      if (key.startsWith('zips/job-1')) throw new Error('object store unreachable');
    });
    const patched = t.mock.method(bulkDownloads, 'patch', async () => {});

    const summary = await cleanup.run();

    assert.strictEqual(summary.failures, 1);
    assert.strictEqual(summary.objects, 1, 'job-2 is still swept');
    assert.deepStrictEqual(patched.mock.calls[0].arguments[0], 'job-2',
      'a job whose zips are still there must not be marked expired');
  });

  await t.test('a page that expires nothing ends the sweep instead of re-reading it', async () => {
    // Every row fails, so the same page comes back unchanged — the loop has to notice.
    const reads = t.mock.method(bulkDownloads, 'listExpired', async () => EXPIRED);
    t.mock.method(storage, 'removeObject', async () => { throw new Error('object store unreachable'); });
    t.mock.method(bulkDownloads, 'patch', async () => {});

    const summary = await cleanup.run();

    assert.strictEqual(reads.mock.callCount(), 1);
    assert.strictEqual(summary.failures, 2);
  });
});
