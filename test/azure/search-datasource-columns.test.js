'use strict';

const test = require('node:test');
const assert = require('node:assert');

const index = require('../../azure/search/indexes/documents.json');
const datasource = require('../../azure/search/datasources/demi-documents-ds.json');

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

test('every field of the documents index is projected by demi-documents-ds', () => {
  const projected = projectedColumns(datasource.container.query);
  const missing = index.fields.map(f => f.name).filter(name => !projected.has(name));
  assert.deepStrictEqual(missing, [],
    `declared by ${index.name} but not selected by ${datasource.name}: ${missing.join(', ')}`);
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
