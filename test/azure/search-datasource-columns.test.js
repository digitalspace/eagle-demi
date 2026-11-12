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
  // Data-source names follow the container, index names the dataset.
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

  // The indexer silently drops a column the index does not declare, so a rename ships half done.
  test(`every column ${ds.name} selects is declared by ${idx.name}`, () => {
    const declared = new Set(idx.fields.map(f => f.name));
    const extra = [...projectedColumns(ds.container.query).keys()]
      .filter(name => !declared.has(name) && !NOT_INDEXED.has(name));
    assert.deepStrictEqual(extra, [],
      `selected by ${ds.name} but not declared by ${idx.name}: ${extra.join(', ')}`);
  });
}

// Chunks are not in PAIRS: `chunkId` comes from an indexer field mapping, not the query, so the
// parent fields are pinned by name instead.
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
    // Facetable only on List refs: facetability cannot change by PUT, so asserting it on projectId
    // would demand a full rebuild.
    if (CHUNK_PARENT_LIST_REFS.includes(name)) assert.strictEqual(field.facetable, true);

    // Same name and same type as the column on the parent, or the two filters disagree about what
    // the value even is.
    const parent = documentFields.get(name);
    assert.ok(parent, `${name} is not a field of the documents index it is copied from`);
    assert.strictEqual(field.type, parent.type);
  }
});

// Unprojected, the indexer writes null on every chunk and the completeness probe keeps the
// degraded banner up for good.
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

// Unprojected, every re-extracted document silently falls back to "Passage N".
test('the chunk page flag is declared, projected and filterable', () => {
  const chunkIndex = require('../../azure/search/indexes/chunks.json');
  const chunkDatasource = require('../../azure/search/datasources/demi-chunks-ds.json');

  const field = chunkIndex.fields.find(f => f.name === 'pageNumbered');
  assert.ok(field, 'pageNumbered is stamped on chunks but not declared by the chunks index');
  assert.strictEqual(projectedColumns(chunkDatasource.container.query).get('pageNumbered'),
    'pageNumbered',
    `pageNumbered is declared by the chunks index but not selected by ${chunkDatasource.name}`);

  assert.strictEqual(field.type, 'Edm.Boolean');
  // The chunk select asks for it on every Deep Search, and a caller cannot tell "Page 12" from
  // "Passage 12" without it.
  assert.strictEqual(field.retrievable, true);
  // Filterable so a backfill can count what is left to re-extract without reading the rows.
  assert.strictEqual(field.filterable, true);
  assert.strictEqual(field.searchable, false, 'a searchable boolean answers keyword queries');
  // Both cost index size on 1.1M rows and nothing orders or facets on it.
  assert.strictEqual(field.sortable, false);
  assert.strictEqual(field.facetable, false);
});

// Only orders concurrent re-stamp walks; projecting or declaring it costs a full indexer pass for
// a column no query reads.
test('the chunk re-stamp token is neither projected nor indexed', () => {
  const { STAMPED_AT_FIELD } = require('../../src/repositories/chunks');
  const chunkIndex = require('../../azure/search/indexes/chunks.json');
  const chunkDatasource = require('../../azure/search/datasources/demi-chunks-ds.json');

  assert.ok(!projectedColumns(chunkDatasource.container.query).has(STAMPED_AT_FIELD),
    `${STAMPED_AT_FIELD} is a write-ordering guard, not a column ${chunkDatasource.name} selects`);
  assert.strictEqual(chunkIndex.fields.find(f => f.name === STAMPED_AT_FIELD), undefined,
    `${STAMPED_AT_FIELD} is declared by the chunks index, which nothing writes to it`);
});

// The index has no map type; given the bare object the indexer writes null and every dial falls
// back to defaultVis.
test('the projects vis column is serialized to text', () => {
  const [idx, ds] = PAIRS[1];
  const projected = projectedColumns(ds.container.query);

  assert.strictEqual(projected.get('vis'), 'ToString(c.vis)');
  assert.strictEqual(idx.fields.find(f => f.name === 'vis').type, 'Edm.String');
});

// `legislationYear` is Edm.Int32 and projects-indexer runs with `maxFailedItems: 0`, so one stored
// row with a string year fails the document and stops the whole indexer run. Non-numbers go in null.
test('the projects legislationYear column only hands the indexer a number', () => {
  const [idx, ds] = PAIRS[1];

  assert.strictEqual(projectedColumns(ds.container.query).get('legislationYear'),
    '(IS_NUMBER(c.legislationYear) ? c.legislationYear : null)');
  assert.strictEqual(idx.fields.find(f => f.name === 'legislationYear').type, 'Edm.Int32');
});

// Same `maxFailedItems: 0` rule: tags that are not a list of strings stop the whole run.
test('the projects tags columns only hand the indexer a list of strings', () => {
  const [, ds] = PAIRS[1];
  const columns = projectedColumns(ds.container.query);

  for (const alias of ['tags', 'tagsTokens']) {
    assert.strictEqual(columns.get(alias),
      '(IS_ARRAY(c.tags) ? ARRAY(SELECT VALUE t FROM t IN c.tags WHERE IS_STRING(t)) : null)');
  }
});

// The assessment columns, guarded for the same `maxFailedItems: 0` reason as `legislationYear`.
test('the projects assessment columns are guarded, filterable and public', () => {
  const [idx, ds] = PAIRS[1];
  const columns = projectedColumns(ds.container.query);
  const catalog = require('../../src/vis/catalog/index-projects');
  const { PROJECT_TO_INDEX } = require('../../src/vis/catalog/index-projects-renames');
  const expected = {
    phaseIds: ['Collection(Edm.String)',
      '(IS_ARRAY(c.phaseIds) ? ARRAY(SELECT VALUE p FROM p IN c.phaseIds WHERE IS_STRING(p)) : null)'],
    activeWorkId: ['Edm.Int32', '(IS_NUMBER(c.activeWork.trackWorkId) ? c.activeWork.trackWorkId : null)'],
    activeWorkAct: ['Edm.String', '(IS_STRING(c.activeWork.eaAct) ? c.activeWork.eaAct : null)'],
    activeWorkType: ['Edm.String', '(IS_STRING(c.activeWork.workType) ? c.activeWork.workType : null)'],
    activeWorkPhase: ['Edm.String', '(IS_STRING(c.activeWork.currentPhase) ? c.activeWork.currentPhase : null)']
  };

  for (const [name, [type, expr]] of Object.entries(expected)) {
    const field = idx.fields.find(f => f.name === name);
    assert.ok(field, `the projects index must declare ${name}`);
    assert.deepStrictEqual(
      [field.type, field.filterable, field.retrievable, field.searchable, field.sortable, field.facetable],
      [type, true, true, false, false, false], name);
    assert.strictEqual(columns.get(name), expr);
    assert.deepStrictEqual(catalog[name], { defaultVis: 4, maxVis: 4 }, name);
  }
  assert.deepStrictEqual(PROJECT_TO_INDEX.activeWork,
    ['activeWorkId', 'activeWorkAct', 'activeWorkType', 'activeWorkPhase']);
});

// A projection reading a key the merge never stores indexes null forever and fails nothing.
test('the projects activeWork columns read keys the merge stores', () => {
  const { deriveAssessments } = require('../../src/merge/assessments');
  const fx = require('../fixtures/act-assessments');
  const stored = Object.keys(deriveAssessments(fx.only2018WithWorks()).activeWork);
  const read = [...PAIRS[1][1].container.query.matchAll(/c\.activeWork\.(\w+)/g)].map(match => match[1]);
  assert.ok(read.length, 'the projection must read activeWork');
  assert.deepStrictEqual(read.filter(key => !stored.includes(key)), []);
});

// Searchable so an old name finds the project; never retrievable, like `nameTokens` and
// `searchLabels` (see src/vis/catalog/index-projects.js).
test('the projects tags field is a searchable, non-retrievable string list', () => {
  const [idx] = PAIRS[1];
  const field = idx.fields.find(f => f.name === 'tags');

  assert.ok(field, 'the projects index must declare tags');
  assert.strictEqual(field.type, 'Collection(Edm.String)');
  assert.strictEqual(field.searchable, true);
  assert.strictEqual(field.retrievable, false);
});

// `tags` under the `filename` analyzer, for the same reason as `nameTokens`.
test('the projects tagsTokens field is a searchable, non-retrievable string list under filename', () => {
  const [idx] = PAIRS[1];
  const field = idx.fields.find(f => f.name === 'tagsTokens');

  assert.ok(field, 'the projects index must declare tagsTokens');
  assert.strictEqual(field.type, 'Collection(Edm.String)');
  assert.strictEqual(field.analyzer, 'filename');
  assert.strictEqual(field.searchable, true);
  assert.strictEqual(field.retrievable, false);
});

// search-drift.test.js only walks existing entries; an alias with no PROJECT_TO_INDEX entry makes
// `dialsForIndex` drop the dial and the field ships.
test('every column the projects data source renames is translated by PROJECT_TO_INDEX', () => {
  const { PROJECT_TO_INDEX } = require('../../src/vis/catalog/index-projects-renames');
  const [, ds] = PAIRS[1];

  for (const [alias, expr] of projectedColumns(ds.container.query)) {
    // `ToString(c.vis) AS vis` is a serialization, and `c.eacDecision._id` dials off its ROOT
    // property — that is the name `PATCH /projects/:id/visibility` stores.
    const call = /^\w+\(\s*c?\.?([\w.]+)\s*\)$/.exec(expr);
    // `(IS_NUMBER(c.x) ? c.x : null) AS x` is a type guard on x, and only when both sides name x.
    const guard = /^\(\s*IS_\w+\(\s*c\.([\w.]+)\s*\)\s*\?\s*c\.\1\s*:\s*null\s*\)$/.exec(expr);
    // Anything else (`searchLabels`) is built from several columns, and a dial on each must reach it.
    const sources = guard || call || !/\bc\./.test(expr)
      ? [guard ? guard[1] : call ? call[1] : expr]
      : [...new Set([...expr.matchAll(/\bc\.([\w.]+)/g)].map(m => m[1]))];
    for (const stored of sources.map(s => s.split('.')[0])) {
      if (stored === alias) continue;
      assert.ok((PROJECT_TO_INDEX[stored] || []).includes(alias),
        `${stored} is aliased to ${alias}, so a dial on ${stored} needs that alias in PROJECT_TO_INDEX`);
    }
  }
});

test('searchLabels joins the six label columns, each guarded so a missing one cannot null the rest', () => {
  const [, ds] = PAIRS[1];
  const expr = projectedColumns(ds.container.query).get('searchLabels');
  for (const path of ['sector', 'projectSubType', 'projectState', 'region', 'projectType',
    'currentPhaseName.name', 'eacDecision.name']) {
    assert.ok(expr.includes(`IS_STRING(c.${path})`), `${path} is not in searchLabels, or is unguarded`);
  }
});

// Same rule as `wireSector` in src/controllers/search.js: a blank sector yields to the sub-type.
test('searchLabels falls back to the sub-type when the sector is blank', () => {
  const [, ds] = PAIRS[1];
  const expr = projectedColumns(ds.container.query).get('searchLabels');
  assert.match(expr, new RegExp(
    String.raw`\(IS_STRING\(c\.sector\) AND LENGTH\(TRIM\(c\.sector\)\) > 0 \? c\.sector : ` +
    String.raw`\(IS_STRING\(c\.projectSubType\) \? c\.projectSubType : ''\)\)`));
});

// The generic check passes a wrong type or a wrong alias source; both fail silently.
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

// Paged documents sort by author through this field. Lower-cased so capitalised names do not all
// sort before lower-case ones, as `displayNameSort` is stored.
test('documentAuthorSort is a sortable string fed by the lower-cased author', () => {
  const field = index.fields.find(f => f.name === 'documentAuthorSort');
  const projected = projectedColumns(datasource.container.query);

  assert.ok(field, 'the documents index must declare documentAuthorSort');
  assert.strictEqual(field.type, 'Edm.String');
  assert.strictEqual(field.sortable, true);
  assert.strictEqual(field.searchable, false,
    'a sort key is not text anyone searches for, and searchable here would be a rebuild to undo');
  assert.strictEqual(projected.get('documentAuthorSort'), 'LOWER(c.documentAuthor)');
});

// `en.microsoft` strips stopwords like "mine", so the name is indexed again under a stopword-free
// analyzer.
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

// `eagle-query` reads these flags from the committed JSON; a wrong flag silently drops the key
// into `meta.dropped` and serves an unfiltered page.
test('the fields the search page sorts and filters on carry the flags that make them usable', () => {
  const projects = require('../../azure/search/indexes/projects.json');
  const activities = require('../../azure/search/indexes/activities.json');

  const dateUpdated = projects.fields.find(f => f.name === 'dateUpdated');
  assert.ok(dateUpdated, 'the projects index must carry dateUpdated — `sortBy=-dateUpdated`');
  assert.strictEqual(dateUpdated.type, 'Edm.DateTimeOffset');
  assert.strictEqual(dateUpdated.sortable, true);
  assert.strictEqual(dateUpdated.filterable, true, 'and the dateUpdatedStart/End range');
  assert.strictEqual(dateUpdated.retrievable, true, 'the "Last updated" column renders it');

  const documentUrl = activities.fields.find(f => f.name === 'documentUrl');
  assert.ok(documentUrl, 'the activities index must carry documentUrl — "has an attachment"');
  assert.strictEqual(documentUrl.type, 'Edm.String');
  assert.strictEqual(documentUrl.filterable, true);
  assert.strictEqual(documentUrl.searchable, false,
    'a URL is not text anyone searches for, and searchable here would be a rebuild to undo');
  assert.strictEqual(documentUrl.retrievable, false,
    'the row is read back from Cosmos: this index answers which rows match and nothing else');
});

// documents-indexer runs with `maxFailedItems: 0`: one dial the Int32 cannot hold stops the run.
test('searchVis is Int32, filterable, not retrievable, projected with an IS_INTEGER guard', () => {
  const field = index.fields.find(f => f.name === 'searchVis');
  assert.ok(field, 'the documents index must declare searchVis');
  assert.strictEqual(field.type, 'Edm.Int32');
  assert.strictEqual(field.filterable, true);
  assert.strictEqual(field.retrievable, false, 'a hit must not carry the dials of its row');
  assert.strictEqual(field.searchable, false);
  assert.strictEqual(field.sortable, false);
  assert.strictEqual(field.facetable, false);

  const expr = projectedColumns(datasource.container.query).get('searchVis');
  assert.ok(expr, `${datasource.name} must project searchVis`);
  for (const path of ['displayName', 'documentFileName', 'description']) {
    assert.ok(expr.includes(`IS_INTEGER(c.vis.${path})`), `the ${path} dial is unguarded`);
  }
});

/** The searchVis projection run as JS; every comparison sits behind IS_INTEGER, so both agree. */
function searchVisOf(row) {
  const js = projectedColumns(datasource.container.query).get('searchVis')
    .replace(/NOT IS_DEFINED\(([\w.]+)\)/g, '($1 === undefined)')
    .replace(/IS_INTEGER\(([\w.]+)\)/g, 'Number.isInteger($1)')
    .replace(/\bc\.vis\./g, 'c.vis?.')
    .replace(/ AND /g, ' && ')
    .replace(/ OR /g, ' || ');
  assert.doesNotMatch(js, /\b[A-Z_]{2,}\b/, `untranslated Cosmos SQL left in: ${js}`);
  return new Function('c', `return ${js};`)(row);
}

test('searchVis is the lowest dial over the three searched fields, 4 when none is set', () => {
  assert.strictEqual(searchVisOf({}), 4, 'a row with no vis object');
  assert.strictEqual(searchVisOf({ vis: {} }), 4);
  assert.strictEqual(searchVisOf({ vis: { description: 2 } }), 2);
  assert.strictEqual(searchVisOf({ vis: { displayName: 3, documentFileName: 1, description: 2 } }), 1);
  assert.strictEqual(searchVisOf({ vis: { displayName: 0 } }), 0, 'the sealed compartment only');
  assert.strictEqual(searchVisOf({ vis: { projectId: 1 } }), 4, 'a dial on an unsearched field');
});

// Same answer `dialAllows` gives a string or null in Cosmos: hidden at every level.
test('searchVis holds -1 for a dial that is not an integer, and stays between -1 and 4', () => {
  assert.strictEqual(searchVisOf({ vis: { displayName: '2' } }), -1);
  assert.strictEqual(searchVisOf({ vis: { documentFileName: 2.5 } }), -1);
  assert.strictEqual(searchVisOf({ vis: { description: null } }), -1);
  assert.strictEqual(searchVisOf({ vis: { description: -7 } }), -1);
  assert.strictEqual(searchVisOf({ vis: { displayName: 2 ** 40 } }), 4, 'clamped, so Int32 holds it');
});
