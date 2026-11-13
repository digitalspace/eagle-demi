'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, liveDemi } = require('../../src/scripts/load-business-works');
const { KINDS } = require('../../src/scripts/works-import-batch');
const { OVERRIDE_MARKER_ID } = require('../../src/domain/work-model');
const projects = require('../../src/repositories/projects');
const { deriveInputs } = require('../../src/domain/works-derive');
const { devboxKeysFromPem, fingerprintOf, openEnvelope, sealEnvelope, sha256Hex, sign } = require('../../src/utils/import-envelope');
const { COLUMNS } = require('../../src/scripts/works-crosswalk');
const { logger } = require('../../src/utils/logger');
const { CATALOG, PHASES, PROJECT, NUMBER, fakeLists, ref, register, amendment, trackWork } = require('./works-import-fakes');

const ENV = 'test';
const T0 = Date.parse('2026-11-13T18:00:00Z');
const pemOf = (key, type) => key.export({ type, format: 'pem' });
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
const ed = crypto.generateKeyPairSync('ed25519');
const operator = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
const keys = devboxKeysFromPem(pemOf(rsa.privateKey, 'pkcs8') + pemOf(ed.privateKey, 'pkcs8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'load-business-works-'));
const endpoint = process.env.COSMOS_ENDPOINT;
const testHost = 'https://demi-cosmos-test.documents.azure.com:443/';
process.env.COSMOS_ENDPOINT = testHost;
test.after(() => {
  if (endpoint === undefined) delete process.env.COSMOS_ENDPOINT;
  else process.env.COSMOS_ENDPOINT = endpoint;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const TRACK = [trackWork(43, { startDate: '2023-03-01', decisionDate: '2023-11-07' }), trackWork(45, { startDate: '2015-03-01', decisionDate: '2015-05-07' })];

/** A fake DEMI: works keyed by id with etags from each save, one project row, and every derive call. */
function fakeDemi() {
  const docs = new Map(TRACK.map(doc => [doc.id, { ...doc, _etag: '"t"' }]));
  const state = { saves: 0, derived: [], docs };
  let n = 0;
  const saveWork = async (doc) => {
    const stored = { ...doc, _etag: `"w${n += 1}"` };
    docs.set(doc.id, stored);
    state.saves += 1;
    return { status: 'written', etag: stored._etag };
  };
  return Object.assign(state, {
    worksCatalog: async () => CATALOG,
    phaseCatalog: async () => PHASES,
    works: async () => [...docs.values()].filter(doc => doc.id !== OVERRIDE_MARKER_ID),
    marker: async () => docs.get(OVERRIDE_MARKER_ID) || null,
    project: async id => (id === PROJECT ? { id: PROJECT, externalIds: [] } : null),
    trackPublic: async () => [],
    saveWork,
    tombstone: async doc => saveWork({ ...doc, deleted: true }),
    addExternalId: async () => ({ status: 'set' }),
    appendHistory: async () => ({ status: 'appended' }),
    patchDerived: async (id) => { state.derived.push(id); return { status: 'patched' }; }
  });
}

const toDevbox = (text, purpose, extra = {}) => sealEnvelope(Buffer.from(text), { purpose, env: ENV, keyFingerprint: keys.fingerprint, recipientKey: rsa.publicKey, ...extra });
const cell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;

/** Sealed extract and signed crosswalk on disk, and the argv of a dry run over them. */
function inputs({ records = { projects: [register], amendments: [amendment(1, '2023-06-01', '2023-11-07')] }, crosswalkRows } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'in-'));
  const outDir = fs.mkdtempSync(path.join(tmp, 'out-'));
  const signoffRefs = { keepStaff: null, keepNumbers: null };
  const extractText = JSON.stringify({ schemaVersion: 1, env: ENV, staffIncluded: false, numbersReal: false, signoffRefs, records });
  const extractSha256 = sha256Hex(Buffer.from(extractText));
  const manualSha256 = sha256Hex(Buffer.from('manual'));
  const rows = crosswalkRows || [{ row: 5, sheetId: NUMBER, state: 'exact', targetId: PROJECT }];
  const csv = [['extractSha256', extractSha256, 'manualSha256', manualSha256], COLUMNS, ...rows.map(r => COLUMNS.map(c => r[c]))]
    .map(line => line.map(cell).join(',')).join('\r\n').concat('\r\n');
  const crosswalkSha256 = sha256Hex(Buffer.from(csv));
  const signature = sign(keys.ed25519, { purpose: 'crosswalk', env: ENV, sha256: crosswalkSha256 });
  const file = (name, data) => { fs.writeFileSync(path.join(dir, name), data); return path.join(dir, name); };
  const argv = [
    '--extract', file('extract.sealed.json', toDevbox(extractText, 'extract', { staffIncluded: false, numbersReal: false, signoffRefs })),
    '--expect-sha256', extractSha256,
    '--crosswalk', file('crosswalk.sealed.json', toDevbox(csv, 'crosswalk', { signature })),
    '--expect-crosswalk-sha256', crosswalkSha256, '--expect-manual-sha256', manualSha256,
    '--devbox-key', file('devbox.key.pem', pemOf(rsa.privateKey, 'pkcs8') + pemOf(ed.privateKey, 'pkcs8')),
    '--operator-key', file('operator.pub.pem', pemOf(operator.publicKey, 'spki')),
    '--expect-operator-fingerprint', fingerprintOf({ rsa: operator.publicKey }), '--out-dir', outDir
  ];
  return { argv, outDir, dir };
}

async function load(argv, demi = fakeDemi()) {
  const lines = [];
  await run(argv, { write: line => lines.push(line), demi, now: () => T0 });
  const value = key => (lines.find(line => line.startsWith(`${key}=`)) || '').slice(key.length + 1);
  return { lines, value, demi };
}

/** The sealed dry-run report, opened as the operator opens it. */
const reportOf = (outDir, blob) => JSON.parse(openEnvelope(fs.readFileSync(path.join(outDir, blob)), {
  purpose: 'works-report', env: ENV, keyFingerprint: fingerprintOf({ rsa: operator.publicKey }), privateKey: operator.privateKey
}).plaintext);

const liveArgs = (planSha256, { signoff = true } = {}) =>
  ['--live', '--operator', 'operator-upn', '--run-ref', 'run-1', ...(signoff ? ['--signoff-ref', 'so-1'] : []), '--expect-plan-sha256', planSha256];

test('dry run twice on unchanged input gives the same planSha256', async () => {
  const { argv } = inputs();
  assert.equal((await load(argv)).value('planSha256'), (await load(argv)).value('planSha256'));
});

test('a planned document changed in between changes planSha256', async () => {
  const { argv } = inputs();
  const demi = fakeDemi();
  const before = (await load(argv, demi)).value('planSha256');
  demi.docs.set('sheet-old', { id: 'sheet-old', projectId: PROJECT, source: 'sheet', owner: 'sheet', sourceKey: '101:amendment:9', _etag: '"o"' });
  assert.notEqual((await load(argv, demi)).value('planSha256'), before);
});

test('a sheet number missing from the crosswalk fails the dry run', async () => {
  const { argv } = inputs({ records: { projects: [register, { ...register, id: 102, ref: ref('Projects') }] } });
  await assert.rejects(load(argv), /not in the signed crosswalk/);
});

test('refuses an unknown Cosmos host, prod included, in the dry run', async (t) => {
  t.after(() => { process.env.COSMOS_ENDPOINT = testHost; });
  process.env.COSMOS_ENDPOINT = 'https://demi-cosmos-prod.documents.azure.com:443/';
  await assert.rejects(load(inputs().argv), /test only/);
});

test('refuses the prod Cosmos host in live mode', async (t) => {
  t.after(() => { process.env.COSMOS_ENDPOINT = testHost; });
  process.env.COSMOS_ENDPOINT = 'https://demi-cosmos-prod.documents.azure.com:443/';
  await assert.rejects(load([...inputs().argv, ...liveArgs('0'.repeat(64))]), /test only/);
});

test('no plaintext file on the devbox: the dry run writes one sealed 0600 report and nothing else', async () => {
  const { argv, outDir, dir } = inputs();
  const before = fs.readdirSync(dir).sort();
  const { value } = await load(argv);
  assert.deepEqual(fs.readdirSync(outDir), [value('blob')]);
  assert.match(value('blob'), /^[0-9a-f-]{36}\.sealed\.json$/);
  assert.equal(fs.statSync(path.join(outDir, value('blob'))).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
});

test('stdout, stderr and logger output contain no sourceKey, number or staff value', async (t) => {
  const said = [];
  for (const level of ['error', 'warn', 'info', 'debug']) t.mock.method(logger, level, (...args) => { said.push(JSON.stringify(args)); });
  const { lines } = await load(inputs().argv);
  said.push(...lines);
  const text = said.join('\n').replace(/[0-9a-f]{64}|[0-9a-f-]{36}/g, '');
  assert.ok(!text.includes(':amendment:'));
  assert.ok(!/\b101\b/.test(text));
  assert.ok(!text.includes('Sample Mine'));
});

test('dry run lists trackHidden with project id, work id, type, start date and matched sheet work, and prints the override counts', async () => {
  const { argv, outDir } = inputs();
  const { value, lines } = await load(argv);
  const report = reportOf(outDir, value('blob'));
  const [hidden] = report.lists.trackHidden;
  assert.deepEqual([hidden.projectId, hidden.workId, hidden.type, hidden.startDate, hidden.gap], [PROJECT, 'track-43', 'amendment', '2023-03-01', 0]);
  assert.match(hidden.sheetWorkId, /^sheet-/);
  assert.equal(report.lists.trackShownNoSheetMatch[0].workId, 'track-45');
  const printed = lines.map(line => line.split('=')[0]);
  const wanted = ['trackHidden', 'sheetShown', 'trackShownNoSheetMatch', 'trackAlive', 'trackCompletedNoDate', 'untilTrack', 'sameEventChoice'];
  assert.deepEqual(wanted.filter(key => !printed.includes(key)), []);
});

test('a Track amendment decided before B with no matching loaded sheet work is listed trackShownNoSheetMatch with its nearest sheet amendment and the gap', async () => {
  const { argv, outDir } = inputs();
  const { value } = await load(argv);
  const report = reportOf(outDir, value('blob'));
  const [shown] = report.lists.trackShownNoSheetMatch;
  assert.equal(shown.workId, 'track-45');
  assert.equal(shown.nearest.gap, 3106);
});

test('live refuses without --signoff-ref', async () => {
  await assert.rejects(load([...inputs().argv, ...liveArgs('0'.repeat(64), { signoff: false })]), /missing --signoff-ref/);
});

test('live exits before any write on any hash mismatch, and leaves no lock', async (t) => {
  const store = fakeLists(t);
  const demi = fakeDemi();
  await assert.rejects(load([...inputs().argv, ...liveArgs('0'.repeat(64))], demi), /planSha256 does not match/);
  assert.equal(demi.saves, 0);
  assert.deepEqual(store.all(), []);
});

test('live writes the marker with hidden equal to the signed trackHidden pairs, each sheetWorkId the id written for its sourceKey', async (t) => {
  const store = fakeLists(t);
  const { argv } = inputs();
  const demi = fakeDemi();
  const planSha256 = (await load(argv, demi)).value('planSha256');
  await load([...argv, ...liveArgs(planSha256)], demi);
  const sheet = [...demi.docs.values()].find(doc => doc.sourceKey === '101:amendment:1');
  assert.deepEqual(demi.docs.get(OVERRIDE_MARKER_ID).hidden, [{ trackWorkId: 'track-43', sheetWorkId: sheet.id }]);
  assert.equal(store.get(store.all().find(item => item.kind === KINDS.BATCH).id, KINDS.BATCH).status, 'complete');
  assert.deepEqual(demi.derived, [PROJECT]);
});

test('writtenEtag comes from the save response', async (t) => {
  const store = fakeLists(t);
  const { argv } = inputs();
  const demi = fakeDemi();
  await load([...argv, ...liveArgs((await load(argv, demi)).value('planSha256'))], demi);
  const entry = store.all().find(item => item.kind === KINDS.ENTRY && item.target.id === OVERRIDE_MARKER_ID);
  assert.equal(entry.writtenEtag, demi.docs.get(OVERRIDE_MARKER_ID)._etag);
});

test('second live after first prints a plan with written=0', async (t) => {
  fakeLists(t);
  const { argv } = inputs();
  const demi = fakeDemi();
  await load([...argv, ...liveArgs((await load(argv, demi)).value('planSha256'))], demi);
  const second = await load([...argv, ...liveArgs((await load(argv, demi)).value('planSha256'))], demi);
  assert.equal(second.value('written'), '0');
});

test('patchDerived uses WORKS_READ_SOURCES through deriveInputs', async (t) => {
  let inputsFor = null;
  t.mock.method(projects, 'patchDerived', async (_id, options) => { inputsFor = options.inputsFor; return { status: 'unchanged' }; });
  await liveDemi().patchDerived(PROJECT);
  assert.equal(inputsFor, deriveInputs);
});
