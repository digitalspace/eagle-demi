'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { resolveProjectLink, normalizeProjectName } = require('../../src/scripts/sync-nrpti');

/**
 * The three lookup maps `syncNrptiData` builds from the existing registry, with one real project
 * in each dimension. Values are canonical project ids (the partition key), never names.
 */
function maps() {
  return {
    eagleIdToProjMap: new Map([
      ['207', '207'],
      ['5cf00c03a266b7e1877504ca', '207']   // an Eagle ObjectId aliasing the same Track project
    ]),
    exactNameToProjMap: new Map([
      ['brule coal mine', '311']
    ]),
    normalizedNameToProjMap: new Map([
      ['brule coal', '311'],
      ['ajax', '412'],
      ['sit', '999']                        // 3 chars — below the token-inclusion floor
    ])
  };
}

test('Priority 1: _epicProjectId wins outright', () => {
  const id = resolveProjectLink(
    { epicProjectId: '5cf00c03a266b7e1877504ca', rawProjName: 'something else entirely' },
    maps()
  );
  assert.strictEqual(id, '207');
});

test('Priority 2: an exact name match is case-insensitive', () => {
  assert.strictEqual(
    resolveProjectLink({ epicProjectId: null, rawProjName: 'Brule Coal Mine' }, maps()),
    '311'
  );
});

test('Priority 3: the normalizer strips the noise words and still matches', () => {
  // normalizeProjectName drops 'mine', 'project', 'facility' etc, so these collapse to 'brule coal'
  assert.strictEqual(normalizeProjectName('Brule Coal Mine Expansion'), 'brule coal');
  assert.strictEqual(
    resolveProjectLink({ epicProjectId: null, rawProjName: 'Brule Coal Mine Expansion' }, maps()),
    '311'
  );
});

test('Priority 3b: a multi-segment name matches on its last resolvable segment', () => {
  assert.strictEqual(
    resolveProjectLink({ epicProjectId: null, rawProjName: 'Conuma Coal Resources Limited - Ajax' }, maps()),
    '412'
  );
});

test('Priority 3c: token inclusion catches a name padded with company and place', () => {
  // The real shape from NRPTI: "conuma coal chetwynd bc brule coal mine" -> normalized contains
  // the existing key 'brule coal' as a whole token run.
  assert.strictEqual(
    resolveProjectLink(
      { epicProjectId: null, rawProjName: 'Conuma Coal Chetwynd BC Brule Coal Mine Site' },
      maps()
    ),
    '311'
  );
});

test('Priority 3c ignores keys shorter than 4 characters', () => {
  // 'sit' would otherwise swallow any name containing it. The floor is what stops a 3-letter
  // registry entry claiming half the corpus.
  assert.strictEqual(
    resolveProjectLink({ epicProjectId: null, rawProjName: 'Northern Sit Holdings' }, maps()),
    null
  );
});

test('an unmatched name returns null — the auto-seed does not come back', () => {
  // THE regression guard. This used to invent a project with a synthetic id
  // `8000000 + hash(name) % 1000000` and publish it alongside real Track projects. If this ever
  // returns a value again, the registry is being written to by a sync that does not own it.
  const id = resolveProjectLink(
    { epicProjectId: null, rawProjName: 'Sooke River Rest Area Pit Toilet' },
    maps()
  );
  assert.strictEqual(id, null);
});

test('an unknown _epicProjectId falls through rather than linking to the wrong project', () => {
  assert.strictEqual(
    resolveProjectLink({ epicProjectId: 'ffffffffffffffffffffffff', rawProjName: '' }, maps()),
    null
  );
});

test('a record with no project name at all returns null', () => {
  assert.strictEqual(resolveProjectLink({ epicProjectId: null, rawProjName: '' }, maps()), null);
});

test('an empty registry links nothing — no name can match', () => {
  const empty = {
    eagleIdToProjMap: new Map(),
    exactNameToProjMap: new Map(),
    normalizedNameToProjMap: new Map()
  };
  assert.strictEqual(
    resolveProjectLink({ epicProjectId: '207', rawProjName: 'Brule Coal Mine' }, empty),
    null
  );
});
