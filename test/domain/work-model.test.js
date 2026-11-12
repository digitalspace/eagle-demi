'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  OVERRIDE_TYPES, TRACK_WORK_TYPE_CODES, TRACK_RETIRED_WORK_TYPES, childIdOf, hiddenByOverride, inEffect,
  matchEvents, newWorkId, overrideBoundaryOf, sameEvent, settledBefore, sourceKeyOf, summaryOf,
  transitionDateOf, validateMarker, validateWork
} = require('../../src/domain/work-model');

const PROJECT = 'project-alpha';
const B = '2025-01-01';
const SHEET_A = 'sheet-00000000-0000-4000-8000-00000000000a';
const SHEET_B = 'sheet-00000000-0000-4000-8000-00000000000b';

const sheetWork = (fields) => ({ id: SHEET_A, source: 'sheet', projectId: PROJECT, workTypeCode: 'amendment', ...fields });
const trackWork = (trackWorkId, fields) => ({
  id: `track-${trackWorkId}`, trackWorkId, projectId: PROJECT, workTypeId: 7, workState: 'COMPLETED', ...fields
});
const marker = (fields) => ({
  id: 'sheet-override', kind: 'override', source: 'sheet', owner: 'sheet', active: true, boundaryAtLoad: B,
  certificates: [{ actYear: 2002, certificateKind: 'EAC', decisionDate: '2005-04-01' }],
  hidden: [], trackAlive: [], untilTrack: [], pairedTrackWorkIds: [], ...fields
});
const rulesOf = (result) => (result.errors || []).map(error => error.rule);
const pairIds = (result) => result.pairs.map(p => [p.track.id, p.sheet.sourceKey, p.gap]);

test('ids', async (t) => {
  await t.test('newWorkId is random: two calls differ', () => {
    const first = newWorkId('sheet');
    assert.match(first, /^sheet-[0-9a-f-]{36}$/);
    assert.notStrictEqual(first, newWorkId('sheet'));
  });

  await t.test('newWorkId refuses track, whose ids come from Track', () => {
    assert.throws(() => newWorkId('track'));
  });

  await t.test('sourceKeyOf is stable', () => {
    assert.strictEqual(sourceKeyOf(152, 'amendment', 3), '152:amendment:3');
    assert.strictEqual(sourceKeyOf(' 0152', 'amendment', '3'), sourceKeyOf(152, 'amendment', 3));
    assert.throws(() => sourceKeyOf('15a', 'amendment', 3));
  });

  await t.test('child ids carry no work id', () => {
    assert.strictEqual(childIdOf('referral'), 'referral');
    assert.strictEqual(childIdOf('referral', 2), 'referral:2');
    const doc = { id: SHEET_A, phases: [{ id: `${SHEET_A}:referral` }] };
    assert.deepStrictEqual(rulesOf(validateWork(doc)), ['child-id']);
  });

  await t.test('child ids must be unique within the document', () => {
    const doc = { id: SHEET_A, phases: [{ id: 'referral', milestones: [{ id: 'referral' }] }] };
    assert.deepStrictEqual(rulesOf(validateWork(doc)), ['child-id']);
  });
});

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

test('validateWork', async (t) => {
  await t.test('rejects end before start', () => {
    const doc = { id: SHEET_A, phases: [{ startDate: '2010-05-01', endDate: '2010-04-30' }] };
    assert.deepStrictEqual(rulesOf(validateWork(doc)), ['end-before-start']);
    assert.deepStrictEqual(rulesOf(validateWork({ id: SHEET_A, startDate: '2010-05-01', decisionDate: '2010-04-01' })),
      ['end-before-start']);
  });

  await t.test('rejects a staff key on a work', () => {
    assert.deepStrictEqual(rulesOf(validateWork({ id: SHEET_A, staff: { notes: [] } })), ['staff-data']);
  });

  await t.test('undated field must be null', () => {
    const undated = { decisionDate: { notAfter: '1995-06-30' } };
    assert.strictEqual(validateWork({ id: SHEET_A, decisionDate: null, undated }).ok, true);
    assert.deepStrictEqual(rulesOf(validateWork({ id: SHEET_A, decisionDate: '1995-06-30', undated })),
      ['undated-holds-date']);
  });

  await t.test('transitionOut date only with dateSource sheet or track', () => {
    const withOut = (transitionOut) => validateWork({ id: SHEET_A, transitionOut });
    assert.strictEqual(withOut({ toActYear: 2018, date: '2023-01-10', dateSource: 'sheet' }).ok, true);
    assert.strictEqual(withOut({ toActYear: 2018, date: '2025-05-21', dateSource: 'track' }).ok, true);
    assert.strictEqual(withOut({ toActYear: 2018, date: null, dateSource: 'none' }).ok, true);
    assert.deepStrictEqual(rulesOf(withOut({ toActYear: 2018, date: '2023-01-10', dateSource: 'none' })), ['date-source']);
    assert.deepStrictEqual(rulesOf(withOut({ toActYear: 2018, date: null, dateSource: 'eagle' })), ['date-source']);
  });

  await t.test('rejects < in a public string and in legalSection', () => {
    assert.deepStrictEqual(rulesOf(validateWork({ id: SHEET_A, title: 'Mine <b>' })), ['markup']);
    const doc = { id: SHEET_A, phases: [{ interruptions: [{ kind: 'suspension', legalSection: 's.<30' }] }] };
    assert.deepStrictEqual(rulesOf(validateWork(doc)), ['markup']);
    assert.strictEqual(validateWork({ id: SHEET_A, sourceRef: { sheet: { file: 'a<b' } } }).ok, true);
  });

  await t.test('rejects control characters everywhere', () => {
    assert.deepStrictEqual(rulesOf(validateWork({ id: SHEET_A, sourceRef: { sheet: { file: 'a\u0007b' } } })),
      ['control-character']);
    assert.deepStrictEqual(rulesOf(validateWork({ id: SHEET_A, phases: [{ sourceName: 'Pre\nApp' }] })),
      ['control-character']);
  });

  await t.test('validator errors carry no value', () => {
    const result = validateWork({ id: SHEET_A, title: 'secret <value>' });
    assert.ok(!JSON.stringify(result).includes('secret'));
  });

  await t.test('rejects an id prefix that does not equal source', () => {
    assert.deepStrictEqual(rulesOf(validateWork({ id: 'track-12', source: 'sheet' })), ['source']);
  });

  await t.test('rejects stored interruption days that are not end minus start', () => {
    const doc = { id: SHEET_A, phases: [{ interruptions: [{ kind: 'suspension', startDate: '2010-01-01', endDate: '2010-01-31', days: 31 }] }] };
    assert.deepStrictEqual(rulesOf(validateWork(doc)), ['days']);
  });

  await t.test('oversize work returns reason oversize', () => {
    const milestones = Array.from({ length: 2001 }, () => ({}));
    assert.deepStrictEqual(validateWork({ id: SHEET_A, phases: [{ milestones }] }), { ok: false, reason: 'oversize' });
    const big = { id: SHEET_A, phases: [{ sourceName: 'x'.repeat(1.6 * 1024 * 1024) }] };
    assert.strictEqual(validateWork(big).reason, 'oversize');
    assert.strictEqual(validateWork({ id: SHEET_A, phases: [{ milestones: milestones.slice(1) }] }).ok, true);
  });
});

test('validateMarker', async (t) => {
  await t.test('accepts a well-formed marker', () => {
    assert.strictEqual(validateMarker(marker({
      hidden: [{ trackWorkId: 'track-121', sheetWorkId: SHEET_A }],
      trackAlive: [{ trackWorkId: 'track-300', sourceKey: '238:amendment:1' }],
      untilTrack: [SHEET_B], pairedTrackWorkIds: ['track-121', 'track-300']
    })).ok, true);
  });

  await t.test('marker validator refuses a boundaryAtLoad after 2025-01-01, a non-track trackWorkId in hidden, trackAlive or pairedTrackWorkIds, and a non-sheet sheetWorkId or untilTrack entry', () => {
    assert.deepStrictEqual(rulesOf(validateMarker(marker({ boundaryAtLoad: '2025-01-02' }))), ['boundary']);
    assert.deepStrictEqual(rulesOf(validateMarker(marker({ hidden: [{ trackWorkId: 'demi-1', sheetWorkId: SHEET_A }] }))), ['entry']);
    assert.deepStrictEqual(rulesOf(validateMarker(marker({ trackAlive: [{ trackWorkId: SHEET_A, sourceKey: '1:a:1' }] }))), ['entry']);
    assert.deepStrictEqual(rulesOf(validateMarker(marker({ pairedTrackWorkIds: ['121'] }))), ['entry']);
    assert.deepStrictEqual(rulesOf(validateMarker(marker({ hidden: [{ trackWorkId: 'track-1', sheetWorkId: 'track-2' }] }))), ['entry']);
    assert.deepStrictEqual(rulesOf(validateMarker(marker({ untilTrack: ['demi-1'] }))), ['entry']);
  });

  await t.test('refuses a marker owned by demi, a 2018 certificate and a non-boolean active', () => {
    assert.deepStrictEqual(rulesOf(validateMarker(marker({ owner: 'demi' }))), ['owner']);
    assert.deepStrictEqual(rulesOf(validateMarker(marker({ certificates: [{ actYear: 2018, certificateKind: 'EAC', decisionDate: null }] }))), ['entry']);
    assert.deepStrictEqual(rulesOf(validateMarker(marker({ active: 'yes' }))), ['boolean']);
  });
});

test('summaryOf', async (t) => {
  const work = {
    startDate: '2010-01-01', decisionDate: '2010-12-31',
    phases: [
      { startDate: '2010-01-01', endDate: '2010-06-30', interruptions: [
        { kind: 'suspension', startDate: '2010-02-01', endDate: '2010-03-03' },
        { kind: 'extension', startDate: '2010-04-01', endDate: '2010-04-11' }] },
      { startDate: '2010-07-01', endDate: '2010-12-31' }
    ]
  };

  await t.test('suspension days = end minus start', () => {
    assert.strictEqual(summaryOf(work).suspendedDays, 30);
    assert.strictEqual(summaryOf(work).extensionDays, 10);
  });

  await t.test('effort is elapsed minus suspended; phase days add up the dated phases', () => {
    const summary = summaryOf(work);
    assert.strictEqual(summary.elapsedDays, 364);
    assert.strictEqual(summary.effortDays, 334);
    assert.strictEqual(summary.phaseDays, 180 + 183);
    assert.strictEqual(summary.decisionYear, 2010);
  });

  await t.test('an unknown decision date counts as missing', () => {
    const summary = summaryOf({ startDate: '1990-01-01', decisionDate: null, undated: { decisionDate: { notAfter: '1995-06-30' } } });
    assert.strictEqual(summary.elapsedDays, null);
    assert.strictEqual(summary.decisionYear, null);
  });
});

test('transitionDateOf', async (t) => {
  const assessment = (name, actualDate) => ({ workTypeId: 6, milestones: [{ name, actualDate }] });
  const trackMilestone = assessment('Project Transitioning FROM the EA Act (2002)', '2025-05-30T00:00:00.000Z');

  await t.test('transitionDateOf: sheet date before 2025 wins; else Track\'s milestone; else the stored fallback; else null', () => {
    assert.strictEqual(transitionDateOf({ toActYear: 2018, date: '2021-03-01', dateSource: 'sheet' }, [trackMilestone]), '2021-03-01');
    assert.strictEqual(transitionDateOf({ toActYear: 2018, date: '2025-05-21', dateSource: 'track' }, [trackMilestone]),
      '2025-05-30T00:00:00.000Z');
    assert.strictEqual(transitionDateOf({ toActYear: 2018, date: '2025-05-21', dateSource: 'track' }, []), '2025-05-21');
    assert.strictEqual(transitionDateOf({ toActYear: 2018, date: null, dateSource: 'none' }, []), null);
  });

  await t.test('Track\'s milestone counts only when it names the Act the work leaves', () => {
    const other = assessment('Project Transitioning FROM the EA Act (1996)', '2025-05-30');
    assert.strictEqual(transitionDateOf({ toActYear: 2018, date: null, dateSource: 'none' }, [other]), null);
  });
});

test('inEffect', async (t) => {
  const unknownStart = { id: 'e1', effectiveFrom: null, effectiveTo: null, observedAt: '2026-11-12' };

  await t.test('inEffect gives an unknown-start entry to a work open on observedAt, marked currentAsOf', () => {
    const found = inEffect([unknownStart], { startDate: '2024-03-01', decisionDate: null });
    assert.deepStrictEqual(found.map(e => [e.id, e.currentAsOf]), [['e1', '2026-11-12']]);
  });

  await t.test('inEffect gives no unknown-start entry to a work decided in 1997', () => {
    assert.deepStrictEqual(inEffect([unknownStart], { startDate: '1995-02-01', decisionDate: '1997-08-01' }), []);
  });

  await t.test('a dated entry is given when its range overlaps the work', () => {
    const entries = [
      { id: 'before', effectiveFrom: '2000-01-01', effectiveTo: '2004-12-31' },
      { id: 'during', effectiveFrom: '2004-01-01', effectiveTo: '2006-01-01' },
      { id: 'after', effectiveFrom: '2011-01-01', effectiveTo: null }
    ];
    const work = { startDate: '2005-01-01', phases: [{ endDate: '2010-12-31' }] };
    assert.deepStrictEqual(inEffect(entries, work).map(e => e.id), ['during']);
  });
});

test('overrideBoundaryOf', async (t) => {
  const assessment = (fields) => ({ workTypeId: 6, workState: 'COMPLETED', startDate: '2020-03-01', ...fields });

  await t.test('overrideBoundaryOf: 2023-10-10 for a completed Assessment started 2020-03-01 and decided 2023-10-10; 2025-01-01 for none, for a withdrawn one, for an open one, for one started 2018-05-01, and for one decided 2025-06-17', () => {
    assert.strictEqual(overrideBoundaryOf([assessment({ decisionDate: '2023-10-10T07:00:00.000Z' })]), '2023-10-10');
    assert.strictEqual(overrideBoundaryOf([]), B);
    assert.strictEqual(overrideBoundaryOf([assessment({ workState: 'WITHDRAWN', decisionDate: '2023-10-10' })]), B);
    assert.strictEqual(overrideBoundaryOf([assessment({ workState: 'IN_PROGRESS', decisionDate: null })]), B);
    assert.strictEqual(overrideBoundaryOf([assessment({ startDate: '2018-05-01', decisionDate: '2023-10-10' })]), B);
    assert.strictEqual(overrideBoundaryOf([assessment({ decisionDate: '2025-06-17' })]), B);
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

  await t.test('type 16 matches a sheet amendment, other projects and unknown dates never match', () => {
    assert.ok(sameEvent(sheetWork({ startDate: '2015-03-01' }), trackWork(1, { workTypeId: 16, startDate: '2015-03-01' })));
    assert.strictEqual(sameEvent(sheetWork({ startDate: '2015-03-01' }), trackWork(1, { projectId: 'project-beta', startDate: '2015-03-01' })), null);
    assert.strictEqual(sameEvent(sheetWork({ startDate: null, undated: { startDate: { notAfter: '1995-06-30' } } }),
      trackWork(1, { startDate: '1995-06-30' })), null);
  });
});

test('matchEvents', async (t) => {
  const sheet = (sourceKey, fields) => sheetWork({ id: `sheet-${sourceKey}`, sourceKey, ...fields });

  await t.test('matchEvents pairs one-to-one by smallest gap and lists a Track work with two candidates in sameEventChoice', () => {
    const near = sheet('10:amendment:1', { startDate: '2015-03-03' });
    const farther = sheet('10:amendment:2', { startDate: '2015-03-10' });
    const result = matchEvents([farther, near], [trackWork(5, { startDate: '2015-03-01' })]);
    assert.deepStrictEqual(pairIds(result), [['track-5', '10:amendment:1', 2]]);
    assert.strictEqual(result.sameEventChoice.length, 1);
    const [choice] = result.sameEventChoice;
    assert.strictEqual(choice.side, 'track');
    assert.strictEqual(choice.pair.sheet, near);
    assert.deepStrictEqual(choice.left.map(c => [c.work.sourceKey, c.gap]), [['10:amendment:2', 9]]);
  });

  await t.test('matchEvents breaks an equal-gap tie by Track work id, then sheet sourceKey, and gives the same pairs when the input order is reversed', () => {
    const sheets = [sheet('10:amendment:2', { startDate: '2015-03-01' }), sheet('10:amendment:1', { startDate: '2015-03-01' })];
    const tracks = [trackWork(121, { startDate: '2015-03-01' }), trackWork(39, { startDate: '2015-03-01' })];
    const expected = [['track-39', '10:amendment:1', 0], ['track-121', '10:amendment:2', 0]];
    assert.deepStrictEqual(pairIds(matchEvents(sheets, tracks)), expected);
    assert.deepStrictEqual(pairIds(matchEvents([...sheets].reverse(), [...tracks].reverse())), expected);
  });

  await t.test('matchEvents uses a Track work once: paired with a sheet work closed before B, it is not also paired with an open sheet band', () => {
    const closed = sheet('10:amendment:1', { startDate: '2020-05-01', decisionDate: '2021-01-10' });
    const open = sheet('10:amendment:2', { startDate: '2020-05-20', decisionDate: null });
    const result = matchEvents([open, closed], [trackWork(7, { startDate: '2020-05-01', decisionDate: '2021-01-12' })]);
    assert.deepStrictEqual(pairIds(result), [['track-7', '10:amendment:1', 0]]);
  });

  await t.test('matchEvents on the Track test shapes pairs Track 121, 316 and 300 with sheet 152, 162 and 238 (gaps 0, 0 and 8 days) and Track 124 with sheet 239 (27 days), and leaves Track 297 on sheet 285 (103 days) and Track 39 on sheet 395 unpaired', () => {
    const on = (projectId) => ({ projectId });
    const sheets = [
      sheet('152:amendment:1', { ...on('p-152'), startDate: '2019-12-05', decisionDate: '2025-06-17' }),
      sheet('162:amendment:1', { ...on('p-162'), startDate: '2018-10-29', decisionDate: '2019-02-01' }),
      sheet('238:amendment:1', { ...on('p-238'), startDate: '2020-03-24', decisionDate: '2020-09-01' }),
      sheet('239:amendment:1', { ...on('p-239'), startDate: '2023-06-25', decisionDate: '2023-11-30' }),
      sheet('285:amendment:1', { ...on('p-285'), startDate: '2020-09-14', decisionDate: '2021-08-01' }),
      sheet('395:amendment:1', { ...on('p-395'), startDate: '2021-01-15', decisionDate: '2021-03-01' })
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
  const paired = (trackId, sheetId = SHEET_A) => marker({ hidden: [{ trackWorkId: trackId, sheetWorkId: sheetId }] });
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

  await t.test('hiddenByOverride: a covered Track work with no decisionDate stays shown', () => {
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
});
