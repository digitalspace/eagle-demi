'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const catalog = require('../../src/domain/works-catalog');
const phaseCatalog = require('../../src/domain/phase-catalog');
const { TRACK_WORK_TYPE_CODES } = require('../../src/domain/work-model');
const { resolveWorksCatalog, run } = require('../../src/scripts/build-works-catalog');
const { resolveCatalog } = require('../../src/scripts/build-phase-catalog');
const { logger } = require('../../src/utils/logger');
const MAP = require('../../src/data/works-catalog-map.json');
const PHASE_MAP = require('../../src/data/phase-catalog-map.json');

/** One Eagle `eaDecisions` List row per name the map points at, as the backfill stores them. */
const LIST_ROWS = MAP.outcomes.filter(entry => entry.eagle).map((entry, index) =>
  ({ id: `decision-${index}`, kind: 'List', type: 'eaDecisions', legislation: 2002, name: entry.eagle }));

const { item: CATALOG, missing } = resolveWorksCatalog(MAP, { listRows: LIST_ROWS });

const PHASES = Object.fromEntries(resolveCatalog(PHASE_MAP, {
  listRows: PHASE_MAP.acts[2002].map((entry, index) =>
    ({ id: `phase-${index}`, kind: 'List', type: 'projectPhase', legislation: 2002, name: entry.name }))
}).items.map(item => [item.legislationYear, item.entries]));

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
  intakeTypes: ['Pre-EAO'],
  milestoneTypes: ['Transition Order (2018)']
};
const APPLIED_TO = ['Review', 'Evaluation', 'Decision', 'Early Engagement'];

test('every profiled label maps to a code or to skip2018', () => {
  const unmapped = Object.entries(PROFILED).flatMap(([list, labels]) => labels.filter(label =>
    !catalog.entryFor(CATALOG, list, label) && !catalog.skips2018(CATALOG, list, label)));
  const unplaced = APPLIED_TO.filter(label => !catalog.skips2018(CATALOG, 'appliedTo', label) &&
    ![1996, 2002].every(year => phaseCatalog.entryForName(PHASES, year, label)));
  assert.deepStrictEqual([...unmapped, ...unplaced], []);
  assert.deepStrictEqual(missing, []);
});

test('sheet labels resolve to the codes the loader stores', () => {
  const codeOf = (list, label) => catalog.entryFor(CATALOG, list, label).code;
  assert.strictEqual(codeOf('outcomes', 'PA Certificate Granted'), 'certificate-issued');
  assert.strictEqual(catalog.certificateKindOf(CATALOG, 'PA Certificate Granted'), 'PAC');
  assert.strictEqual(catalog.certificateKindOf(CATALOG, 'EA Certificate Granted'), 'EAC');
  assert.strictEqual(catalog.certificateKindOf(CATALOG, 'Withdrawn'), null);
  assert.strictEqual(codeOf('milestoneTypes', 'Transition Order (2018)'), 'act-transition');
  assert.strictEqual(codeOf('workStates', 'Incomplete/Inactive'), 'inactive');
  assert.strictEqual(codeOf('workStates', 'transitioned'), 'transitioned');
  assert.strictEqual(phaseCatalog.entryForName(PHASES, 1996, 'Decision').name, 'Referral');
  assert.strictEqual(catalog.entryFor(CATALOG, 'commentPeriodTypes', 'IPD PECP'), null);
  assert.strictEqual(catalog.entryFor(null, 'outcomes', 'Withdrawn'), null);
});

test('catalog trackIds equal TRACK_WORK_TYPE_CODES', () => {
  const pairs = CATALOG.workTypes.flatMap(entry => entry.trackIds.map(id => [String(id), entry.code]));
  assert.deepStrictEqual(Object.fromEntries(pairs), { ...TRACK_WORK_TYPE_CODES });
  assert.strictEqual(pairs.length, Object.keys(TRACK_WORK_TYPE_CODES).length);
});

test('every interruption type carries its legalSection', () => {
  for (const entry of CATALOG.interruptionTypes) {
    assert.ok(Object.hasOwn(entry, 'legalSection'), entry.code);
    if (entry.kind) assert.ok(entry.name.endsWith(entry.legalSection), entry.code);
  }
  assert.strictEqual(catalog.entryFor(CATALOG, 'interruptionTypes', 'Suspension s.30(1)').legalSection, 's.30(1)');
});

test('an Eagle row this environment lacks, or a label two entries claim, is reported', () => {
  const clash = { ...MAP, complexities: [...MAP.complexities, { code: 'typical-2', name: 'Typical' }] };
  const result = resolveWorksCatalog(clash, { listRows: LIST_ROWS.filter(row => row.name !== 'Terminated') });
  assert.deepStrictEqual(result.missing, ['outcomes "terminated": Eagle List row "Terminated"',
    'complexities "typical": held by typical, typical-2']);
  assert.strictEqual(CATALOG.outcomes.find(entry => entry.code === 'terminated').eagleListId,
    LIST_ROWS.find(row => row.name === 'Terminated').id);
});

function fakeLists(stored = null) {
  const writes = [];
  return {
    writes,
    listEveryOfKind: async (kind) => (kind === 'List' ? LIST_ROWS : []),
    readWorksCatalog: async () => stored,
    upsert: async (item) => { writes.push(item.id); }
  };
}

test('--dry-run writes nothing and prints missing=0; a write skips an unchanged item', async (t) => {
  const lines = [];
  t.mock.method(logger, 'info', (line) => lines.push(line));
  const dry = fakeLists();
  await run({ dryRun: true, deps: { lists: dry } });
  assert.deepStrictEqual(dry.writes, []);
  assert.ok(lines.includes('[works-catalog] mode=dry-run written=0 unchanged=0 missing=0'));

  const live = fakeLists();
  await run({ deps: { lists: live } });
  assert.deepStrictEqual(live.writes, ['works-catalog']);

  const same = fakeLists({ ...CATALOG, _etag: 'e1' });
  assert.strictEqual((await run({ deps: { lists: same } })).unchanged, 1);
  assert.deepStrictEqual(same.writes, []);
});
