'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const documentsRepo = require('../../src/repositories/documents');

// Chunk-search controller tests mock `listByIds`, so only this file sees its projection; a
// narrowed SELECT blanks the milestone and date chips on every chunk card.
test('listByIds projects the columns the chunk card renders', async (t) => {
  await t.test('the SELECT names milestone, milestoneId and datePosted', async () => {
    let spec = null;
    t.mock.method(cosmos, 'query', async (_container, querySpec) => {
      spec = querySpec;
      return { items: [] };
    });

    await documentsRepo.listByIds({ tier: 'public', roles: ['public'] }, ['d1'], ['207']);

    assert.ok(spec, 'listByIds must reach Cosmos for a non-empty id set');

    // Match the SELECT clause only: the WHERE's ACL predicate names `c.read`, so a whole-query
    // `doesNotMatch(/c.read/)` fails against correct code.
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
    // This read gates chunk search: a missing parent row is what withholds a chunk, so the
    // visibility predicate and the caller's role must stay in the query.
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
