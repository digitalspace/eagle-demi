'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { code } = require('../helpers/router-source');
const aiSearch = require('../../src/search/ai-search');
const { catalogFor } = require('../../src/vis/catalog');

const AI_SEARCH_PATH = path.join(__dirname, '..', '..', 'src', 'search', 'ai-search.js');

// The index definition and the catalog are edited by different people for different reasons — a
// field arrives in one PUT and gets classified in another, or never. These cases are the ratchet
// between them: they fail on the change that ships a restricted field to a search caller.
const INDEX_CATALOGS = [
  ['projects', 'index-projects'],
  ['documents', 'index-documents']
];

/**
 * Selected on purpose and dropped by the redactor: `read` is what `isPublished` is derived from,
 * `vis` is the dial map the redactor reads. Both are maxVis 0, so neither reaches a caller.
 */
const POLICY_FIELDS = new Set(['read', 'vis']);

test('DOCUMENT_SELECT is a subset of maxVis 4 index fields', () => {
  const catalog = catalogFor('index-documents');
  const names = aiSearch.DOCUMENT_SELECT.split(',');
  assert.ok(names.length > 1, 'the select must not be empty, or this passes vacuously');

  for (const name of names) {
    assert.ok(catalog[name], `${name} is selected but not catalogued in index-documents`);
    assert.strictEqual(catalog[name].maxVis, POLICY_FIELDS.has(name) ? 0 : 4,
      `${name} is selected, so it reaches the mapper at every level`);
  }
});

test('PROJECT_SELECT is a subset of maxVis 4 index fields', () => {
  const catalog = catalogFor('index-projects');
  const names = aiSearch.PROJECT_SELECT.split(',');
  assert.ok(names.length > 1, 'the select must not be empty, or this passes vacuously');

  for (const name of names) {
    assert.ok(catalog[name], `${name} is selected but not catalogued in index-projects`);
    assert.strictEqual(catalog[name].maxVis, POLICY_FIELDS.has(name) ? 0 : 4,
      `${name} is selected, so it reaches the mapper at every level`);
  }
});

// Chunk text has two enforcement points and both are asserted here: the catalog entry, and the
// select string (docs/rbac-architecture.md §2 item 9 — semantic ranking needs `content` retrievable
// in the index, so the index cannot hold the line). The select is read off the source, comments
// stripped, because it is an inline literal and not an exported constant.
test('content is maxVis 0 and absent from every select', () => {
  assert.strictEqual(catalogFor('chunks').content.maxVis, 0,
    'a chunk field above maxVis 0 would be shippable; chunk text is never a response field');

  const source = code(fs.readFileSync(AI_SEARCH_PATH, 'utf8'));
  const selects = [...source.matchAll(/select: '([^']*)'/g)].map(m => m[1]);
  const chunkSelects = selects.filter(s => s.split(',').includes('chunkId'));

  assert.strictEqual(chunkSelects.length, 1, 'exactly one select names chunkId');
  assert.strictEqual(chunkSelects[0], 'chunkId,documentId,projectId,pageNumber,read',
    'adding a name here ships that column to every chunk caller; `content` ships whole chunk text');
  for (const select of selects) {
    assert.ok(!select.split(',').includes('content'), `content is selected by '${select}'`);
  }
});

test('every retrievable index field is catalogued at maxVis 4', () => {
  for (const [index, entity] of INDEX_CATALOGS) {
    const definition = require(`../../azure/search/indexes/${index}.json`);
    const catalog = catalogFor(entity);
    const retrievable = definition.fields.filter(f => f.retrievable !== false);
    assert.ok(retrievable.length > 0, `${index}.json carries no retrievable field`);

    for (const field of retrievable) {
      assert.ok(catalog[field.name],
        `${index}.${field.name} is retrievable but absent from ${entity}`);
      assert.strictEqual(catalog[field.name].maxVis, POLICY_FIELDS.has(field.name) ? 0 : 4,
        `${index}.${field.name} is retrievable, so a hit carries it`);
    }
  }
});

// `vis` is the classification itself. Retrievable, because the redactor reads the dials off the
// hit; never searchable, because a searchable dial map lets a caller find records BY their
// classification — a term query for a dialled field name would enumerate every dialled row.
// Filterable and facetable are the same leak through a different door.
test('vis is retrievable and never searchable', () => {
  const definition = require('../../azure/search/indexes/projects.json');
  const vis = definition.fields.find(f => f.name === 'vis');

  assert.ok(vis, 'projects.json has no vis field, so search hits carry no dials at all');
  assert.strictEqual(vis.type, 'Edm.String', 'the index has no map type; the dials are JSON text');
  assert.strictEqual(vis.retrievable, true, 'the redactor cannot apply a dial it never receives');
  assert.strictEqual(vis.searchable, false, 'a searchable dial map is a classification oracle');
  assert.strictEqual(vis.filterable, false, 'so is a filterable one');
  assert.strictEqual(vis.facetable, false, 'a facet count over dials answers the same question');
});

// The dial keys are stored in the Cosmos vocabulary and applied to a hit in the index one, so the
// rename map is the third file that has to move when a column is renamed. An entry pointing at a
// key that no longer exists on either side is silent: the dial simply stops applying.
test('every rename maps a real stored field onto a real index field', () => {
  const { PROJECT_TO_INDEX, dialsForIndex } = require('../../src/vis/catalog/index-projects-renames');
  const stored = catalogFor('projects');
  const hit = catalogFor('index-projects');

  for (const [from, targets] of Object.entries(PROJECT_TO_INDEX)) {
    assert.ok(stored[from], `${from} is mapped but is not a projects field`);
    for (const to of targets) {
      assert.ok(hit[to], `${from} maps to ${to}, which is not an index-projects field`);
    }
  }

  // The two ends of the translation the map exists for, plus the passthrough and the drop.
  assert.deepStrictEqual(
    dialsForIndex({ proponentName: 2, description: 2, complianceLead: 2 }),
    { proponent: 2, description: 2 },
    'renamed keys translate, same-named keys pass through, index-less keys are dropped');
});
