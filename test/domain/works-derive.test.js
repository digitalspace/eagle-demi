'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../src/config');
const cosmos = require('../../src/db/cosmos-nosql');
const phaseCatalog = require('../../src/domain/phase-catalog');
const { TRACK_ACT_YEAR } = require('../../src/merge/assessment-work');
const { deriveInputs } = require('../../src/domain/works-derive');

test('deriveInputs', async (t) => {
  const stored = [
    { id: 'track-2', projectId: 'p1', trackWorkId: 2, workType: 'Assessment', simpleTitle: 'Mine', eaAct: null,
      phases: [{ trackName: 'Early Engagement', phaseCodeId: 7, milestones: [{ name: 'Start' }] }] },
    { id: 'track-3', projectId: 'p1', deleted: true, pushStamps: { work: 5 } },
    { id: 'track-9', projectId: 'p2', trackWorkId: 9, phases: [] }
  ];
  const row = { id: 'p1', sources: { track: { name: 'Pine Mine' } } };
  const queried = [];
  const worksRead = config.worksRead;

  t.beforeEach(() => {
    queried.length = 0;
    t.mock.method(cosmos, 'query', async (container, _spec, { partitionKey }) => {
      queried.push(container);
      return { items: stored.filter(doc => doc.projectId === partitionKey), continuationToken: undefined };
    });
  });
  t.afterEach(() => {
    config.worksRead = worksRead;
    t.mock.restoreAll();
  });

  await t.test('with WORKS_READ off it is empty and reads no container', async () => {
    config.worksRead = false;

    assert.deepStrictEqual(await deriveInputs(row), {});
    assert.deepStrictEqual(queried, []);
  });

  await t.test('with WORKS_READ on it gives the project\'s live works in public shape, named by the catalog', async () => {
    config.worksRead = true;
    const catalog = { [TRACK_ACT_YEAR]: [{ catalogId: 'eagle-ee', name: 'Early Engagement', trackPhaseCodeIds: [7] }] };
    t.mock.method(phaseCatalog, 'load', async () => catalog);

    const out = await deriveInputs(row);

    assert.strictEqual(out.catalog, catalog);
    assert.deepStrictEqual(out.worksForDerive.map(w => [w.trackWorkId, w.title, w.phases[0].catalogId, w.milestones.length]),
      [[2, 'Pine Mine - Assessment - Mine', 'eagle-ee', 1]]);
  });

  await t.test('an empty catalog goes as undefined, so the name rules apply', async () => {
    config.worksRead = true;
    t.mock.method(phaseCatalog, 'load', async () => ({ [TRACK_ACT_YEAR]: [] }));

    const out = await deriveInputs(row);

    assert.strictEqual(out.catalog, undefined);
    assert.strictEqual(out.worksForDerive[0].phases[0].catalogId, 'track-7');
  });
});
