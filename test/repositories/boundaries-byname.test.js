'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const boundaries = require('../../src/repositories/boundaries');

// The frontend calls /boundaries/<name> with NO type. Requiring the partition key turned `type`
// into the string "undefined", which matches nothing and 404s every lookup.

test('getByName works with and without a type', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('no type -> cross-partition query on name only', async () => {
    let spec, options;
    t.mock.method(cosmos, 'query', async (c, s, o) => {
      spec = s; options = o;
      return { items: [{ id: 'b1', name: 'Bulkley-Nechako' }] };
    });

    const r = await boundaries.getByName('Bulkley-Nechako');
    assert.strictEqual(r.id, 'b1');
    assert.match(spec.query, /WHERE c\.name = @name/);
    assert.ok(!/c\.type/.test(spec.query), 'must not filter on an absent type');
    assert.ok(!('partitionKey' in options), 'must not scope to partition "undefined"');
    assert.deepStrictEqual(spec.parameters.map(p => p.name), ['@name']);
  });

  await t.test('with a type -> single-partition query', async () => {
    let spec, options;
    t.mock.method(cosmos, 'query', async (c, s, o) => {
      spec = s; options = o;
      return { items: [{ id: 'b1' }] };
    });

    await boundaries.getByName('Bulkley-Nechako', 'Regional District');
    assert.match(spec.query, /c\.type = @type AND c\.name = @name/);
    assert.strictEqual(options.partitionKey, 'Regional District');
  });

  await t.test('an empty-string type is treated as absent', () => {
    return (async () => {
      let options;
      t.mock.method(cosmos, 'query', async (c, s, o) => { options = o; return { items: [] }; });
      await boundaries.getByName('X', '');
      assert.ok(!('partitionKey' in options));
    })();
  });

  await t.test('no match returns null rather than undefined', async () => {
    t.mock.method(cosmos, 'query', async () => ({ items: [] }));
    assert.strictEqual(await boundaries.getByName('nope'), null);
  });
});
