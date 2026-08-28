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

/** `read` is selected on purpose — the redactor derives `isPublished` from it and then drops it. */
const ACL_FIELD = 'read';

test('DOCUMENT_SELECT is a subset of maxVis 4 index fields', () => {
  const catalog = catalogFor('index-documents');
  const names = aiSearch.DOCUMENT_SELECT.split(',');
  assert.ok(names.length > 1, 'the select must not be empty, or this passes vacuously');

  for (const name of names) {
    assert.ok(catalog[name], `${name} is selected but not catalogued in index-documents`);
    assert.strictEqual(catalog[name].maxVis, name === ACL_FIELD ? 0 : 4,
      `${name} is selected, so it reaches the mapper at every level`);
  }
});

test('PROJECT_SELECT is a subset of maxVis 4 index fields', () => {
  const catalog = catalogFor('index-projects');
  const names = aiSearch.PROJECT_SELECT.split(',');
  assert.ok(names.length > 1, 'the select must not be empty, or this passes vacuously');

  for (const name of names) {
    assert.ok(catalog[name], `${name} is selected but not catalogued in index-projects`);
    assert.strictEqual(catalog[name].maxVis, name === ACL_FIELD ? 0 : 4,
      `${name} is selected, so it reaches the mapper at every level`);
  }
});

// Chunks have no catalog: their enforcement point is this string, not the index
// (docs/rbac-architecture.md §2 item 9 — semantic ranking needs `content` retrievable). Read off
// the source, comments stripped, because it is an inline literal and not an exported constant.
test('chunk select never names content', () => {
  const source = code(fs.readFileSync(AI_SEARCH_PATH, 'utf8'));
  const selects = [...source.matchAll(/select: '([^']*)'/g)].map(m => m[1]);
  const chunkSelects = selects.filter(s => s.split(',').includes('chunkId'));

  assert.strictEqual(chunkSelects.length, 1, 'exactly one select names chunkId');
  assert.strictEqual(chunkSelects[0], 'chunkId,documentId,projectId,pageNumber,read',
    'adding a name here ships that column to every chunk caller; `content` ships whole chunk text');
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
      assert.strictEqual(catalog[field.name].maxVis, field.name === ACL_FIELD ? 0 : 4,
        `${index}.${field.name} is retrievable, so a hit carries it`);
    }
  }
});
