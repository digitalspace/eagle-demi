'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const bulkDownloads = require('../../src/repositories/bulk-downloads');

/**
 * The quota counter, which is the abuse boundary for an anonymous, unauthenticated route.
 *
 * What matters here is that the CHECK and the INCREMENT are one server-side operation: a read
 * followed by a write lets two requests arriving together both see "2 in flight" and both proceed.
 * These assertions read the condition the repository sends, because that string is the whole
 * mechanism — a patch that dropped it would hand out slots forever and every response would still
 * look correct.
 */

function refuse(code) {
  return async () => { throw Object.assign(new Error('cosmos said no'), { code }); };
}

test('bulk download quota', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a slot is taken by a conditional patch, not by a count then a write', async () => {
    const calls = [];
    t.mock.method(cosmos, 'patch', async (container, id, pk, operations, condition) => {
      calls.push({ container, id, pk, operations, condition });
      return {};
    });

    assert.strictEqual(await bulkDownloads.acquireSlot('1.2.3.4', { maxInFlight: 3, maxPerDay: 20 }), true);

    assert.strictEqual(calls.length, 1, 'one round trip when the caller is under both caps');
    assert.strictEqual(calls[0].container, 'bulkDownloads');
    assert.strictEqual(calls[0].id, 'quota:1.2.3.4');
    assert.strictEqual(calls[0].pk, calls[0].id, 'the quota row is its own partition');
    assert.match(calls[0].condition, /c\.inFlight < 3/);
    assert.match(calls[0].condition, /c\.windowCount < 20/);
    assert.deepStrictEqual(
      calls[0].operations.filter(op => op.op === 'incr'),
      [{ op: 'incr', path: '/inFlight', value: 1 }, { op: 'incr', path: '/windowCount', value: 1 }]
    );
  });

  await t.test('a caller at both caps is refused rather than erroring', async () => {
    // 412 is Cosmos rejecting the condition. It is the expected answer, not a fault.
    t.mock.method(cosmos, 'patch', refuse(412));

    assert.strictEqual(await bulkDownloads.acquireSlot('1.2.3.4', { maxInFlight: 3, maxPerDay: 20 }), false);
  });

  await t.test('a caller whose 24-hour window has ended starts a new one', async () => {
    const conditions = [];
    t.mock.method(cosmos, 'patch', async (container, id, pk, operations, condition) => {
      conditions.push({ operations, condition });
      // The day counter is spent, so only the window-roll condition can hold.
      if (conditions.length === 1) throw Object.assign(new Error('capped'), { code: 412 });
      return {};
    });

    assert.strictEqual(await bulkDownloads.acquireSlot('1.2.3.4', { maxInFlight: 3, maxPerDay: 20 }), true);

    const roll = conditions[1];
    assert.match(roll.condition, /c\.windowStart < "\d{4}-\d{2}-\d{2}T/, 'rolls on the stored window start');
    assert.match(roll.condition, /c\.inFlight < 3/, 'a new window is not a new concurrency budget');
    assert.deepStrictEqual(
      roll.operations.find(op => op.path === '/windowCount'),
      { op: 'set', path: '/windowCount', value: 1 }
    );
  });

  await t.test("a requester's first ever job creates the row and retries", async () => {
    let created = null;
    let attempts = 0;
    t.mock.method(cosmos, 'patch', async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('no row'), { code: 404 });
      return {};
    });
    t.mock.method(cosmos, 'create', async (container, item) => { created = item; return item; });

    assert.strictEqual(await bulkDownloads.acquireSlot('1.2.3.4', { maxInFlight: 3, maxPerDay: 20 }), true);

    assert.strictEqual(created.id, 'quota:1.2.3.4');
    assert.strictEqual(created.inFlight, 0, 'the retried patch is what counts the first job');
    assert.strictEqual(created.windowCount, 0);
    assert.ok(created.ttl > 0, 'a quota row expires, so a leaked count clears itself');
    assert.strictEqual(attempts, 2);
  });

  await t.test('two first requests race and the loser reuses the winner row', async () => {
    let attempts = 0;
    t.mock.method(cosmos, 'patch', async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('no row'), { code: 404 });
      return {};
    });
    // create, not upsert: the other request already counted its own job into this row.
    t.mock.method(cosmos, 'create', refuse(409));

    assert.strictEqual(await bulkDownloads.acquireSlot('1.2.3.4', { maxInFlight: 3, maxPerDay: 20 }), true);
    assert.strictEqual(attempts, 2);
  });

  await t.test('a Cosmos fault is not silently read as a full quota', async () => {
    t.mock.method(cosmos, 'patch', refuse(503));

    await assert.rejects(
      () => bulkDownloads.acquireSlot('1.2.3.4', { maxInFlight: 3, maxPerDay: 20 }),
      /cosmos said no/
    );
  });

  await t.test('releasing a slot cannot drive the counter below zero', async () => {
    let condition = null;
    t.mock.method(cosmos, 'patch', async (container, id, pk, operations, cond) => {
      condition = cond;
      return {};
    });

    await bulkDownloads.releaseSlot('1.2.3.4');

    assert.strictEqual(condition, 'FROM c WHERE c.inFlight > 0');
  });

  await t.test('a second release of the same job is a no-op, not an error', async () => {
    t.mock.method(cosmos, 'patch', refuse(412));

    assert.strictEqual(await bulkDownloads.releaseSlot('1.2.3.4'), false);
  });
});

test('listExpired', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('reads one bounded page, never the whole result set', async () => {
    let spec = null;
    let options = null;
    t.mock.method(cosmos, 'query', async (container, querySpec, queryOptions) => {
      spec = querySpec;
      options = queryOptions;
      return { items: [] };
    });

    await bulkDownloads.listExpired('2026-08-01T00:00:00.000Z', { limit: 50 });

    // Without maxItemCount cosmos.query takes the SDK's fetchAll and drains every matching row
    // into one timer invocation.
    assert.strictEqual(options.maxItemCount, 50);
    // The sweep needs the parts to delete, the finish time for what is left of the row TTL, and
    // the requester whose slot goes back.
    assert.match(spec.query, /SELECT c\.id, c\.status, c\.parts, c\.finishedAt, c\.requesterKey/);
    // A row still 'running' past the cutoff is an instance that died with retries exhausted; the
    // worker never released its slot, so the sweep must see it.
    assert.match(spec.query, /c\.status = 'running' AND c\.startedAt < @cutoff/);
    assert.deepStrictEqual(
      spec.parameters.map(p => p.value),
      ['ready', 'failed', '2026-08-01T00:00:00.000Z']
    );
  });

  await t.test('the statuses swept are the caller\'s, parameterised', async () => {
    let spec = null;
    t.mock.method(cosmos, 'query', async (container, querySpec) => { spec = querySpec; return { items: [] }; });

    await bulkDownloads.listExpired('2026-08-01T00:00:00.000Z', { statuses: ['expired'] });

    assert.match(spec.query, /c\.status IN \(@status0\)/);
    assert.deepStrictEqual(spec.parameters[0], { name: '@status0', value: 'expired' });
  });
});
