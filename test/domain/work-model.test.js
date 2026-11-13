'use strict';

const test = require('node:test');
const assert = require('node:assert');

const model = require('../../src/domain/work-model');
const override = require('../../src/domain/work-override');

const { childIdOf, inEffect, newWorkId, sourceKeyOf, summaryOf, transitionDateOf, validateWork } = model;

const SHEET_A = 'sheet-00000000-0000-4000-8000-00000000000a';
const work = (fields) => ({ id: SHEET_A, source: 'sheet', projectId: 'project-alpha', workTypeCode: 'amendment', ...fields });
const rulesOf = (result) => (result.errors || []).map(error => error.rule);

test('work-model re-exports every override name, so callers import one module', () => {
  for (const name of ['OVERRIDE_MARKER_ID', 'OVERRIDE_TYPES', 'TRACK_WORK_TYPE_CODES', 'hiddenByOverride', 'matchEvents',
    'overrideBoundaryOf', 'sameEvent', 'settledBefore', 'untilTrackHidden', 'validateMarker', 'dayOf']) {
    assert.strictEqual(model[name], override[name], name);
  }
});

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
    assert.deepStrictEqual(rulesOf(validateWork(work({ phases: [{ id: `${SHEET_A}:referral` }] }))), ['child-id']);
  });

  await t.test('child ids must be unique within the document', () => {
    const doc = work({ phases: [{ id: 'referral', milestones: [{ id: 'referral' }] }] });
    assert.deepStrictEqual(rulesOf(validateWork(doc)), ['child-id']);
  });
});

test('validateWork identity', async (t) => {
  await t.test('a sheet or demi work needs id, source, projectId and workTypeCode', () => {
    assert.strictEqual(validateWork(work()).ok, true);
    assert.deepStrictEqual(rulesOf(validateWork({ id: SHEET_A, source: 'sheet' })), ['required', 'required']);
    assert.deepStrictEqual(rulesOf(validateWork(work({ source: undefined }))), ['required']);
  });

  await t.test('a Track work may lack source and workTypeCode, but never projectId or another source', () => {
    assert.strictEqual(validateWork({ id: 'track-12', projectId: '12' }).ok, true);
    assert.deepStrictEqual(rulesOf(validateWork({ id: 'track-12' })), ['required']);
    assert.deepStrictEqual(rulesOf(validateWork({ id: 'track-12', projectId: '12', source: 'sheet' })), ['source']);
  });

  await t.test('a sheet work id must be sheet-<uuid>, so the marker id is not a work id', () => {
    assert.deepStrictEqual(rulesOf(validateWork(work({ id: 'sheet-override' }))), ['id']);
    assert.deepStrictEqual(rulesOf(validateWork(work({ id: 'sheet-152:amendment:1' }))), ['id']);
  });
});

test('validateWork content', async (t) => {
  await t.test('rejects end before start', () => {
    assert.deepStrictEqual(rulesOf(validateWork(work({ phases: [{ startDate: '2010-05-01', endDate: '2010-04-30' }] }))),
      ['end-before-start']);
    assert.deepStrictEqual(rulesOf(validateWork(work({ startDate: '2010-05-01', decisionDate: '2010-04-01' }))),
      ['end-before-start']);
    const milestone = { actualDate: '2010-05-01', endDate: '2010-04-01' };
    assert.deepStrictEqual(rulesOf(validateWork(work({ phases: [{ milestones: [milestone] }] }))), ['end-before-start']);
  });

  await t.test('rejects a staff key on a work', () => {
    assert.deepStrictEqual(rulesOf(validateWork(work({ staff: true }))), ['staff-data']);
    assert.deepStrictEqual(rulesOf(validateWork(work({ capitalInvestments: [] }))), ['staff-data']);
    assert.deepStrictEqual(rulesOf(validateWork(work({ phases: [{ milestones: [{ contacts: [] }] }] }))), ['staff-data']);
    assert.deepStrictEqual(rulesOf(validateWork(work({ phases: [{ interruptions: [{ kind: 'suspension', notes: 'x' }] }] }))),
      ['staff-data']);
  });

  await t.test('a staff key is refused at any depth', () => {
    const deep = work({ phases: [{ milestones: [{ links: { contacts: [] } }] }] });
    assert.deepStrictEqual(validateWork(deep).errors, [{ path: 'phases.0.milestones.0.links.contacts', rule: 'staff-data' }]);
    const transition = work({ actYear: 2002, transitionOut: { toActYear: 2018, date: null, dateSource: 'none', notes: 'x' } });
    assert.deepStrictEqual(rulesOf(validateWork(transition)), ['staff-data']);
    assert.deepStrictEqual(rulesOf(validateWork(work({ sourceRef: { sheet: { investment: 5 } } }))), ['staff-data']);
  });

  await t.test('phases, milestones and interruptions must be lists of objects', () => {
    assert.deepStrictEqual(rulesOf(validateWork(work({ phases: {} }))), ['list']);
    assert.deepStrictEqual(rulesOf(validateWork(work({ phases: [null] }))), ['object']);
    assert.deepStrictEqual(rulesOf(validateWork(work({ phases: [{ milestones: 'none' }] }))), ['list']);
    assert.deepStrictEqual(rulesOf(validateWork(work({ phases: [{ interruptions: [5] }] }))), ['object']);
  });

  await t.test('dates must be real ISO dates', () => {
    assert.deepStrictEqual(rulesOf(validateWork(work({ startDate: '2023-02-30' }))), ['date']);
    assert.deepStrictEqual(rulesOf(validateWork(work({ startDate: '2023-02-30T10:00:00Z' }))), ['date']);
    assert.deepStrictEqual(rulesOf(validateWork(work({ startDate: 'March 3, 2023' }))), ['date']);
  });

  await t.test('an impossible month or day is a date error, never a throw', () => {
    for (const startDate of ['2023-13-01', '2023-02-32', '2023-00-10', '2023-02-00', '2023-13-01T10:00:00Z']) {
      assert.deepStrictEqual(rulesOf(validateWork(work({ startDate }))), ['date'], startDate);
    }
  });

  await t.test('interruption kind and act year are checked', () => {
    assert.deepStrictEqual(rulesOf(validateWork(work({ phases: [{ interruptions: [{ kind: 'pause' }] }] }))), ['kind']);
    assert.deepStrictEqual(rulesOf(validateWork(work({ actYear: 2019 }))), ['act-year']);
  });

  await t.test('undated field must be null', () => {
    const undated = { decisionDate: { notAfter: '1995-06-30' } };
    assert.strictEqual(validateWork(work({ decisionDate: null, undated })).ok, true);
    assert.deepStrictEqual(rulesOf(validateWork(work({ decisionDate: '1995-06-30', undated }))), ['undated-holds-date']);
  });

  await t.test('undated keys are limited to date fields, and the error does not name the key', () => {
    const result = validateWork(work({ undated: { sneakyKey: { notAfter: '1995-06-30' } } }));
    assert.deepStrictEqual(result.errors, [{ path: 'undated', rule: 'undated-key' }]);
  });

  await t.test('transitionOut date only with dateSource sheet or track', () => {
    const withOut = (transitionOut) => validateWork(work({ actYear: 2002, transitionOut }));
    assert.strictEqual(withOut({ toActYear: 2018, date: '2023-01-10', dateSource: 'sheet' }).ok, true);
    assert.strictEqual(withOut({ toActYear: 2018, date: '2025-05-21', dateSource: 'track' }).ok, true);
    assert.strictEqual(withOut({ toActYear: 2018, date: null, dateSource: 'none' }).ok, true);
    assert.deepStrictEqual(rulesOf(withOut({ toActYear: 2018, date: '2023-01-10', dateSource: 'none' })), ['date-source']);
    assert.deepStrictEqual(rulesOf(withOut({ toActYear: 2018, date: null, dateSource: 'eagle' })), ['date-source']);
    assert.deepStrictEqual(rulesOf(withOut({ toActYear: 2018, date: '2025-05-21', dateSource: 'sheet' })), ['sheet-date-after']);
  });

  await t.test('transitionOut moves to a later registry Act than the work\'s', () => {
    const withOut = (actYear, toActYear) => validateWork(work({ actYear, transitionOut: { toActYear, date: null, dateSource: 'none' } }));
    assert.deepStrictEqual(rulesOf(withOut(2002, 2002)), ['act-year']);
    assert.deepStrictEqual(rulesOf(withOut(2002, 2019)), ['act-year']);
    assert.strictEqual(withOut(1996, 2002).ok, true);
  });

  await t.test('rejects < in a public string and in legalSection', () => {
    assert.deepStrictEqual(rulesOf(validateWork(work({ title: 'Mine <b>' }))), ['markup']);
    assert.deepStrictEqual(rulesOf(validateWork(work({ phases: [{ sourceName: 'a<b' }] }))), ['markup']);
    assert.deepStrictEqual(rulesOf(validateWork({ id: 'track-1', projectId: '1', simpleTitle: 'a<b' })), ['markup']);
    const doc = work({ phases: [{ interruptions: [{ kind: 'suspension', legalSection: 's.<30' }] }] });
    assert.deepStrictEqual(rulesOf(validateWork(doc)), ['markup']);
    assert.strictEqual(validateWork(work({ sourceRef: { sheet: { file: 'a<b' } } })).ok, true);
  });

  await t.test('rejects control characters everywhere', () => {
    assert.deepStrictEqual(rulesOf(validateWork(work({ sourceRef: { sheet: { file: 'a\u0007b' } } }))), ['control-character']);
    assert.deepStrictEqual(rulesOf(validateWork(work({ phases: [{ sourceName: 'Pre\nApp' }] }))), ['control-character']);
  });

  await t.test('rejects stored interruption days that are not end minus start', () => {
    const doc = work({ phases: [{ interruptions: [{ kind: 'suspension', startDate: '2010-01-01', endDate: '2010-01-31', days: 31 }] }] });
    assert.deepStrictEqual(rulesOf(validateWork(doc)), ['days']);
  });

  await t.test('validator errors carry no value', () => {
    const planted = 'PLANTED';
    const doc = {
      id: `${planted}-1`, source: planted, actYear: 2002, title: `${planted}<`, capitalInvestments: planted,
      startDate: '2010-05-01', decisionDate: planted,
      undated: { [`${planted}\u0007`]: planted, startDate: { notAfter: planted } },
      transitionOut: { toActYear: 1996, date: '2026-01-01', dateSource: 'sheet' },
      phases: [{ id: 'p', startDate: '2010-05-01', endDate: '2010-04-01', milestones: [{ id: 'p' }],
        interruptions: [{ kind: planted, startDate: '2010-01-01', endDate: '2010-01-03', days: 9 }] }]
    };
    const result = validateWork(doc);
    assert.deepStrictEqual(new Set(rulesOf(result)), new Set(['control-character', 'markup', 'id', 'source', 'required',
      'staff-data', 'date', 'end-before-start', 'undated-key', 'undated-holds-date', 'undated', 'sheet-date-after',
      'act-year', 'kind', 'days', 'child-id']));
    assert.ok(result.errors.every(error => Object.keys(error).sort().join() === 'path,rule'));
    assert.ok(!JSON.stringify(result).includes(planted));
  });

  await t.test('oversize work returns reason oversize', () => {
    const milestones = Array.from({ length: 2001 }, () => ({}));
    assert.deepStrictEqual(validateWork(work({ phases: [{ milestones }] })), { ok: false, reason: 'oversize' });
    assert.strictEqual(validateWork(work({ phases: [{ sourceName: 'x'.repeat(1.6 * 1024 * 1024) }] })).reason, 'oversize');
    assert.strictEqual(validateWork(work({ phases: [{ milestones: milestones.slice(1) }] })).ok, true);
  });
});

test('summaryOf', async (t) => {
  const interruption = (kind, startDate, endDate) => ({ kind, startDate, endDate });
  const base = {
    startDate: '2010-01-01', decisionDate: '2010-12-31',
    phases: [
      { startDate: '2010-01-01', endDate: '2010-06-30',
        interruptions: [interruption('suspension', '2010-02-01', '2010-03-03'), interruption('extension', '2010-04-01', '2010-04-11')] },
      { startDate: '2010-07-01', endDate: '2010-12-31' }
    ]
  };

  await t.test('suspension days = end minus start', () => {
    assert.strictEqual(summaryOf(base).suspendedDays, 30);
    assert.strictEqual(summaryOf(base).extensionDays, 10);
  });

  await t.test('effort is elapsed minus suspended; phase days add up the phases', () => {
    const summary = summaryOf(base);
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

  await t.test('a suspension with no end makes suspended and effort days unknown, never 0', () => {
    const open = { ...base, phases: [{ ...base.phases[0], interruptions: [interruption('suspension', '2010-02-01', null)] }] };
    assert.strictEqual(summaryOf(open).suspendedDays, null);
    assert.strictEqual(summaryOf(open).effortDays, null);
    assert.strictEqual(summaryOf({ ...base, phases: [{ startDate: '2010-01-01' }] }).phaseDays, null);
  });

  await t.test('interruption days are clamped to the work, and nothing is negative', () => {
    const wide = { ...base, phases: [{ interruptions: [interruption('suspension', '2009-12-01', '2010-01-11')] }] };
    assert.strictEqual(summaryOf(wide).suspendedDays, 10);
    const backwards = summaryOf({ startDate: '2010-05-01', decisionDate: '2010-04-01' });
    assert.strictEqual(backwards.elapsedDays, 0);
  });

  await t.test('decisionYear is the Pacific year of a Track timestamp', () => {
    assert.strictEqual(summaryOf({ decisionDate: '2011-01-01T03:00:00.000Z' }).decisionYear, 2010);
  });

  await t.test('the work ends with its last phase by sortOrder, else by latest end', () => {
    const phases = [{ sortOrder: 2, endDate: '2010-03-01' }, { sortOrder: 1, endDate: '2010-09-01' }];
    assert.strictEqual(summaryOf({ startDate: '2010-01-01', phases }).elapsedDays, 59);
    const unordered = [{ endDate: '2010-09-01' }, { endDate: '2010-03-01' }];
    assert.strictEqual(summaryOf({ startDate: '2010-01-01', phases: unordered }).elapsedDays, 243);
  });
});

test('transitionDateOf', async (t) => {
  const assessment = (name, actualDate) => ({ workTypeId: 6, milestones: [{ name, actualDate }] });
  const trackMilestone = assessment('Project Transitioning FROM the EA Act (2002)', '2025-05-30T00:00:00.000Z');

  await t.test('transitionDateOf: sheet date before 2025 wins; else Track\'s milestone; else the stored fallback; else null', () => {
    assert.strictEqual(transitionDateOf({ toActYear: 2018, date: '2021-03-01', dateSource: 'sheet' }, [trackMilestone], 2002), '2021-03-01');
    assert.strictEqual(transitionDateOf({ toActYear: 2018, date: '2025-05-21', dateSource: 'track' }, [trackMilestone], 2002),
      '2025-05-30T00:00:00.000Z');
    assert.strictEqual(transitionDateOf({ toActYear: 2018, date: '2025-05-21', dateSource: 'track' }, [], 2002), '2025-05-21');
    assert.strictEqual(transitionDateOf({ toActYear: 2018, date: null, dateSource: 'none' }, [], 2002), null);
  });

  await t.test('Track\'s milestone counts only when it names the work\'s own Act', () => {
    const from1996 = assessment('Project Transitioning FROM the EA Act (1996)', '2003-01-15');
    const out = { toActYear: 2018, date: null, dateSource: 'none' };
    assert.strictEqual(transitionDateOf(out, [trackMilestone, from1996], 1996), '2003-01-15');
    assert.strictEqual(transitionDateOf(out, [from1996], 2002), null);
  });

  await t.test('Track\'s milestone counts only on an Assessment, by its exact name, with a date; the first wins', () => {
    const name = 'Project Transitioning FROM the EA Act (2002)';
    const dateOf = (works) => transitionDateOf({ toActYear: 2018, date: null, dateSource: 'none' }, works, 2002);

    assert.strictEqual(dateOf([{ ...assessment(name, '2025-05-30'), workTypeId: '6' }]), null);
    assert.strictEqual(dateOf([{ workTypeId: 7, milestones: [{ name, actualDate: '2025-05-30' }] }]), null);
    assert.strictEqual(dateOf([assessment(name, '   ')]), null);
    assert.strictEqual(dateOf([assessment('project transitioning from the EA Act (2002)', '2025-05-30')]), null);
    assert.strictEqual(dateOf([{ workTypeId: 6 }]), null);
    assert.strictEqual(dateOf([assessment(name, '2024-02-01'), assessment(name, '2025-05-30')]), '2024-02-01');
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
    assert.deepStrictEqual(inEffect(entries, { startDate: '2005-01-01', phases: [{ endDate: '2010-12-31' }] }).map(e => e.id), ['during']);
  });
});
