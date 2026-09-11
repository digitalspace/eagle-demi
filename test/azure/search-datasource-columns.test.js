'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { projectedColumns } = require('../helpers/search-datasource');

const index = require('../../azure/search/indexes/documents.json');
const datasource = require('../../azure/search/datasources/demi-documents-ds.json');

// Both indexer pairs. The projects one renames most of what it selects, so its drift is the same
// bug wearing an alias.
const PAIRS = [
  [index, datasource],
  [require('../../azure/search/indexes/projects.json'),
    require('../../azure/search/datasources/demi-projects-ds.json')],
  // The two keyword indexes. `activities` is fed by the `updates` container and
  // `project-notifications` by `notifications`, so the data-source name follows the CONTAINER and
  // the index name follows the dataset — the same split the README describes.
  [require('../../azure/search/indexes/activities.json'),
    require('../../azure/search/datasources/demi-updates-ds.json')],
  [require('../../azure/search/indexes/project-notifications.json'),
    require('../../azure/search/datasources/demi-notifications-ds.json')]
];

// Selected for the change detection policy, not for the index — the only column with no field.
const NOT_INDEXED = new Set(['_ts']);

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

// The chunks pair is not in PAIRS above: `chunkId` is filled by a field MAPPING on the indexer
// (`id` -> `chunkId`), not by the query, so the generic both-directions check cannot hold for it.
// The parent fields it repeats off the document are pinned by name instead — three files that never
// see each other, and the code is the one that decides what a chunk carries.
test('the chunk parent fields are declared, projected and named in one place', () => {
  const { CHUNK_PARENT_FIELDS, CHUNK_PARENT_LIST_REFS } = require('../../src/repositories/chunks');
  const chunkIndex = require('../../azure/search/indexes/chunks.json');
  const chunkDatasource = require('../../azure/search/datasources/demi-chunks-ds.json');
  const documentFields = new Map(index.fields.map(f => [f.name, f]));
  const projected = projectedColumns(chunkDatasource.container.query);

  assert.ok(CHUNK_PARENT_FIELDS.length > 0, 'the list is empty, so this passes vacuously');

  for (const name of CHUNK_PARENT_FIELDS) {
    const field = chunkIndex.fields.find(f => f.name === name);
    assert.ok(field, `${name} is repeated onto chunks but not declared by the chunks index`);
    // A field the index declares and the query does not project is indexed as null on every row,
    // under a 200 from every PUT and a green indexer run.
    assert.strictEqual(projected.get(name), name,
      `${name} is declared by the chunks index but not selected by ${chunkDatasource.name}`);

    // The point of the copy is filtering a chunk query directly. Searchable would be a rebuild of
    // 1.1M rows and would make an ObjectId match a keyword query.
    assert.strictEqual(field.type, 'Edm.String');
    assert.strictEqual(field.filterable, true);
    assert.strictEqual(field.searchable, false);
    // FACETABLE only on the List refs, which are what the filter panel counts. `projectId` is the
    // access-scope column and was never faceted — and a field's facetability cannot be changed by a
    // PUT, so asserting it here would demand a rebuild of the whole index.
    if (CHUNK_PARENT_LIST_REFS.includes(name)) assert.strictEqual(field.facetable, true);

    // Same name and same type as the column on the parent, or the two filters disagree about what
    // the value even is.
    const parent = documentFields.get(name);
    assert.ok(parent, `${name} is not a field of the documents index it is copied from`);
    assert.strictEqual(field.type, parent.type);
  }
});

// The stamp that says a chunk WAS stamped, pinned across the same three files. The loop above
// cannot cover it: it has no counterpart on the documents index and it is a number, not a List id.
//
// Missing from the query is the whole point of the failure it guards. `chunks-indexer` would pull
// every re-stamped row, find no such column, and index the field as null on all 1.1M — under a 200
// from the data-source PUT and a green indexer run — so the completeness probe would count the
// entire corpus as never stamped and the degraded banner would stay up permanently.
test('the chunk parent-fields version is declared, projected and filterable', () => {
  const { CHUNK_PARENT_FIELDS_VERSION } = require('../../src/repositories/chunks');
  const chunkIndex = require('../../azure/search/indexes/chunks.json');
  const chunkDatasource = require('../../azure/search/datasources/demi-chunks-ds.json');

  assert.strictEqual(typeof CHUNK_PARENT_FIELDS_VERSION, 'number');
  assert.ok(Number.isInteger(CHUNK_PARENT_FIELDS_VERSION) && CHUNK_PARENT_FIELDS_VERSION >= 1,
    'the version is an Edm.Int32 written on every chunk, so it has to be a positive integer');

  const field = chunkIndex.fields.find(f => f.name === 'parentFieldsVersion');
  assert.ok(field, 'parentFieldsVersion is stamped on every chunk but not declared by the index');
  assert.strictEqual(projectedColumns(chunkDatasource.container.query).get('parentFieldsVersion'),
    'parentFieldsVersion',
    `parentFieldsVersion is declared by the chunks index but not selected by ${chunkDatasource.name}`);

  // The probe compares it with `lt` against a number, so Edm.String would make that filter a
  // string comparison and "10" would sort below "2".
  assert.strictEqual(field.type, 'Edm.Int32');
  assert.strictEqual(field.filterable, true);
  assert.strictEqual(field.retrievable, true);
  // Nothing groups or orders by a schema revision, and both cost index size on 1.1M rows.
  assert.strictEqual(field.facetable, false);
  assert.strictEqual(field.sortable, false);
  assert.strictEqual(field.searchable, false);
});

// The other direction for the one chunk field that must NOT reach the index. `parentStampedAt`
// orders concurrent re-stamp walks and answers no query; adding it to the data source would pull
// every one of the 1.1M rows through the indexer for a column nothing filters on, and declaring it
// on the index is a PUT plus a full pass. It has to be selected back out of both.
test('the chunk re-stamp token is neither projected nor indexed', () => {
  const { STAMPED_AT_FIELD } = require('../../src/repositories/chunks');
  const chunkIndex = require('../../azure/search/indexes/chunks.json');
  const chunkDatasource = require('../../azure/search/datasources/demi-chunks-ds.json');

  assert.ok(!projectedColumns(chunkDatasource.container.query).has(STAMPED_AT_FIELD),
    `${STAMPED_AT_FIELD} is a write-ordering guard, not a column ${chunkDatasource.name} selects`);
  assert.strictEqual(chunkIndex.fields.find(f => f.name === STAMPED_AT_FIELD), undefined,
    `${STAMPED_AT_FIELD} is declared by the chunks index, which nothing writes to it`);
});

// `vis` is the only column the projects query computes rather than reads: the container stores an
// object, the index has no map type, and an indexer given the bare object writes null — every dial
// then falls back to defaultVis with the whole suite green.
test('the projects vis column is serialized to text', () => {
  const [idx, ds] = PAIRS[1];
  const projected = projectedColumns(ds.container.query);

  assert.strictEqual(projected.get('vis'), 'ToString(c.vis)');
  assert.strictEqual(idx.fields.find(f => f.name === 'vis').type, 'Edm.String');
});

// A rename in the data source and the dial translation in `src/vis/catalog/index-projects-renames.js`
// are two files that never see each other. search-drift.test.js walks the entries that EXIST; it
// cannot see an alias added here with no entry, and that alias is exactly the case where a stored
// dial key stops matching any field on a hit — `dialsForIndex` drops it and the field ships.
test('every column the projects data source renames is translated by PROJECT_TO_INDEX', () => {
  const { PROJECT_TO_INDEX } = require('../../src/vis/catalog/index-projects-renames');
  const [, ds] = PAIRS[1];

  for (const [alias, expr] of projectedColumns(ds.container.query)) {
    // `ToString(c.vis) AS vis` is a serialization, and `c.eacDecision._id` dials off its ROOT
    // property — that is the name `PATCH /projects/:id/visibility` stores.
    const call = /^\w+\(\s*c?\.?([\w.]+)\s*\)$/.exec(expr);
    const stored = (call ? call[1] : expr).split('.')[0];
    if (stored === alias) continue;

    assert.ok((PROJECT_TO_INDEX[stored] || []).includes(alias),
      `${stored} is aliased to ${alias}, so a dial on ${stored} needs that alias in PROJECT_TO_INDEX`);
  }
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
  assert.strictEqual(field('fileSize').type, 'Edm.Int64');
  assert.strictEqual(projected.get('isFeatured'), 'isFeatured');
  assert.strictEqual(projected.get('documentSource'), 'documentSource');
  assert.strictEqual(projected.get('fileSize'), 'fileSize');

  // Same text as `documentFileName`, a second time under the `filename` analyzer. Sourcing it from
  // any other column would tokenize the wrong string.
  assert.strictEqual(field('fileNameTokens').analyzer, 'filename');
  assert.strictEqual(field('fileNameTokens').searchable, true);
  assert.strictEqual(projected.get('fileNameTokens'), 'documentFileName');
  assert.ok(projected.has('documentFileName'),
    'the plain column must stay: dropping it would re-analyze documentFileName, which is a rebuild');
});

// `nameTokens` exists because `en.microsoft` strips stopwords like "mine" from every other
// searchable projects field, so a name search for one matched nothing. Same trade as
// `fileNameTokens`: the text a second time under a stopword-free analyzer, plain column untouched.
test('the projects nameTokens field is declared and sourced as intended', () => {
  const [idx, ds] = PAIRS[1];
  const field = idx.fields.find(f => f.name === 'nameTokens');
  const projected = projectedColumns(ds.container.query);

  assert.strictEqual(field.analyzer, 'filename');
  assert.strictEqual(field.searchable, true);
  assert.strictEqual(projected.get('nameTokens'), 'name');
  assert.ok(projected.has('name'),
    'the plain column must stay: dropping it would re-analyze name, which is a rebuild');
  // Analyzers are index-scoped: naming one the index does not define is a 400 on the PUT.
  assert.ok(idx.analyzers.some(a => a.name === 'filename'));
  assert.ok(idx.tokenizers.some(t => t.name === 'filename_tokenizer'));
});
