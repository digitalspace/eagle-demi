'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { run } = require('../../src/scripts/check-business-works-parity');
const { COLUMNS } = require('../../src/scripts/works-crosswalk');
const { mapBusinessWorks } = require('../../src/domain/business-works-map');
const { idOf } = require('../../src/domain/extensions');
const { hiddenByOverride, overrideBoundaryOf } = require('../../src/domain/work-model');
const { fingerprintOf, openEnvelope, sealEnvelope, sha256Hex, sign, verify } = require('../../src/utils/import-envelope');
const { CATALOG, PHASES } = require('../helpers/business-works-fixtures');

const ENV = 'test';
const PROJECT = 'project-alpha';
const AT = '2026-11-13T00:00:00.000Z';
const CROSSWALK = new Map([[101, PROJECT]]);
const TEST_ENDPOINT = 'https://demi-cosmos-test.documents.azure.com:443/';
const MANUAL_SHA = 'a'.repeat(64);

// Keys made for this run only.
const pemOf = (key, type) => key.export({ type, format: 'pem' });
const devboxRsa = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
const devboxEd = crypto.generateKeyPairSync('ed25519');
const operator = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
const DEVBOX_FP = fingerprintOf({ rsa: devboxRsa.publicKey, ed25519: devboxEd.publicKey });
const OPERATOR_FP = fingerprintOf({ rsa: operator.publicKey });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'business-works-parity-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const ref = (sheet, slot) => ({ file: 'made-up.xlsx', sheet, row: 5, ...(slot && { slot }) });
const register = () => ({
  ref: ref('Projects'), id: 101, name: 'Sample Mine', intakeType: 's.6', intakeDate: '2005-01-01',
  determinationType: 's.10(1)(c)', determinationDate: '2005-03-01', decision: 'EA Certificate Granted', decisionDate: '2008-05-01'
});
const amendment = (slot, startDate, endDate) => ({ ref: ref('Amendments', slot), id: 101, name: 'Sample Mine', startDate, endDate });
const extractOf = (...amendments) => ({ records: { projects: [register()], amendments } });
const trackWork = (n, fields) => ({
  id: `track-${n}`, projectId: PROJECT, source: 'track', workTypeId: 7, workState: 'IN_PROGRESS', startDate: null, decisionDate: null, ...fields
});
const settledAmendment = trackWork(500, { workState: 'COMPLETED', startDate: '2010-01-05', decisionDate: '2010-03-02' });
const aliveAmendment = trackWork(501, { startDate: '2010-01-05' });
const decided2018 = trackWork(900, { workTypeId: 6, workState: 'COMPLETED', startDate: '2020-03-01', decisionDate: '2023-10-10' });

/** What a load of `extract` stores, with W8a's sourceKey to sheetWorkId swap on each marker. */
function loaded(extract, trackWorks = []) {
  const result = mapBusinessWorks(extract, {
    catalog: CATALOG, phaseCatalog: PHASES, crosswalk: CROSSWALK, batchId: 'batch-1', batchAt: AT,
    trackWorks: new Map([[PROJECT, trackWorks]])
  });
  const idOfKey = new Map(result.works.map(work => [work.sourceKey, work.id]));
  const markers = new Map(result.markers.map(marker => [marker.projectId, {
    ...marker,
    hidden: marker.hidden.map(pair => ({ trackWorkId: pair.trackWorkId, sheetWorkId: idOfKey.get(pair.sourceKey) })),
    untilTrack: marker.untilTrack.map(key => idOfKey.get(key))
  }]));
  return { works: result.works, markers };
}

const stateOf = ({ works, markers }, { track = [], rows = new Map([[PROJECT, { id: PROJECT }]]), commentPeriods = new Map() } = {}) => ({
  rows, works: new Map([[PROJECT, [...works, ...track]]]), markers, commentPeriods, catalog: CATALOG, phaseCatalog: PHASES
});

/** `state` with `child` added to the first phase of the first stored work that has phases. */
function withChild(state, key, child) {
  const at = state.works.findIndex(work => Array.isArray(work.phases) && work.phases.length);
  const works = state.works.map((work, i) => (i !== at ? work : {
    ...work, phases: [{ ...work.phases[0], [key]: [...(work.phases[0][key] || []), child] }, ...work.phases.slice(1)]
  }));
  return { ...state, works };
}

/** The extract and crosswalk sealed to the devbox as W4 and W5 write them, plus the key files. */
function inputFiles(extract, dir) {
  const text = Buffer.from(JSON.stringify({ env: ENV, staffIncluded: false, numbersReal: false, ...extract }));
  const extractSha = sha256Hex(text);
  const toDevbox = (plaintext, purpose, extra = {}) => sealEnvelope(plaintext, {
    purpose, env: ENV, keyFingerprint: DEVBOX_FP, recipientKey: devboxRsa.publicKey, ...extra
  });
  const row = { row: '5', sheetId: '101', sheetName: 'Sample Mine', state: 'exact', via: 'name', targetId: PROJECT };
  const csv = Buffer.from([['extractSha256', extractSha, 'manualSha256', MANUAL_SHA], COLUMNS, COLUMNS.map(c => row[c] ?? '')]
    .map(cells => cells.map(cell => `"${cell}"`).join(',')).join('\r\n').concat('\r\n'));
  const files = {
    extract: toDevbox(text, 'extract', { staffIncluded: false, numbersReal: false }),
    crosswalk: toDevbox(csv, 'crosswalk', { signature: sign(devboxEd.privateKey, { purpose: 'crosswalk', env: ENV, sha256: sha256Hex(csv) }) }),
    'devbox-key': pemOf(devboxRsa.privateKey, 'pkcs8') + pemOf(devboxEd.privateKey, 'pkcs8'),
    'operator-key': pemOf(operator.publicKey, 'spki')
  };
  Object.entries(files).forEach(([name, body]) => fs.writeFileSync(path.join(dir, name), body));
  return { extractSha, path: (name) => path.join(dir, name) };
}

async function check(extract, state, { endpoint = TEST_ENDPOINT, expectExtractSha, operatorFp = OPERATOR_FP } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'run-'));
  const files = inputFiles(extract, dir);
  const argv = ['--extract', files.path('extract'), '--expect-extract-sha256', expectExtractSha || files.extractSha,
    '--crosswalk', files.path('crosswalk'), '--expect-manual-sha256', MANUAL_SHA, '--devbox-key', files.path('devbox-key'),
    '--operator-key', files.path('operator-key'), '--expect-operator-fingerprint', operatorFp, '--out-dir', dir];
  const lines = [];
  const code = await run(argv, { endpoint, state: typeof state === 'function' ? state : async () => state, write: line => lines.push(line), now: new Date(AT) });
  const value = (name) => lines.find(line => line.startsWith(`${name}=`)).slice(name.length + 1);
  const opened = openEnvelope(fs.readFileSync(path.join(dir, value('blob'))), {
    purpose: 'report', env: ENV, keyFingerprint: OPERATOR_FP, privateKey: operator.privateKey
  });
  const report = JSON.parse(opened.plaintext.toString('utf8'));
  return {
    code, lines, opened, value, count: (name) => Number(value(name)), listed: (name) => report.items.filter(item => item.list === name)
  };
}

test('check-business-works-parity', async (t) => {
  const extract = extractOf(amendment('1', '2010-01-01', '2010-03-01'));
  const open = extractOf(amendment('1', '2010-01-01', null));

  await t.test('exits 0 with mismatch=0 when the stored works match the extract', async () => {
    const result = await check(extract, stateOf(loaded(extract)));
    assert.strictEqual(result.count('mismatch'), 0);
    assert.strictEqual(result.code, 0);
  });

  await t.test('exits 1 and lists the path when a stored date changed', async () => {
    const state = loaded(extract);
    const changed = state.works.map(work => (work.workTypeCode === 'amendment' ? { ...work, decisionDate: '2010-04-01' } : work));
    const result = await check(extract, stateOf({ ...state, works: changed }));
    assert.strictEqual(result.code, 1);
    assert.deepStrictEqual([result.listed('mismatch')[0].reason, result.listed('mismatch')[0].paths], ['dateChanged', '.decisionDate']);
  });

  await t.test('exits 1 when two projects claim one (system, value) external id', async () => {
    const rows = new Map([[PROJECT, { id: PROJECT, externalIds: [{ system: 'track', value: '7' }] }],
      ['project-beta', { id: 'project-beta', externalIds: [{ system: 'track', value: '7' }] }]]);
    const result = await check(extract, stateOf(loaded(extract), { rows }));
    assert.strictEqual(result.count('duplicateExternalId'), 1);
    assert.strictEqual(result.code, 1);
  });

  await t.test('exits 1 when two stored works share a sourceKey', async () => {
    const state = loaded(extract);
    const twin = { ...state.works.find(work => work.workTypeCode === 'amendment'), id: 'sheet-twin' };
    const result = await check(extract, stateOf({ ...state, works: [...state.works, twin] }));
    assert.strictEqual(result.count('duplicateSourceKey'), 1);
    assert.strictEqual(result.code, 1);
  });

  await t.test('a reverted marker adds nothing to hiddenDrift and counts one overrideHeldOff', async () => {
    const state = loaded(extract);
    state.markers.get(PROJECT).active = false;
    const result = await check(extract, stateOf(state, { track: [settledAmendment] }));
    assert.deepStrictEqual([result.count('hiddenDrift'), result.count('overrideHeldOff')], [0, 1]);
  });

  await t.test('a covered Track work pushed after the load that matches a loaded sheet work is listed in hiddenDrift and stays shown', async () => {
    const state = loaded(extract);
    const [item] = (await check(extract, stateOf(state, { track: [settledAmendment] }))).listed('hiddenDrift');
    assert.deepStrictEqual([item.reason, item.trackWorkId], ['matchNotHidden', 'track-500']);
    const sheetIds = state.works.map(work => work.id);
    assert.strictEqual(hiddenByOverride(settledAmendment, state.markers.get(PROJECT), overrideBoundaryOf([settledAmendment]), sheetIds), false);
  });

  await t.test('a trackAlive skip whose Track work was deleted is listed in hiddenDrift', async () => {
    const result = await check(extract, stateOf(loaded(extract, [aliveAmendment])));
    assert.deepStrictEqual(result.listed('hiddenDrift'),
      [{ list: 'hiddenDrift', project: PROJECT, reason: 'trackAliveGone', trackWorkId: 'track-501', sourceKey: '101:amendment:1' }]);
  });

  await t.test('a sheet amendment closed 2023-11-01, loaded with boundaryAtLoad 2025-01-01, is listed sheetHiddenByMovedBoundary once a Track Assessment decided 2023-10-10 moves B', async () => {
    const late = extractOf(amendment('1', '2023-06-01', '2023-11-01'));
    const state = loaded(late);
    assert.strictEqual(state.markers.get(PROJECT).boundaryAtLoad, '2025-01-01');
    const result = await check(late, stateOf(state, { track: [decided2018] }));
    const [item] = result.listed('sheetHiddenByMovedBoundary');
    assert.deepStrictEqual([item.sourceKey, item.boundary], ['101:amendment:1', '2023-10-10']);
    assert.strictEqual(result.count('hiddenDrift'), 0);
  });

  const period = { id: 'cp-1', read: ['staff'] };
  const suspension = { type: 'Suspension', start: '2007-01-01', end: '2007-02-01' };
  const linked = (key, links) => withChild(loaded(extract), key, { id: 'child', links });
  // [count, expected, case, stored state]
  const counterRows = [
    ['danglingEagleItemId', 1, 'an interruption links an Eagle item the row lacks', () => stateOf(linked('interruptions', { eagleItemId: 'gone' }))],
    ['danglingEagleItemId', 0, 'an interruption links an Eagle item the row holds', () => stateOf(linked('interruptions', { eagleItemId: idOf(suspension) }),
      { rows: new Map([[PROJECT, { id: PROJECT, reviewSuspensions: [suspension] }]]) })],
    ['commentPeriodMissing', 1, 'a milestone links a comment period that is gone', () => stateOf(linked('milestones', { commentPeriodId: 'cp-1' }))],
    ['commentPeriodNotPublic', 1, 'a milestone links a staff-only comment period', () => stateOf(linked('milestones', { commentPeriodId: 'cp-1' }),
      { commentPeriods: new Map([[PROJECT, [period]]]) })],
    ['commentPeriodNotPublic', 0, 'a milestone links a public comment period', () => stateOf(linked('milestones', { commentPeriodId: 'cp-1' }),
      { commentPeriods: new Map([[PROJECT, [{ ...period, read: ['public'] }]]]) })],
    ['undatedDates', 1, 'a stored work carries an undated date', () => {
      const state = loaded(extract);
      return stateOf({ ...state, works: state.works.map((work, i) => (i === 0 ? { ...work, undated: { decisionDate: true } } : work)) });
    }]
  ];
  for (const [name, expected, label, build] of counterRows) {
    await t.test(`${name}=${expected} when ${label}`, async () => {
      assert.strictEqual((await check(extract, build())).count(name), expected);
    });
  }

  // [list, the fields its one item must carry, extract, stored state]
  const driftRows = [
    ['hiddenDrift', { reason: 'hiddenNotSettled', trackWorkId: 'track-500' }, extract, () => stateOf(loaded(extract, [settledAmendment]),
      { track: [{ ...settledAmendment, decisionDate: '2025-03-01' }] })],
    ['hiddenDrift', { reason: 'hiddenTrackGone', trackWorkId: 'track-500' }, extract, () => stateOf(loaded(extract, [settledAmendment]))],
    ['hiddenDrift', { reason: 'aliveNotSkipped', trackWorkId: 'track-501' }, extract, () => stateOf(loaded(extract), { track: [aliveAmendment] })],
    ['hiddenDrift', { reason: 'untilTrackChanged', sourceKey: '101:amendment:1' }, open, () => {
      const state = loaded(open);
      state.markers.get(PROJECT).untilTrack = [];
      return stateOf(state);
    }],
    ['untilTrackHidden', { sourceKey: '101:amendment:1', trackWorkId: 'track-502' }, open,
      () => stateOf(loaded(open), { track: [trackWork(502, { startDate: '2010-01-05' })] })]
  ];
  for (const [list, fields, input, build] of driftRows) {
    await t.test(`${list} lists ${fields.reason || 'the sheet work and the Track work that hides it'}`, async () => {
      const [item] = (await check(input, build())).listed(list);
      assert.deepStrictEqual(Object.fromEntries(Object.keys(fields).map(key => [key, item[key]])), fields);
    });
  }

  await t.test('stdout holds counts and the report hash only, and the sealed report verifies under the devbox key', async () => {
    const result = await check(extract, stateOf(loaded(extract), { track: [settledAmendment] }));
    assert.strictEqual(result.lines.filter(line => line.includes('amendment') || line.includes(PROJECT)).length, 0);
    assert.strictEqual(sha256Hex(result.opened.plaintext), result.value('reportSha256'));
    assert.strictEqual(verify(devboxEd.publicKey, { purpose: 'report', env: ENV, sha256: result.value('reportSha256') }, result.opened.signature), true);
  });

  await t.test('a wrong --expect-extract-sha256 refuses before the store is read', async () => {
    let read = false;
    await assert.rejects(check(extract, async () => { read = true; }, { expectExtractSha: 'b'.repeat(64) }),
      { message: 'extract SHA-256 does not match the expected value' });
    assert.strictEqual(read, false);
  });

  await t.test('refuses an operator key whose fingerprint is not the expected one', async () => {
    await assert.rejects(check(extract, stateOf(loaded(extract)), { operatorFp: 'c'.repeat(64) }),
      { message: 'fingerprint of operator key does not match' });
  });

  await t.test('refuses a COSMOS_ENDPOINT outside the test account', async () => {
    await assert.rejects(check(extract, stateOf(loaded(extract)), { endpoint: 'https://demi-cosmos-prod.documents.azure.com:443/' }),
      { message: 'COSMOS_ENDPOINT must name demi-cosmos-test' });
  });
});
