'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const documentsRepo = require('../../src/repositories/documents');

/**
 * What `listByIds` ASKS COSMOS FOR, which no controller test can see.
 *
 * Every test that exercises the chunk-search path mocks `listByIds` wholesale, so the projection
 * itself is invisible to all of them: narrowing the SELECT back to the four display columns leaves
 * the entire controller suite green while the milestone and date chips silently go blank on every
 * card. This file exists to close that hole and nothing else.
 */
test('listByIds projects the columns the chunk card renders', async (t) => {
  await t.test('the SELECT names milestone, milestoneId and datePosted', async () => {
    let spec = null;
    t.mock.method(cosmos, 'query', async (_container, querySpec) => {
      spec = querySpec;
      return { items: [] };
    });

    await documentsRepo.listByIds({ tier: 'public', roles: ['public'] }, ['d1'], ['207']);

    assert.ok(spec, 'listByIds must reach Cosmos for a non-empty id set');

    // The SELECT clause ALONE. Matching the whole query string would also see the ACL predicate the
    // WHERE is built from, which names `c.read` — so a naive `doesNotMatch(spec.query, /c.read/)`
    // fails against correct code and teaches whoever hits it to delete the assertion.
    const select = /^SELECT\s+([\s\S]*?)\s+FROM\b/i.exec(spec.query);
    assert.ok(select, `could not read a SELECT clause out of: ${spec.query}`);
    const columns = select[1].split(',').map(c => c.trim());

    // The LABEL as well as the id. Prod emits both on a chunk row, and the chunk card renders the
    // label raw — an id-only projection puts a GUID in the chip.
    assert.ok(columns.includes('c.milestone'), `the label the chip renders; got ${columns}`);
    assert.ok(columns.includes('c.milestoneId'), 'the id, for a consumer that resolves lists');
    assert.ok(columns.includes('c.datePosted'), 'the date chip');

    // Still narrow. A caller who may read a chunk has no business receiving the whole parent, and
    // these are the two a widening would most plausibly sweep in.
    assert.ok(!columns.includes('c.read'), 'the parent ACL is not the chunk reader\'s business');
    assert.ok(!columns.includes('c.description'), 'not projected');
    assert.ok(!columns.includes('*'), 'never the whole item');
  });

  await t.test('the ACL predicate survives the widened projection', async () => {
    // Widening a SELECT is exactly the kind of edit that quietly loses a WHERE, and this projection
    // feeds the chunk-search GATE — a caller who may not read the parent document must not get a
    // parent row back, because a missing row is what withholds the chunk. Assert the visibility
    // predicate and the caller's own role are both still in the query the widening produced.
    let spec = null;
    t.mock.method(cosmos, 'query', async (_container, querySpec) => { spec = querySpec; return { items: [] }; });

    await documentsRepo.listByIds({ tier: 'public', roles: ['public'] }, ['d1'], ['207']);

    assert.match(spec.query, /EXISTS\(SELECT VALUE r FROM r IN c\.read/,
      'the read[] predicate is what makes a miss mean DENIED rather than absent');
    assert.ok(spec.parameters.some(param => param.value === 'public'),
      'the caller\'s own role must be bound into it, not assumed');
  });

  await t.test('an empty id set asks Cosmos nothing at all', async () => {
    let called = false;
    t.mock.method(cosmos, 'query', async () => { called = true; return { items: [] }; });
    const rows = await documentsRepo.listByIds({ tier: 'public', roles: ['public'] }, [], []);
    assert.deepStrictEqual(rows, []);
    assert.strictEqual(called, false, 'a query for no ids is a query for everything');
  });
});
