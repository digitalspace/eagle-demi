'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { workDocOf, publicWorksOf, trackWorkToPublic, phaseEventsOf } = require('../../src/seed/track-mappers');

/** Track's nested work, two phases listed out of order, a HIDDEN event and a decision in each phase. */
const nestedWork = () => structuredClone(require('../fixtures/track-records/new_work_two_phases.json').work);

const ROW = { sources: { track: { name: 'North Mine' } } };

/** Keys the stored-document path adds to today's public works; nothing else may differ. */
const ADDED_PHASE_KEYS = ['trackPhaseId', 'phaseCodeId', 'catalogId', 'catalogName', 'stage', 'order',
  'isSuspended', 'suspendedDate'];

function withoutAddedKeys(work) {
  const strip = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([key]) => !keys.includes(key)));
  return { ...work,
    phases: work.phases.map(phase => strip(phase, ADDED_PHASE_KEYS)),
    milestones: work.milestones.map(milestone => strip(milestone, ['trackEventId'])) };
}

test('a stored work document reads back as the public work the nightly builds from the same Track data', () => {
  // Track's `/works` rows carry the title its `generate_title` built; the push leaves it out.
  const work = { ...nestedWork(), title: 'North Mine - Assessment - North Pit' };

  const [composed] = publicWorksOf([workDocOf(work, { projectId: 'p-1' })], ROW);

  assert.deepStrictEqual(withoutAddedKeys(composed), trackWorkToPublic(work, phaseEventsOf(work)));
  assert.strictEqual(composed.outcome, 'Proceed', 'the END outcome of the last phase, not the earlier one');
});

test('a work with no simple title is titled by project name and work type alone', () => {
  const work = { ...nestedWork(), simple_title: '' };

  const [composed] = publicWorksOf([workDocOf(work)], ROW);

  assert.strictEqual(composed.title, 'North Mine - Assessment');
});

test('each milestone stays under its phase in the stored document', () => {
  const doc = workDocOf(nestedWork());

  assert.deepStrictEqual(doc.phases.map(p => [p.trackPhaseId, p.milestones.map(m => m.trackEventId)]),
    [[3001, [4001, 4003]], [3002, [4004, 4005]]], 'by sort order, the HIDDEN event 4002 left out');
});

test('a phase the catalog lacks keeps Track name and sort order, with no stage', () => {
  const [composed] = publicWorksOf([workDocOf(nestedWork())], ROW);

  assert.deepStrictEqual(composed.phases.map(p => [p.catalogId, p.catalogName, p.stage, p.order]),
    [['track-6001', 'Effects Assessment', null, 1], ['track-6002', 'Readiness Decision', null, 2]]);
});

test('a phase the catalog holds reads its id, name, stage and order from the entry', () => {
  const catalog = { 2018: [{ catalogId: 'list-1', name: 'Effects Assessment and Review', stage: 'Assessment',
    order: 4, trackPhaseCodeIds: [6001] }] };

  const [composed] = publicWorksOf([workDocOf(nestedWork())], ROW, { catalog });

  assert.deepStrictEqual(composed.phases[0], { ...composed.phases[0], catalogId: 'list-1',
    catalogName: 'Effects Assessment and Review', stage: 'Assessment', order: 4 });
  assert.strictEqual(composed.phases[0].name, 'Effects Assessment', 'the shown name stays Track\'s');
});

test('suspension is carried to the public phase', () => {
  const [composed] = publicWorksOf([workDocOf(nestedWork())], ROW);

  assert.deepStrictEqual(composed.phases.map(p => [p.isSuspended, p.suspendedDate]),
    [[false, null], [true, '2024-05-01T07:00:00.000Z']]);
});

test('a tombstoned work is left out of the public works', () => {
  const live = workDocOf(nestedWork());
  const tombstone = { id: 'track-2000', trackWorkId: 2000, workTypeId: 6, deleted: true, pushStamps: {} };

  assert.deepStrictEqual(publicWorksOf([tombstone, live], ROW).map(w => w.trackWorkId), [2001]);
});
