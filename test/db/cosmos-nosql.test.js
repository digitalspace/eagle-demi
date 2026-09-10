'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');

// The previous data layer accepted a Cosmos-SQL-shaped string and "translated" it by
// substring matching, silently discarding any predicate it did not recognise — so
// `WHERE c.isPublished = true` became `{}` and every gated read served the whole collection.
// These tests pin the replacement behaviour: anything that cannot be run as a parameterised
// query THROWS. An unrunnable query must never degrade into an unfiltered read.

test('assertQuerySpec rejects everything that is not a parameterised spec', async (t) => {
  const bad = [
    ['a SQL string', 'SELECT * FROM c'],
    ['the exact clause that used to be dropped', 'c.isPublished = true'],
    ['a Mongo filter object', { isPublished: true }],
    ['a Mongo $or filter', { $or: [{ read: { $in: ['public'] } }] }],
    ['an array', ['isPublished']],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['spec with no query', { parameters: [] }],
    ['spec with an empty query', { query: '   ', parameters: [] }],
    ['spec with no parameters array', { query: 'SELECT * FROM c' }],
    ['spec with parameters as an object', { query: 'SELECT * FROM c', parameters: {} }]
  ];

  for (const [label, value] of bad) {
    await t.test(`rejects ${label}`, () => {
      assert.throws(
        () => cosmos.assertQuerySpec(value, 'projects'),
        /Refusing to query/,
        `${label} must throw, not fall through to an unfiltered read`
      );
    });
  }

  await t.test('rejects a parameter whose name is missing the @ sigil', () => {
    assert.throws(() => cosmos.assertQuerySpec(
      { query: 'SELECT * FROM c WHERE c.id = @id', parameters: [{ name: 'id', value: '1' }] },
      'projects'
    ), /beginning with "@"/);
  });

  await t.test('accepts a well-formed spec', () => {
    const spec = {
      query: 'SELECT * FROM c WHERE c.id = @id',
      parameters: [{ name: '@id', value: '207' }]
    };
    assert.strictEqual(cosmos.assertQuerySpec(spec, 'projects'), spec);
  });

  await t.test('accepts a spec with no parameters', () => {
    const spec = { query: 'SELECT VALUE COUNT(1) FROM c', parameters: [] };
    assert.doesNotThrow(() => cosmos.assertQuerySpec(spec, 'projects'));
  });
});

test('query() validates before touching the database', async (t) => {
  // No COSMOS_ENDPOINT is configured in tests, so getContainer() yields null and a valid spec
  // resolves to an empty result. The point is that validation happens FIRST: a bad spec
  // throws even when there is no connection to fail against.
  await t.test('throws on a bad spec even with no connection', async () => {
    await assert.rejects(
      () => cosmos.query('projects', 'c.isPublished = true'),
      /Refusing to query/
    );
  });

  await t.test('a valid spec resolves to an empty page when unconfigured', async () => {
    const res = await cosmos.query('projects', {
      query: 'SELECT * FROM c',
      parameters: []
    });
    assert.deepStrictEqual(res.items, []);
  });
});

test('patch() guards the Cosmos operation limit', async (t) => {
  await t.test('rejects an empty operation list', async () => {
    await assert.rejects(() => cosmos.patch('projects', '1', '1', []), /non-empty/);
  });

  await t.test('rejects more than 10 operations', async () => {
    const ops = Array.from({ length: 11 }, (_, i) => ({
      op: 'set', path: `/f${i}`, value: i
    }));
    await assert.rejects(() => cosmos.patch('projects', '1', '1', ops), /at most 10/);
  });
});

test('unconfigured client degrades safely rather than throwing', async (t) => {
  await t.test('getDatabase returns null without COSMOS_ENDPOINT', () => {
    assert.strictEqual(cosmos.getDatabase(), null);
  });

  await t.test('readItem returns null', async () => {
    assert.strictEqual(await cosmos.readItem('projects', '207', '207'), null);
  });

  await t.test('ping reports false', async () => {
    assert.strictEqual(await cosmos.ping(), false);
  });
});

/**
 * A fresh copy of the module with the Cosmos SDK replaced by a recorder.
 *
 * The client and database handles are memoised at module scope on first use, so the stub has to be
 * in the require cache before this copy loads — the same reason `restamp-chunks.test.js` re-requires
 * its subject instead of mocking one in place.
 */
function loadWithSdkStub(t) {
  const MODULE = require.resolve('../../src/db/cosmos-nosql');
  const SDK = require.resolve('@azure/cosmos');
  const IDENTITY = require.resolve('@azure/identity');
  const cached = [MODULE, SDK, IDENTITY].map(id => [id, require.cache[id]]);
  const endpoint = process.env.COSMOS_ENDPOINT;

  const patches = [];
  const upserts = [];
  // Pages `items.query` hands back, in order, one per fetchNext(); the feed options of each call
  // land in `queries` so a test can see what the iterator was opened with. `hasMoreResults()`
  // mirrors the real iterator: true while pages remain, which is what a drain loop reads — the SDK
  // does NOT hand a usable continuation token back on the cross-partition path.
  const pages = [];
  const queries = [];
  require.cache[SDK] = {
    id: SDK,
    filename: SDK,
    loaded: true,
    exports: {
      CosmosClient: class {
        database() {
          return {
            container: () => ({
              items: {
                query: (spec, feedOptions) => {
                  queries.push({ spec, feedOptions });
                  return {
                    hasMoreResults: () => pages.length > 0,
                    fetchNext: async () => pages.shift() || { resources: [] },
                    fetchAll: async () => pages.shift() || { resources: [] }
                  };
                },
                upsert: async (item, options) => {
                  upserts.push({ item, options });
                  return { resource: item };
                }
              },
              item: (id, partitionKey) => ({
                patch: async (body, options) => {
                  patches.push({ id, partitionKey, body, options });
                  return { resource: { id } };
                }
              })
            })
          };
        }
      }
    }
  };
  require.cache[IDENTITY] = {
    id: IDENTITY,
    filename: IDENTITY,
    loaded: true,
    exports: { DefaultAzureCredential: class {} }
  };
  delete require.cache[MODULE];
  process.env.COSMOS_ENDPOINT = 'https://demi-test.documents.azure.com:443/';

  t.after(() => {
    for (const [id, entry] of cached) {
      if (entry === undefined) delete require.cache[id];
      else require.cache[id] = entry;
    }
    if (endpoint === undefined) delete process.env.COSMOS_ENDPOINT;
    else process.env.COSMOS_ENDPOINT = endpoint;
  });

  return { module: require(MODULE), patches, upserts, pages, queries };
}

test('patch() carries optimistic concurrency to the SDK', async (t) => {
  // Without this the caller's _etag is accepted and then dropped, which reads as a working guard:
  // the write lands every time and the update it was meant to protect is lost with nothing logged.
  const { module: db, patches } = loadWithSdkStub(t);
  const ops = [{ op: 'set', path: '/parentFieldsPending', value: false }];

  await t.test('an etag becomes an IfMatch access condition', async () => {
    await db.patch('documents', '5d0d', null, ops, undefined, '"0x8DC1"');

    assert.deepStrictEqual(patches.at(-1).options,
      { accessCondition: { type: 'IfMatch', condition: '"0x8DC1"' } });
    assert.strictEqual(patches.at(-1).partitionKey, null,
      'the partition key is handed over as given, not stringified');
  });

  await t.test('a patch with no etag is unconditional', async () => {
    await db.patch('documents', '5d0d', '207', ops);

    assert.deepStrictEqual(patches.at(-1).options, {});
  });

  await t.test('a SQL condition still travels with the operations', async () => {
    await db.patch('bulkDownloads', 'quota:1.2.3.4', 'quota:1.2.3.4', ops, 'FROM c WHERE c.n < 3');

    assert.deepStrictEqual(patches.at(-1).body,
      { operations: ops, condition: 'FROM c WHERE c.n < 3' });
  });
});

/**
 * `queryFirst` — the lookup that answers "does this row exist" across partitions.
 *
 * The failure it exists for is not an error: a page of a cross-partition query legitimately comes
 * back EMPTY with a continuation token, because Cosmos returns whatever the partitions it reached
 * within the page budget held. A caller that read one page reported live documents as deleted, and
 * the re-stamp then dropped their messages.
 */
test('queryFirst drains pages instead of trusting the first one', async (t) => {
  const { module: db, pages, queries } = loadWithSdkStub(t);
  const spec = {
    query: 'SELECT * FROM c WHERE c.id = @id',
    parameters: [{ name: '@id', value: '5d0d' }]
  };

  await t.test('an empty first page does not mean the row is absent', async () => {
    pages.push({ resources: [] });
    pages.push({ resources: [{ id: '5d0d', projectId: '207' }] });

    const row = await db.queryFirst('documents', spec);

    assert.deepStrictEqual(row, { id: '5d0d', projectId: '207' });
  });

  await t.test('the drain holds ONE iterator, at a page size of 1', async () => {
    // Not a new iterator per page fed a continuation token: on the cross-partition path the SDK
    // hands NO token back (LegacyFetchImplementation never sets `x-ms-continuation`, and
    // mergeHeaders does not copy it), so a token-driven drain stopped at page one — which is the
    // exact failure this function exists to prevent.
    const before = queries.length;
    pages.push({ resources: [] }, { resources: [] }, { resources: [{ id: '5d0d' }] });

    await db.queryFirst('documents', spec);

    assert.strictEqual(queries.length - before, 1, 'three pages, one items.query() call');
    assert.strictEqual(queries.at(-1).feedOptions.maxItemCount, 1);
  });

  await t.test('a partition key scopes the iterator, an empty string included', async () => {
    pages.push({ resources: [{ id: '5d0d' }] });

    await db.queryFirst('documents', spec, { partitionKey: '' });

    assert.strictEqual(queries.at(-1).feedOptions.partitionKey, '',
      "'' is a real partition, and a presence test is what keeps it one");
  });

  await t.test('an exhausted iterator is a genuine not-found', async () => {
    assert.strictEqual(await db.queryFirst('documents', spec), null);
  });

  await t.test('running out of pages THROWS rather than reporting the row absent', async () => {
    // Callers act destructively on null — the re-stamp drops its message, the seeder writes a
    // duplicate. A drain that stopped early has not answered the question, so it must not return
    // the answer that means "no such row". An unbounded drain is also not an option: that is the
    // cross-partition scan the partition key exists to avoid.
    const before = queries.length;
    for (let i = 0; i < db.LOOKUP_MAX_PAGES + 5; i++) pages.push({ resources: [] });

    await assert.rejects(() => db.queryFirst('documents', spec),
      (err) => err.code === db.LOOKUP_BOUND_CODE);
    assert.strictEqual(queries.length - before, 1);
    pages.length = 0;
  });

  await t.test('internals are stripped from the row it returns', async () => {
    pages.push({ resources: [{ id: '5d0d', _rid: 'abc', _etag: '"0x8DC1"' }] });

    const row = await db.queryFirst('documents', spec);

    assert.strictEqual(row._rid, undefined, 'the internal resource path never leaves the module');
    assert.strictEqual(row._etag, '"0x8DC1"', 'the concurrency token does');
  });

  await t.test('a spec that is not parameterised is refused before any page is read', async () => {
    await assert.rejects(() => db.queryFirst('documents', 'c.isPublished = true'),
      /Refusing to query/);
  });
});

/**
 * `upsert` with an etag.
 *
 * An upsert replaces the whole item, so it has no stored value left for a patch `condition` to
 * test: the item's revision is the only concurrency control it can have. Without it two writers
 * that read the same row both write, and the loser's change is gone with nothing logged.
 */
test('upsert carries optimistic concurrency to the SDK', async (t) => {
  const { module: db, upserts } = loadWithSdkStub(t);
  const row = { id: '5d0d', projectId: '207' };

  await t.test('an etag becomes an IfMatch access condition', async () => {
    await db.upsert('documents', row, { etag: '"0x8DC1"' });

    assert.deepStrictEqual(upserts.at(-1).options,
      { accessCondition: { type: 'IfMatch', condition: '"0x8DC1"' } });
    assert.deepStrictEqual(upserts.at(-1).item, row);
  });

  await t.test('no etag is an unconditional write, as every existing caller expects', async () => {
    await db.upsert('documents', row);

    assert.deepStrictEqual(upserts.at(-1).options, {});
  });
});

/**
 * A guarded PATCH inside a BULK request.
 *
 * The chunk re-stamp orders concurrent walks with a SQL `condition` on every patch, and it sends
 * one request per hundred chunks rather than one per chunk — a corpus walk is 400k+ of them. Two
 * things have to hold for that: the condition must reach the SDK on each operation, and a rejected
 * condition must be reported as the ANSWER it is. A 412 retried four times pays four requests for
 * a decision Cosmos already made and then hands the caller a skipped chunk counted as a lost one,
 * which is what sends the repair after rows that are already current.
 */
test('bulk carries a per-operation Patch condition to the SDK', async () => {
  const sent = [];
  const container = {
    items: {
      bulk: async (operations) => {
        sent.push(operations);
        return operations.map(() => ({ statusCode: 200 }));
      }
    }
  };
  const body = {
    operations: [{ op: 'set', path: '/parentStampedAt', value: '2026-09-10T12:00:00.000Z' }],
    condition: 'FROM c WHERE NOT IS_DEFINED(c.parentStampedAt)'
  };

  await cosmos.bulk('chunks', [
    { operationType: 'Patch', partitionKey: 'docA', id: 'c0', resourceBody: body },
    { operationType: 'Patch', partitionKey: 'docA', id: 'c1', resourceBody: body }
  ], { containerFn: () => container });

  // Handed over verbatim: @azure/cosmos 4.10 types a Patch operation's resourceBody as
  // `PatchRequestBody` — `{operations, condition?}` — and the executor puts the prepared operations
  // straight in the request body. Dropping the condition here turns every guarded walk into the
  // last-writer-wins overwrite it replaced, under a 200.
  assert.strictEqual(sent.length, 1, 'two operations in one partition are one request');
  assert.deepStrictEqual(sent[0].map(op => op.resourceBody), [body, body]);
});

test('bulkVerified answers a rejected precondition apart from a failure', async (t) => {
  const patch = (id) => ({ operationType: 'Patch', partitionKey: 'docA', id });
  const answer = (statusCode) => ({ statusCode, requestCharge: 2 });

  await t.test('a 412 is skipped, not failed, and never retried', async () => {
    const attempts = [];
    const res = await cosmos.bulkVerified('chunks', [patch('c0'), patch('c1'), patch('c2')], {
      bulkFn: async (pending) => {
        attempts.push(pending.map(op => op.id));
        return pending.map(op => answer(op.id === 'c1' ? 412 : 200));
      }
    });

    assert.deepStrictEqual(attempts, [['c0', 'c1', 'c2']],
      'the precondition held or it did not — asking again pays for the same answer');
    assert.deepStrictEqual(res.skippedIds, ['c1']);
    assert.deepStrictEqual(res.failedIds, []);
    assert.strictEqual(res.failed, 0,
      'a row the caller asked not to overwrite is current, not lost');
    assert.strictEqual(res.succeeded, 2);
    assert.deepStrictEqual(res.statusCounts, { 200: 2, 412: 1 });
    assert.strictEqual(res.requestCharge, 6, 'a rejected operation is still billed');
  });

  await t.test('a whole batch of 412s is one request, not four', async () => {
    let calls = 0;
    const res = await cosmos.bulkVerified('chunks', [patch('c0'), patch('c1')], {
      bulkFn: async (pending) => { calls++; return pending.map(() => answer(412)); }
    });

    assert.strictEqual(calls, 1);
    assert.strictEqual(res.succeeded, 0);
    assert.strictEqual(res.failed, 0);
    assert.deepStrictEqual(res.skippedIds, ['c0', 'c1']);
  });

  await t.test('a retryable status beside a 412 is retried without it', async () => {
    const attempts = [];
    const res = await cosmos.bulkVerified('chunks', [patch('c0'), patch('c1')], {
      maxAttempts: 2,
      bulkFn: async (pending) => {
        attempts.push(pending.map(op => op.id));
        return pending.map(op => answer(op.id === 'c0' ? 412 : (attempts.length === 1 ? 429 : 200)));
      }
    });

    assert.deepStrictEqual(attempts, [['c0', 'c1'], ['c1']],
      'the throttled operation goes again, the refused one does not');
    assert.strictEqual(res.succeeded, 1);
    assert.deepStrictEqual(res.skippedIds, ['c0']);
    assert.deepStrictEqual(res.statusCounts, { 412: 1, 429: 1, 200: 1 });
  });

  await t.test('an operation Cosmos really rejected is still a failure', async () => {
    const res = await cosmos.bulkVerified('chunks', [patch('c0')], {
      maxAttempts: 1,
      bulkFn: async (pending) => pending.map(() => answer(404))
    });

    assert.deepStrictEqual(res.failedIds, ['c0']);
    assert.deepStrictEqual(res.skippedIds, []);
    assert.strictEqual(res.failed, 1);
  });
});
