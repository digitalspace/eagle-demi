'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  OVERRIDE_TYPES, TRACK_WORK_TYPE_CODES, dayOf, hiddenByOverride, matchEvents, overrideBoundaryOf, sameEvent,
  settledBefore, untilTrackHidden, validateMarker
} = require('../../src/domain/work-override');
const { TRACK_RETIRED_WORK_TYPES } = require('../../src/domain/work-model');

const PROJECT = 'project-alpha';
const B = '2025-01-01';
const sheetId = (n) => `sheet-00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SHEET_A = sheetId(1);
const SHEET_B = sheetId(2);

const sheetWork = (fields) => ({ id: SHEET_A, source: 'sheet', projectId: PROJECT, workTypeCode: 'amendment', ...fields });
const trackWork = (trackWorkId, fields) => ({
  id: `track-${trackWorkId}`, trackWorkId, projectId: PROJECT, workTypeId: 7, workState: 'COMPLETED', ...fields
});
const marker = (fields) => ({
  id: 'sheet-override', kind: 'override', source: 'sheet', owner: 'sheet', active: true, boundaryAtLoad: B,
  certificates: [{ actYear: 2002, certificateKind: 'EAC', decisionDate: '2005-04-01' }],
  hidden: [], trackAlive: [], untilTrack: [], pairedTrackWorkIds: [],
  batchId: 'batch-1', provenance: { writtenBy: 'loader' }, schemaVersion: 1, ...fields
});
const rulesOf = (result) => (result.errors || []).map(error => error.rule);
const pairIds = (result) => result.pairs.map(p => [p.track.id, p.sheet.sourceKey, p.gap]);

test('type maps', async (t) => {
  await t.test('Track types 7 and 16 map to amendment, 9 to eac-extension, 10 to substantial-start, 11 and 15 to their own codes', () => {
    assert.strictEqual(TRACK_WORK_TYPE_CODES[7], 'amendment');
    assert.strictEqual(TRACK_WORK_TYPE_CODES[16], 'amendment');
    assert.strictEqual(TRACK_WORK_TYPE_CODES[9], 'eac-extension');
    assert.strictEqual(TRACK_WORK_TYPE_CODES[10], 'substantial-start');
    assert.strictEqual(TRACK_WORK_TYPE_CODES[11], 'transfer');
    assert.strictEqual(TRACK_WORK_TYPE_CODES[15], 'material-alteration');
    assert.ok(!OVERRIDE_TYPES.includes('transfer') && !OVERRIDE_TYPES.includes('material-alteration'));
    assert.deepStrictEqual(TRACK_RETIRED_WORK_TYPES, []);
  });
});

test('dayOf', async (t) => {
  await t.test('a bare date stays as written; a timestamp takes its Pacific day', () => {
    assert.strictEqual(dayOf('2024-12-31'), '2024-12-31');
    assert.strictEqual(dayOf('2025-01-01T00:30:00.000Z'), '2024-12-31');
    assert.strictEqual(dayOf('2025-01-01T09:00:00+00:00'), '2025-01-01');
  });

  await t.test('the Pacific day follows daylight saving time', () => {
    assert.strictEqual(dayOf('2015-03-01T07:30:00Z'), '2015-02-28');
    assert.strictEqual(dayOf('2015-07-01T07:30:00Z'), '2015-07-01');
    assert.strictEqual(dayOf('2015-07-01T06:30:00Z'), '2015-06-30');
  });

  await t.test('impossible dates and zone-less timestamps are not dates', () => {
    assert.strictEqual(dayOf('2023-02-30'), null);
    assert.strictEqual(dayOf('2023-02-30T10:00:00Z'), null);
    assert.strictEqual(dayOf('2023-02-01T10:00:00'), null);
  });
});

test('validateMarker', async (t) => {
  const full = () => marker({
    hidden: [{ trackWorkId: 'track-121', sheetWorkId: SHEET_A }],
    trackAlive: [{ trackWorkId: 'track-300', sourceKey: '238:amendment:1' }],
    untilTrack: [SHEET_B], pairedTrackWorkIds: ['track-121', 'track-300']
  });

  await t.test('accepts a well-formed marker', () => {
    assert.strictEqual(validateMarker(full()).ok, true);
  });

  await t.test('marker validator refuses a boundaryAtLoad after 2025-01-01, a non-track trackWorkId in hidden, trackAlive or pairedTrackWorkIds, and a non-sheet sheetWorkId or untilTrack entry', () => {
    assert.deepStrictEqual(rulesOf(validateMarker(marker({ boundaryAtLoad: '2025-01-02' }))), ['boundary']);
    assert.deepStrictEqual(rulesOf(validateMarker(marker({ hidden: [{ trackWorkId: 'demi-1', sheetWorkId: SHEET_A }],
      pairedTrackWorkIds: ['demi-1'] }))), ['entry', 'entry']);
    assert.deepStrictEqual(rulesOf(validateMarker(marker({ trackAlive: [{ trackWorkId: SHEET_A, sourceKey: '1:a:1' }],
      pairedTrackWorkIds: [SHEET_A] }))), ['entry', 'entry']);
    assert.deepStrictEqual(rulesOf(validateMarker(marker({ pairedTrackWorkIds: ['121'] }))), ['entry']);
    assert.deepStrictEqual(rulesOf(validateMarker(marker({ hidden: [{ trackWorkId: 'track-1', sheetWorkId: 'track-2' }],
      pairedTrackWorkIds: ['track-1'] }))), ['entry']);
    assert.deepStrictEqual(rulesOf(validateMarker(marker({ untilTrack: ['sheet-override'] }))), ['entry']);
  });

  await t.test('boundaryAtLoad lies between 2019-12-16 and 2025-01-01', () => {
    assert.strictEqual(validateMarker(marker({ boundaryAtLoad: '2019-12-16' })).ok, true);
    assert.deepStrictEqual(rulesOf(validateMarker(marker({ boundaryAtLoad: '2019-12-15' }))), ['boundary']);
  });

  await t.test('refuses a marker owned by demi, a 2018 certificate, a non-boolean active and missing batch fields', () => {
    assert.deepStrictEqual(rulesOf(validateMarker(marker({ owner: 'demi' }))), ['owner']);
    assert.deepStrictEqual(rulesOf(validateMarker(marker({ certificates: [{ actYear: 2018, certificateKind: 'EAC', decisionDate: null }] }))), ['entry']);
    assert.deepStrictEqual(rulesOf(validateMarker(marker({ active: 'yes' }))), ['boolean']);
    assert.deepStrictEqual(rulesOf(validateMarker(marker({ batchId: null, provenance: undefined, schemaVersion: null }))),
      ['required', 'required', 'required']);
  });

  await t.test('a Track or sheet work sits in one pair, and every paired Track work is listed', () => {
    const twice = (hidden) => rulesOf(validateMarker(marker({ hidden, pairedTrackWorkIds: ['track-1', 'track-2'] })));
    assert.deepStrictEqual(twice([{ trackWorkId: 'track-1', sheetWorkId: SHEET_A }, { trackWorkId: 'track-1', sheetWorkId: SHEET_B }]),
      ['repeated-track-work']);
    assert.deepStrictEqual(twice([{ trackWorkId: 'track-1', sheetWorkId: SHEET_A }, { trackWorkId: 'track-2', sheetWorkId: SHEET_A }]),
      ['repeated-sheet-work']);
    const both = marker({ hidden: [{ trackWorkId: 'track-1', sheetWorkId: SHEET_A }],
      trackAlive: [{ trackWorkId: 'track-1', sourceKey: '1:amendment:1' }], pairedTrackWorkIds: ['track-1'] });
    assert.deepStrictEqual(rulesOf(validateMarker(both)), ['hidden-and-alive']);
    const unlisted = marker({ trackAlive: [{ trackWorkId: 'track-1', sourceKey: '1:amendment:1' }] });
    assert.deepStrictEqual(rulesOf(validateMarker(unlisted)), ['unpaired']);
  });
});

test('overrideBoundaryOf', async (t) => {
  const assessment = (fields) => ({ workTypeId: 6, workState: 'COMPLETED', startDate: '2020-03-01', ...fields });

  await t.test('overrideBoundaryOf: 2023-10-10 for a completed Assessment started 2020-03-01 and decided 2023-10-10; 2025-01-01 for none, for a withdrawn one, for an open one, for one started 2018-05-01, and for one decided 2025-06-17', () => {
    assert.strictEqual(overrideBoundaryOf([assessment({ decisionDate: '2023-10-10' })]), '2023-10-10');
    assert.strictEqual(overrideBoundaryOf([]), B);
    assert.strictEqual(overrideBoundaryOf([assessment({ workState: 'WITHDRAWN', decisionDate: '2023-10-10' })]), B);
    assert.strictEqual(overrideBoundaryOf([assessment({ workState: 'IN_PROGRESS', decisionDate: null })]), B);
    assert.strictEqual(overrideBoundaryOf([assessment({ startDate: '2018-05-01', decisionDate: '2023-10-10' })]), B);
    assert.strictEqual(overrideBoundaryOf([assessment({ decisionDate: '2025-06-17' })]), B);
  });

  await t.test('the earliest of two qualifying decisions wins, and a start on 2019-12-16 qualifies', () => {
    const works = [assessment({ decisionDate: '2023-10-10' }), assessment({ startDate: '2019-12-16', decisionDate: '2022-04-05' })];
    assert.strictEqual(overrideBoundaryOf(works), '2022-04-05');
  });

  await t.test('a Track decision stamped on a Pacific evening sets the Pacific day', () => {
    assert.strictEqual(overrideBoundaryOf([assessment({ decisionDate: '2023-10-11T03:00:00.000Z' })]), '2023-10-10');
  });

  await t.test('an amendment decision never moves the boundary', () => {
    assert.strictEqual(overrideBoundaryOf([assessment({ workTypeId: 7, decisionDate: '2023-10-10' })]), B);
  });
});

test('settledBefore', async (t) => {
  await t.test('settledBefore: a COMPLETED Track work with no decisionDate is settled; an IN_PROGRESS one is not', () => {
    assert.strictEqual(settledBefore(trackWork(1, { decisionDate: null }), B), true);
    assert.strictEqual(settledBefore(trackWork(1, { decisionDate: null, workState: 'IN_PROGRESS' }), B), false);
  });

  await t.test('a decision date settles before the boundary only when it is earlier', () => {
    assert.strictEqual(settledBefore(trackWork(1, { decisionDate: '2024-12-31' }), B), true);
    assert.strictEqual(settledBefore(trackWork(1, { decisionDate: '2025-01-01' }), B), false);
  });

  await t.test('a decision on the evening of 2024-12-31 Pacific, stamped 2025-01-01 UTC, is before the boundary', () => {
    assert.strictEqual(settledBefore(trackWork(1, { decisionDate: '2025-01-01T00:30:00.000Z' }), B), true);
  });
});

test('sameEvent', async (t) => {
  await t.test('sameEvent: amendments starting the same day match; starts 32 days apart with decisions 61 days apart do not; an amendment never matches a substantial start', () => {
    assert.deepStrictEqual(sameEvent(sheetWork({ startDate: '2015-03-01' }), trackWork(1, { startDate: '2015-03-01T09:00:00+00:00' })), { gap: 0 });
    const far = sameEvent(sheetWork({ startDate: '2015-03-01', decisionDate: '2015-06-01' }),
      trackWork(1, { startDate: '2015-04-02', decisionDate: '2015-08-01' }));
    assert.strictEqual(far, null);
    assert.strictEqual(sameEvent(sheetWork({ workTypeCode: 'substantial-start', startDate: '2015-03-01' }),
      trackWork(1, { startDate: '2015-03-01' })), null);
  });

  await t.test('the windows are 31 days on start and 60 on decision, and the gap is the smaller', () => {
    assert.deepStrictEqual(sameEvent(sheetWork({ startDate: '2015-03-01' }), trackWork(1, { startDate: '2015-04-01' })), { gap: 31 });
    assert.deepStrictEqual(sameEvent(sheetWork({ decisionDate: '2015-03-01' }), trackWork(1, { decisionDate: '2015-04-30' })), { gap: 60 });
    assert.deepStrictEqual(sameEvent(sheetWork({ startDate: '2015-03-01', decisionDate: '2015-06-01' }),
      trackWork(1, { startDate: '2015-03-21', decisionDate: '2015-06-03' })), { gap: 2 });
  });

  await t.test('a Pacific-evening Track stamp at the window edge counts its Pacific day, across a DST change too', () => {
    assert.deepStrictEqual(sameEvent(sheetWork({ startDate: '2015-03-01' }), trackWork(1, { startDate: '2015-04-02T05:00:00Z' })), { gap: 31 });
    assert.deepStrictEqual(sameEvent(sheetWork({ decisionDate: '2015-01-08' }), trackWork(1, { decisionDate: '2015-03-09T06:30:00Z' })), { gap: 59 });
  });

  await t.test('type 16 matches a sheet amendment; unknown dates never match', () => {
    assert.ok(sameEvent(sheetWork({ startDate: '2015-03-01' }), trackWork(1, { workTypeId: 16, startDate: '2015-03-01' })));
    assert.strictEqual(sameEvent(sheetWork({ startDate: null, undated: { startDate: { notAfter: '1995-06-30' } } }),
      trackWork(1, { startDate: '1995-06-30' })), null);
  });

  await t.test('works match only when both name one project', () => {
    assert.strictEqual(sameEvent(sheetWork({ startDate: '2015-03-01' }), trackWork(1, { projectId: 'project-beta', startDate: '2015-03-01' })), null);
    assert.strictEqual(sameEvent(sheetWork({ projectId: undefined, startDate: '2015-03-01' }),
      trackWork(1, { projectId: undefined, startDate: '2015-03-01' })), null);
  });
});

test('matchEvents', async (t) => {
  const sheet = (n, sourceKey, fields) => sheetWork({ id: sheetId(n), sourceKey, ...fields });

  await t.test('matchEvents pairs one-to-one by smallest gap and lists a Track work with two candidates in sameEventChoice', () => {
    const near = sheet(1, '10:amendment:1', { startDate: '2015-03-03' });
    const farther = sheet(2, '10:amendment:2', { startDate: '2015-03-10' });
    const result = matchEvents([farther, near], [trackWork(5, { startDate: '2015-03-01' })]);
    assert.deepStrictEqual(pairIds(result), [['track-5', '10:amendment:1', 2]]);
    assert.strictEqual(result.sameEventChoice.length, 1);
    const [choice] = result.sameEventChoice;
    assert.strictEqual(choice.side, 'track');
    assert.strictEqual(choice.pair.sheet, near);
    assert.deepStrictEqual(choice.left.map(c => [c.work.sourceKey, c.gap]), [['10:amendment:2', 9]]);
  });

  await t.test('matchEvents breaks an equal-gap tie by Track work id, then sheet sourceKey, and gives the same pairs when the input order is reversed', () => {
    const sheets = [sheet(2, '10:amendment:2', { startDate: '2015-03-01' }), sheet(1, '10:amendment:1', { startDate: '2015-03-01' })];
    const tracks = [trackWork(121, { startDate: '2015-03-01' }), trackWork(39, { startDate: '2015-03-01' })];
    const expected = [['track-39', '10:amendment:1', 0], ['track-121', '10:amendment:2', 0]];
    assert.deepStrictEqual(pairIds(matchEvents(sheets, tracks)), expected);
    assert.deepStrictEqual(pairIds(matchEvents([...sheets].reverse(), [...tracks].reverse())), expected);
  });

  await t.test('matchEvents uses a Track work once: paired with a sheet work closed before B, it is not also paired with an open sheet band', () => {
    const closed = sheet(1, '10:amendment:1', { startDate: '2020-05-01', decisionDate: '2021-01-10' });
    const open = sheet(2, '10:amendment:2', { startDate: '2020-05-20', decisionDate: null });
    const result = matchEvents([open, closed], [trackWork(7, { startDate: '2020-05-01', decisionDate: '2021-01-12' })]);
    assert.deepStrictEqual(pairIds(result), [['track-7', '10:amendment:1', 0]]);
  });

  await t.test('matchEvents on the Track test shapes pairs Track 121, 316 and 300 with sheet 152, 162 and 238 (gaps 0, 0 and 8 days) and Track 124 with sheet 239 (27 days), and leaves Track 297 on sheet 285 (103 days) and Track 39 on sheet 395 unpaired', () => {
    const on = (projectId) => ({ projectId });
    const sheets = [
      sheet(152, '152:amendment:1', { ...on('p-152'), startDate: '2019-12-05', decisionDate: '2025-06-17' }),
      sheet(162, '162:amendment:1', { ...on('p-162'), startDate: '2018-10-29', decisionDate: '2019-02-01' }),
      sheet(238, '238:amendment:1', { ...on('p-238'), startDate: '2020-03-24', decisionDate: '2020-09-01' }),
      sheet(239, '239:amendment:1', { ...on('p-239'), startDate: '2023-06-25', decisionDate: '2023-11-30' }),
      sheet(285, '285:amendment:1', { ...on('p-285'), startDate: '2020-09-14', decisionDate: '2021-08-01' }),
      sheet(395, '395:amendment:1', { ...on('p-395'), startDate: '2021-01-15', decisionDate: '2021-03-01' })
    ];
    const tracks = [
      trackWork(121, { ...on('p-152'), startDate: '2019-12-05T10:00:00+00:00', decisionDate: '2025-06-17T09:00:00+00:00' }),
      trackWork(316, { ...on('p-162'), startDate: '2018-10-29T09:00:00+00:00', decisionDate: null, workState: 'IN_PROGRESS' }),
      trackWork(300, { ...on('p-238'), startDate: '2020-03-16T09:00:00+00:00', decisionDate: '2025-06-17T17:25:23.073130+00:00' }),
      trackWork(124, { ...on('p-239'), startDate: '2023-07-22T09:00:00+00:00', decisionDate: null }),
      trackWork(297, { ...on('p-285'), startDate: '2020-06-03T09:00:00+00:00', decisionDate: '2021-04-28T09:00:00+00:00' }),
      trackWork(39, { ...on('p-395'), startDate: '2022-07-01T09:00:00+00:00', decisionDate: null })
    ];
    const pairs = pairIds(matchEvents(sheets, tracks)).sort((a, b) => a[1].localeCompare(b[1]));
    assert.deepStrictEqual(pairs, [
      ['track-121', '152:amendment:1', 0], ['track-316', '162:amendment:1', 0],
      ['track-300', '238:amendment:1', 8], ['track-124', '239:amendment:1', 27]
    ]);
  });
});

test('hiddenByOverride', async (t) => {
  const paired = (trackId, sheetWorkId = SHEET_A) => marker({ hidden: [{ trackWorkId: trackId, sheetWorkId }], pairedTrackWorkIds: [trackId] });
  const shown = new Set([SHEET_A]);

  await t.test('hiddenByOverride: an active marker hides a paired covered Track work settled before the boundary while its sheet work shows, never an unpaired one, never 11 or 15, never one decided on or after the boundary', () => {
    assert.strictEqual(hiddenByOverride(trackWork(1, { decisionDate: '2024-06-01' }), paired('track-1'), B, shown), true);
    assert.strictEqual(hiddenByOverride(trackWork(2, { decisionDate: '2024-06-01' }), paired('track-1'), B, shown), false);
    assert.strictEqual(hiddenByOverride(trackWork(1, { workTypeId: 11, decisionDate: '2024-06-01' }), paired('track-1'), B, shown), false);
    assert.strictEqual(hiddenByOverride(trackWork(1, { workTypeId: 15, decisionDate: '2024-06-01' }), paired('track-1'), B, shown), false);
    assert.strictEqual(hiddenByOverride(trackWork(1, { decisionDate: '2025-01-01' }), paired('track-1'), B, shown), false);
  });

  await t.test('hiddenByOverride: a paired Track work shows once its sheet work is not in shownSheetIds', () => {
    assert.strictEqual(hiddenByOverride(trackWork(1, { decisionDate: '2024-06-01' }), paired('track-1'), B, new Set([SHEET_B])), false);
  });

  await t.test('hiddenByOverride: a Track amendment started 2024-11-01 and decided 2025-03-01 stays shown, and a sheet amendment closed 2025-03-01 is hidden', () => {
    const track = trackWork(1, { startDate: '2024-11-01', decisionDate: '2025-03-01' });
    assert.strictEqual(hiddenByOverride(track, paired('track-1'), B, shown), false);
    assert.strictEqual(hiddenByOverride(sheetWork({ startDate: '2024-11-01', decisionDate: '2025-03-01' }), marker(), B, shown), true);
  });

  await t.test('an IN_PROGRESS covered Track work with no decisionDate stays shown', () => {
    const open = trackWork(1, { decisionDate: null, workState: 'IN_PROGRESS' });
    assert.strictEqual(hiddenByOverride(open, paired('track-1'), B, shown), false);
  });

  await t.test('a paired COMPLETED Track work with no decisionDate is hidden, as settledBefore holds it settled', () => {
    assert.strictEqual(hiddenByOverride(trackWork(1, { decisionDate: null }), paired('track-1'), B, shown), true);
  });

  await t.test('hiddenByOverride: an inactive marker hides the sheet\'s covered works instead', () => {
    const off = marker({ active: false, hidden: [{ trackWorkId: 'track-1', sheetWorkId: SHEET_A }], untilTrack: [SHEET_A] });
    assert.strictEqual(hiddenByOverride(trackWork(1, { decisionDate: '2024-06-01' }), off, B, shown), false);
    assert.strictEqual(hiddenByOverride(sheetWork({ decisionDate: '2024-06-01' }), off, B, shown), true);
    assert.strictEqual(hiddenByOverride(sheetWork({ decisionDate: '2024-06-01' }), null, B, shown), true);
    assert.strictEqual(hiddenByOverride(sheetWork({ workTypeCode: 'assessment', decisionDate: '2004-06-01' }), off, B, shown), false);
  });

  await t.test('an active marker shows a sheet work closed before the boundary and an untilTrack one closed after it', () => {
    assert.strictEqual(hiddenByOverride(sheetWork({ decisionDate: '2024-12-31' }), marker(), B, shown), false);
    assert.strictEqual(hiddenByOverride(sheetWork({ decisionDate: '2025-03-01' }), marker({ untilTrack: [SHEET_A] }), B, shown), false);
    assert.strictEqual(hiddenByOverride(sheetWork({ decisionDate: '2024-06-01' }), marker(), '2023-10-10', shown), true);
  });

  await t.test('a sheet work closed exactly on the boundary is hidden', () => {
    assert.strictEqual(hiddenByOverride(sheetWork({ decisionDate: B }), marker(), B, shown), true);
  });

  await t.test('a sheet work with no source falls back to its id prefix', () => {
    assert.strictEqual(hiddenByOverride(sheetWork({ source: undefined, decisionDate: '2024-06-01' }), null, B, shown), true);
  });
});

test('untilTrackHidden', async (t) => {
  const waiting = (n, sourceKey, startDate) => sheetWork({ id: sheetId(n), sourceKey, startDate });
  const sheets = [waiting(1, '10:amendment:1', '2025-02-10'), waiting(3, '10:amendment:3', '2025-02-03'), waiting(2, '10:amendment:2', '2025-02-03')];
  const until = (fields) => marker({ untilTrack: sheets.map(s => s.id), ...fields });

  await t.test('a new Track work hides only its smallest-gap untilTrack sheet work, ties by sourceKey', () => {
    const hidden = untilTrackHidden(sheets, [trackWork(9, { startDate: '2025-02-01' })], until());
    assert.deepStrictEqual([...hidden], [sheetId(2)]);
  });

  await t.test('an untilTrack sheet work whose only sameEvent candidate is in pairedTrackWorkIds still shows', () => {
    const hidden = untilTrackHidden(sheets, [trackWork(9, { startDate: '2025-02-01' })], until({ pairedTrackWorkIds: ['track-9'] }));
    assert.strictEqual(hidden.size, 0);
  });

  await t.test('an inactive marker hides nothing through this rule', () => {
    assert.strictEqual(untilTrackHidden(sheets, [trackWork(9, { startDate: '2025-02-01' })], until({ active: false })).size, 0);
  });
});
