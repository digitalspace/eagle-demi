'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../src/config');
const cosmos = require('../../src/db/cosmos-nosql');
const phaseCatalog = require('../../src/domain/phase-catalog');
const works = require('../../src/repositories/works');
const { TRACK_ACT_YEAR } = require('../../src/merge/assessment-work');
const { publicWorksOf } = require('../../src/seed/track-mappers');
const { deriveInputs, loadWorks } = require('../../src/domain/works-derive');

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

const sheetId = (n) => `sheet-00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const trackWork = (n, fields) => ({ id: `track-${n}`, projectId: 'p1', trackWorkId: n, source: 'track', owner: 'track',
  workTypeId: 7, simpleTitle: `track-${n}`, phases: [], ...fields });
const sheetWork = (n, fields) => ({ id: sheetId(n), projectId: 'p1', source: 'sheet', owner: 'sheet',
  workTypeCode: 'amendment', simpleTitle: `sheet-${n}`, sourceKey: `key-${n}`, phases: [], ...fields });
const markerDoc = (fields) => ({ id: 'sheet-override', projectId: 'p1', kind: 'override', source: 'sheet', owner: 'sheet',
  active: true, boundaryAtLoad: '2025-01-01', certificates: [], hidden: [], trackAlive: [], untilTrack: [],
  pairedTrackWorkIds: [], batchId: 'batch-1', provenance: {}, schemaVersion: 1, ...fields });
const pair = (track, sheet) => ({ trackWorkId: `track-${track}`, sheetWorkId: sheetId(sheet) });
const assessment = trackWork(6, { workTypeId: 6, workState: 'COMPLETED', startDate: '2020-03-01', decisionDate: '2023-10-10' });

/** Stores `docs` with `marker` beside them; returns the ids of every point read. */
function store(t, docs, marker) {
  const reads = [];
  t.mock.method(phaseCatalog, 'load', async () => ({}));
  t.mock.method(cosmos, 'query', async () => ({ items: docs.map(doc => structuredClone(doc)), continuationToken: undefined }));
  t.mock.method(cosmos, 'readItem', async (container, id) => {
    reads.push(id);
    return id === 'sheet-override' && marker ? structuredClone(marker) : null;
  });
  return reads;
}

/** Sorted titles `loadWorks` shows for `docs` with `marker` stored beside them. */
async function shown(t, docs, marker, sources = ['track', 'sheet']) {
  store(t, docs, marker);
  return (await loadWorks({ id: 'p1' }, { sources })).worksForDerive.map(work => work.title).sort();
}

test('loadWorks', async (t) => {
  await t.test('sheet works hidden until listed', async (t) => {
    const before = { worksRead: config.worksRead, worksReadSources: config.worksReadSources };
    t.after(() => Object.assign(config, before));
    store(t, [trackWork(2), sheetWork(1, { workTypeCode: 'assessment' })], null);
    config.worksRead = true;
    config.worksReadSources = ['track'];
    assert.deepStrictEqual((await deriveInputs({ id: 'p1' })).worksForDerive.map(w => w.title), ['track-2']);
    config.worksReadSources = ['track', 'sheet'];
    assert.deepStrictEqual((await deriveInputs({ id: 'p1' })).worksForDerive.map(w => w.title).sort(), ['sheet-1', 'track-2']);
  });

  await t.test('loadWorks honours explicit sources', async (t) => {
    const docs = [trackWork(2), sheetWork(1, { workTypeCode: 'assessment' })];
    assert.deepStrictEqual(await shown(t, docs, null, ['sheet']), ['sheet-1']);
  });

  await t.test('publicWorksOf over listForRead equals publicWorksOf over listByProject on a Track fixture', async (t) => {
    store(t, [trackWork(2, { sourceKey: 'track:2', provenance: { from: 'nightly' },
      phases: [{ trackName: 'Early Engagement', phaseCodeId: 7, sourceRef: { phase: 1 },
        milestones: [{ name: 'Start', sourceRef: { milestone: 1 } }] }] })], null);
    const row = { id: 'p1', sources: { track: { name: 'Pine Mine' } } };
    assert.deepStrictEqual((await loadWorks(row)).worksForDerive, publicWorksOf(await works.listByProject('p1'), row));
  });

  await t.test('with sheet not listed, the marker is not read', async (t) => {
    const reads = store(t, [trackWork(7, { decisionDate: '2024-06-01' })],
      markerDoc({ hidden: [pair(7, 1)], pairedTrackWorkIds: ['track-7'] }));
    await loadWorks({ id: 'p1' }, { sources: ['track'] });
    assert.deepStrictEqual(reads, []);
  });
});

test('the sheet override on read', async (t) => {
  const amendments = [
    trackWork(7, { decisionDate: '2024-06-01' }), trackWork(8, { decisionDate: '2024-06-01' }),
    sheetWork(1, { decisionDate: '2024-06-01' }), sheetWork(2, { decisionDate: '2024-03-01' })
  ];
  const listed = { hidden: [pair(7, 1)], pairedTrackWorkIds: ['track-7'] };

  await t.test('an active marker hides a listed Track amendment decided 2024-06-01, shows an unlisted one decided the same day, and shows the sheet amendments closed before the boundary', async (t) => {
    assert.deepStrictEqual(await shown(t, amendments, markerDoc(listed)), ['sheet-1', 'sheet-2', 'track-8']);
  });

  await t.test('an active marker hides a listed Track type 16 work and keeps types 11 and 15 shown', async (t) => {
    const docs = [trackWork(16, { workTypeId: 16, decisionDate: '2024-06-01' }),
      trackWork(11, { workTypeId: 11, decisionDate: '2024-06-01' }), trackWork(15, { workTypeId: 15, decisionDate: '2024-06-01' }),
      sheetWork(1, { decisionDate: '2024-06-01' }), sheetWork(2, { decisionDate: '2024-06-01' }), sheetWork(3, { decisionDate: '2024-06-01' })];
    const marker = markerDoc({ hidden: [pair(16, 1), pair(11, 2), pair(15, 3)], pairedTrackWorkIds: ['track-16', 'track-11', 'track-15'] });
    assert.deepStrictEqual(await shown(t, docs, marker), ['sheet-1', 'sheet-2', 'sheet-3', 'track-11', 'track-15']);
  });

  await t.test('a Track amendment decided on the boundary is shown', async (t) => {
    const docs = [trackWork(7, { decisionDate: '2025-01-01' }), sheetWork(1, { decisionDate: '2024-12-20' })];
    assert.deepStrictEqual(await shown(t, docs, markerDoc(listed)), ['sheet-1', 'track-7']);
  });

  await t.test('an inactive marker shows Track\'s amendments and hides the sheet\'s', async (t) => {
    assert.deepStrictEqual(await shown(t, amendments, markerDoc({ ...listed, active: false })), ['track-7', 'track-8']);
  });

  await t.test('a project with no marker hides no Track work and shows no sheet amendment', async (t) => {
    assert.deepStrictEqual(await shown(t, amendments, null), ['track-7', 'track-8']);
  });

  await t.test('a marker owned by demi or failing the validator is treated as missing', async (t) => {
    assert.deepStrictEqual(await shown(t, amendments, markerDoc({ ...listed, owner: 'demi' })), ['track-7', 'track-8']);
    t.mock.restoreAll();
    assert.deepStrictEqual(await shown(t, amendments, markerDoc({ ...listed, boundaryAtLoad: '2025-06-01' })), ['track-7', 'track-8']);
  });

  await t.test('a Track amendment started 2024-11-01 and decided 2025-03-01 stays shown under an active marker', async (t) => {
    const docs = [trackWork(7, { startDate: '2024-11-01', decisionDate: '2025-03-01' }), sheetWork(1, { decisionDate: '2024-12-20' })];
    assert.deepStrictEqual(await shown(t, docs, markerDoc(listed)), ['sheet-1', 'track-7']);
  });

  await t.test('an open Track amendment started 2024-11-01 stays shown under an active marker', async (t) => {
    const docs = [trackWork(7, { startDate: '2024-11-01', workState: 'IN_PROGRESS' }), sheetWork(1, { decisionDate: '2024-12-20' })];
    assert.deepStrictEqual(await shown(t, docs, markerDoc(listed)), ['sheet-1', 'track-7']);
  });

  await t.test('a completed Track Assessment decided 2023-10-10 moves B: a sheet amendment closed 2023-11-01 is dropped and a Track amendment decided 2023-11-01 is shown', async (t) => {
    const docs = [assessment, trackWork(7, { decisionDate: '2023-11-01' }), sheetWork(1, { decisionDate: '2023-11-01' })];
    assert.deepStrictEqual(await shown(t, docs, markerDoc(listed)), ['track-6', 'track-7']);
  });

  await t.test('B moved to 2023-10-10: a hidden pair whose sheet amendment closed 2023-11-01 is dropped shows its Track amendment decided 2023-10-05', async (t) => {
    const docs = [assessment, trackWork(7, { decisionDate: '2023-10-05' }), sheetWork(1, { decisionDate: '2023-11-01' })];
    assert.deepStrictEqual(await shown(t, docs, markerDoc(listed)), ['track-6', 'track-7']);
  });

  await t.test('an untilTrack sheet amendment shows, and is dropped once a Track amendment starting 10 days from it is in the read', async (t) => {
    const waiting = sheetWork(1, { startDate: '2024-09-01' });
    const marker = markerDoc({ untilTrack: [sheetId(1)] });
    assert.deepStrictEqual(await shown(t, [waiting], marker), ['sheet-1']);
    t.mock.restoreAll();
    assert.deepStrictEqual(await shown(t, [waiting, trackWork(9, { startDate: '2024-09-11' })], marker), ['track-9']);
  });

  await t.test('a Track amendment equally near two untilTrack sheet works drops only the one with the smaller id', async (t) => {
    const docs = [sheetWork(2, { startDate: '2024-09-21' }), sheetWork(1, { startDate: '2024-09-01' }),
      trackWork(9, { startDate: '2024-09-11' })];
    const marker = markerDoc({ untilTrack: [sheetId(1), sheetId(2)] });
    assert.deepStrictEqual(await shown(t, docs, marker), ['sheet-2', 'track-9']);
  });

  await t.test('an untilTrack sheet work whose only sameEvent candidate is in pairedTrackWorkIds still shows', async (t) => {
    const docs = [sheetWork(1, { startDate: '2024-09-01' }), trackWork(9, { startDate: '2024-09-11' })];
    const marker = markerDoc({ untilTrack: [sheetId(1)], pairedTrackWorkIds: ['track-9'] });
    assert.deepStrictEqual(await shown(t, docs, marker), ['sheet-1', 'track-9']);
  });
});
