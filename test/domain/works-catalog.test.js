'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const catalog = require('../../src/domain/works-catalog');
const { TRACK_WORK_TYPE_CODES } = require('../../src/domain/work-model');
const { resolveWorksCatalog, run } = require('../../src/scripts/build-works-catalog');
const { resolveCatalog } = require('../../src/scripts/build-phase-catalog');
const { logger } = require('../../src/utils/logger');
const MAP = require('../../src/data/works-catalog-map.json');
const PHASE_MAP = require('../../src/data/phase-catalog-map.json');

/** One Eagle `eaDecisions` row per name the map points at, plus a 2018 row sharing one name. */
const LIST_ROWS = [...MAP.outcomes.filter(entry => entry.eagle).map((entry, index) =>
  ({ id: `decision-${index}`, kind: 'List', type: 'eaDecisions', legislation: 2002, name: entry.eagle })),
{ id: 'decision-2018', kind: 'List', type: 'eaDecisions', legislation: 2018, name: 'Certificate Issued' }];

const PHASE_ROWS = PHASE_MAP.acts[2002].map((entry, index) =>
  ({ id: `phase-${index}`, kind: 'List', type: 'projectPhase', legislation: 2002, name: entry.name }));
const PHASES = Object.fromEntries(resolveCatalog(PHASE_MAP, { listRows: PHASE_ROWS }).items
  .map(item => [item.legislationYear, item.entries]));
const phaseIdOf = (name) => PHASE_ROWS.find(row => row.name === name).id;

const resolve = (map = MAP, listRows = LIST_ROWS) => resolveWorksCatalog(map, { listRows, phaseCatalog: PHASES });
const { item: CATALOG, missing } = resolve();

/** The business sheet labels, as profiled, by the catalog list each maps into. */
const PROFILED = {
  outcomes: ['EA Certificate Granted', 'Withdrawn', 'PA Certificate Granted', 'EAC Not Required',
    'Not Designated Reviewable', 'Terminated', 'EA Certificate Refused'],
  complexities: ['Pre-2014', 'Typical', 'Simple', 'Complex'],
  workStates: ['Complete', 'Active', 'Withdrawn', 'On Hold'],
  interruptionTypes: ['Suspension s.24(2)', 'Suspension s.30(1)', 'Other', 'Extension s.24(4)', 'Extension s.38(1)'],
  commentPeriodTypes: ['Application PCP', 'Draft AIR PCP', 'Amendment PCP', 'Other PCP', 'IPD PECP',
    'VC Selection PCP', 'Draft Report PCP', 'Process Order PECP', 'Draft Report PECP', 'Project Desc. PCP',
    'Application PECP', 'Joint EAO/CEAA PCP', 'Other PECP', 'AIR PCP'],
  intakeTypes: ['Pre-EAO', 'Transition Order (2018)']
};
const APPLIED_TO = ['Review', 'Evaluation', 'Decision', 'Early Engagement'];

test('every profiled label maps to a code or to skip2018', () => {
  const unmapped = Object.entries(PROFILED).flatMap(([list, labels]) => labels.filter(label =>
    !catalog.entryFor(CATALOG, list, label) && !catalog.skips2018(CATALOG, list, label)));
  const unplaced = APPLIED_TO.filter(label => !catalog.skips2018(CATALOG, 'appliedTo', label) &&
    ![1996, 2002].every(year => catalog.appliedToPhaseOf(CATALOG, label, year)));
  assert.deepStrictEqual([...unmapped, ...unplaced], []);
  assert.deepStrictEqual(missing, []);
});

test('sheet labels resolve to the codes the loader stores', () => {
  const codeOf = (list, label) => catalog.entryFor(CATALOG, list, label).code;
  assert.strictEqual(codeOf('outcomes', '  pa certificate   GRANTED '), 'certificate-issued');
  assert.strictEqual(catalog.certificateKindOf(CATALOG, 'PA Certificate Granted'), 'PAC');
  assert.strictEqual(catalog.certificateKindOf(CATALOG, 'EA Certificate Granted'), 'EAC');
  assert.strictEqual(catalog.certificateKindOf(CATALOG, 'Withdrawn'), null);
  assert.strictEqual(codeOf('milestoneTypes', 'Transition Order (2018)'), 'act-transition');
  assert.strictEqual(codeOf('intakeTypes', 'Transition Order (2018)'), 'transition-order');
  assert.strictEqual(codeOf('workStates', 'Incomplete/Inactive'), 'inactive');
  assert.strictEqual(codeOf('workStates', 'transitioned'), 'transitioned');
  assert.strictEqual(catalog.appliedToPhaseOf(CATALOG, 'Decision', 1996), phaseIdOf('Referral'));
  assert.strictEqual(catalog.appliedToPhaseOf(CATALOG, 'Decision', 2018), null);
  assert.strictEqual(catalog.appliedToPhaseOf({ appliedTo: [{ label: '', catalogIds: { 1996: 'p' } }] }, ' ', 1996), null);
  assert.strictEqual(catalog.appliedToPhaseOf({ appliedTo: [{ label: 'Review' }] }, 'Review', 1996), null);
  assert.strictEqual(CATALOG.outcomes[0].eagleListId, 'decision-0');
  assert.strictEqual(catalog.entryFor(CATALOG, 'commentPeriodTypes', 'IPD PECP'), null);
  assert.strictEqual(catalog.entryFor(null, 'outcomes', 'Withdrawn'), null);
});

test('catalog trackIds equal TRACK_WORK_TYPE_CODES, whatever the map says', () => {
  const pairs = CATALOG.workTypes.flatMap(entry => entry.trackIds.map(id => [String(id), entry.code]));
  assert.deepStrictEqual(Object.fromEntries(pairs), { ...TRACK_WORK_TYPE_CODES });
  assert.strictEqual(pairs.length, Object.keys(TRACK_WORK_TYPE_CODES).length);

  const stray = { ...MAP, workTypes: [{ ...MAP.workTypes[0], trackIds: [99] }, ...MAP.workTypes.slice(1)] };
  assert.deepStrictEqual(resolve(stray).item.workTypes[0].trackIds, [6]);
});

test('every interruption type carries its legalSection; only other has no kind', () => {
  for (const entry of CATALOG.interruptionTypes) {
    assert.ok(Object.hasOwn(entry, 'legalSection'), entry.code);
    if (entry.code !== 'other') assert.ok(entry.name.endsWith(entry.legalSection), entry.code);
  }
  assert.deepStrictEqual(CATALOG.interruptionTypes.filter(entry => entry.kind === null).map(entry => entry.code),
    ['other']);
});

test('what does not resolve, or two owners claim, is reported', () => {
  const broken = {
    ...MAP,
    complexities: [...MAP.complexities, { code: 'typical-2', name: 'Typical' }, { code: 'simple', name: 'Easy' }],
    appliedTo: [...MAP.appliedTo, { label: 'Early Engagement', phase: 'Scoping', acts: [2002] },
      { label: 'Decision', phase: 'Application Review', acts: [1996, 2002] }, { label: 'Hearing', phase: 'Referral' }],
    skip2018: { ...MAP.skip2018, outcomes: ['Withdrawn'], phases: ['Review'] }
  };
  const rows = [...LIST_ROWS.filter(row => row.name !== 'Terminated'),
    { id: 'decision-twin', kind: 'List', type: 'eaDecisions', legislation: 2002, name: 'Withdrawn' }];
  assert.deepStrictEqual(resolve(broken, rows).missing, [
    'outcomes "terminated": Eagle List row "Terminated"',
    'outcomes "withdrawn": Eagle List row "Withdrawn"',
    'outcomes "withdrawn": held by withdrawn, skip2018',
    'complexities "simple": duplicate code',
    'complexities "typical": held by typical, typical-2',
    'appliedTo "Early Engagement": 2002 phase "Scoping"',
    'appliedTo "Hearing": no acts',
    'appliedTo "decision": held by appliedTo[2], appliedTo[4]',
    'appliedTo "early engagement": held by appliedTo[3], skip2018',
    'skip2018 "phases": not a catalog list'
  ]);
});

function fakeLists(stored = null) {
  const writes = [];
  return {
    writes,
    listEveryOfKind: async (kind) => (kind === 'List' ? LIST_ROWS : []),
    readCatalog: async (year) => (PHASES[year] ? { entries: PHASES[year] } : null),
    readWorksCatalog: async () => stored,
    upsert: async (item) => { writes.push(item.id); }
  };
}

test('--dry-run writes nothing and prints missing=0; a write goes only where it changes something', async (t) => {
  const lines = [];
  t.mock.method(logger, 'info', (line) => lines.push(line));
  const dry = fakeLists();
  await run({ dryRun: true, deps: { lists: dry } });
  assert.deepStrictEqual(dry.writes, []);
  assert.ok(lines.includes('[works-catalog] mode=dry-run written=0 unchanged=0 missing=0'));

  const same = fakeLists({ ...CATALOG, _etag: 'e1' });
  assert.strictEqual((await run({ deps: { lists: same } })).unchanged, 1);
  assert.deepStrictEqual(same.writes, []);

  const changed = fakeLists({ ...CATALOG, complexities: [] });
  await run({ deps: { lists: changed } });
  assert.deepStrictEqual(changed.writes, ['works-catalog']);
});

test('a live run with anything missing writes nothing', async (t) => {
  t.mock.method(logger, 'info', () => {});
  t.mock.method(logger, 'warn', () => {});
  const short = { ...fakeLists(), listEveryOfKind: async () => LIST_ROWS.slice(1) };
  const summary = await run({ deps: { lists: short } });
  assert.ok(summary.missing > 0);
  assert.deepStrictEqual(short.writes, []);
});
