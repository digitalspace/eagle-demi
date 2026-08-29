'use strict';

const test = require('node:test');
const assert = require('node:assert');

const index = require('../../azure/search/indexes/documents.json');
const datasource = require('../../azure/search/datasources/demi-documents-ds.json');

// Both indexer pairs. The projects one renames most of what it selects, so its drift is the same
// bug wearing an alias.
const PAIRS = [
  [index, datasource],
  [require('../../azure/search/indexes/projects.json'),
    require('../../azure/search/datasources/demi-projects-ds.json')]
];

// Selected for the change detection policy, not for the index — the only column with no field.
const NOT_INDEXED = new Set(['_ts']);

/**
 * The index definition and the data source query are two hand-PUT files that never see each other,
 * and the indexer maps them BY NAME: a field the index declares and the query does not project is
 * indexed as null on every row, under a 200 from every PUT and a green indexer run. That drift is
 * invisible to the container, to CI and to the app — which reads the index definition and so
 * believes the field is populated. This is the only place the two are compared.
 */
function projectedColumns(query) {
  const select = query.slice(query.indexOf('SELECT') + 'SELECT'.length, query.indexOf(' FROM '));
  return new Map(select.split(',').map((col) => {
    const alias = /^\s*(\S+)\s+AS\s+(\S+)\s*$/i.exec(col);
    if (alias) return [alias[2], alias[1].replace(/^c\./, '')];
    const name = col.trim().replace(/^c\./, '');
    return [name, name];
  }));
}

for (const [idx, ds] of PAIRS) {
  test(`every field of the ${idx.name} index is projected by ${ds.name}`, () => {
    const projected = projectedColumns(ds.container.query);
    const missing = idx.fields.map(f => f.name).filter(name => !projected.has(name));
    assert.deepStrictEqual(missing, [],
      `declared by ${idx.name} but not selected by ${ds.name}: ${missing.join(', ')}`);
  });

  // The other direction. A column selected under a name the index does not declare is dropped on
  // the floor by the indexer, again under a 200 and a green run — which is how a rename ships half
  // done.
  test(`every column ${ds.name} selects is declared by ${idx.name}`, () => {
    const declared = new Set(idx.fields.map(f => f.name));
    const extra = [...projectedColumns(ds.container.query).keys()]
      .filter(name => !declared.has(name) && !NOT_INDEXED.has(name));
    assert.deepStrictEqual(extra, [],
      `selected by ${ds.name} but not declared by ${idx.name}: ${extra.join(', ')}`);
  });
}

// `vis` is the only column the projects query computes rather than reads: the container stores an
// object, the index has no map type, and an indexer given the bare object writes null — every dial
// then falls back to defaultVis with the whole suite green.
test('the projects vis column is serialized to text', () => {
  const [idx, ds] = PAIRS[1];
  const projected = projectedColumns(ds.container.query);

  assert.strictEqual(projected.get('vis'), 'ToString(c.vis)');
  assert.strictEqual(idx.fields.find(f => f.name === 'vis').type, 'Edm.String');
});

// The three fields TODO 3.3 adds, pinned by name and by what they are: the generic check above
// passes on a `documentSource` typed Edm.Boolean or a `fileNameTokens` aliased off the wrong
// column, and both are silent — a type flip is a rebuild, and the wrong alias analyzes the wrong
// text under an index that still answers.
test('the 3.3 fields are declared and sourced as intended', () => {
  const field = name => index.fields.find(f => f.name === name);
  const projected = projectedColumns(datasource.container.query);

  assert.strictEqual(field('isFeatured').type, 'Edm.Boolean');
  assert.strictEqual(field('documentSource').type, 'Edm.String');
  assert.strictEqual(projected.get('isFeatured'), 'isFeatured');
  assert.strictEqual(projected.get('documentSource'), 'documentSource');

  // Same text as `documentFileName`, a second time under the `filename` analyzer. Sourcing it from
  // any other column would tokenize the wrong string.
  assert.strictEqual(field('fileNameTokens').analyzer, 'filename');
  assert.strictEqual(field('fileNameTokens').searchable, true);
  assert.strictEqual(projected.get('fileNameTokens'), 'documentFileName');
  assert.ok(projected.has('documentFileName'),
    'the plain column must stay: dropping it would re-analyze documentFileName, which is a rebuild');
});
