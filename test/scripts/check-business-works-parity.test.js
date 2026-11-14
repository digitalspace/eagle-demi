'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { spawnSync } = require('child_process');
const { run } = require('../../src/scripts/check-business-works-parity');
const { COLUMNS } = require('../../src/scripts/works-crosswalk');
const projectsRepository = require('../../src/repositories/projects');
const worksRepository = require('../../src/repositories/works');
const commentPeriodsRepository = require('../../src/repositories/comment-periods');
const listsRepository = require('../../src/repositories/lists');
const phaseCatalog = require('../../src/domain/phase-catalog');
const { fingerprintOf, openEnvelope, sealEnvelope, sha256Hex, sign, verify } = require('../../src/utils/import-envelope');
const { CATALOG, PHASES, PROJECT, AT, amendment, extractOf, settledAmendment, loaded, stateOf } = require('../helpers/business-works-fixtures');

const ENV = 'test';
const TEST_ENDPOINT = 'https://demi-cosmos-test.documents.azure.com:443/';
const MANUAL_SHA = 'a'.repeat(64);
const INPUTS = ['crosswalk', 'devbox-key', 'extract', 'operator-key'];
const LATER_YEARS = Object.fromEntries([2018, 2025].map(year => [year, [{ name: 'Made-up', catalogId: `${year}:Made-up` }]]));

// Keys made for this run only.
const pemOf = (key, type) => key.export({ type, format: 'pem' });
const devboxRsa = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
const devboxEd = crypto.generateKeyPairSync('ed25519');
const operator = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
const DEVBOX_FP = fingerprintOf({ rsa: devboxRsa.publicKey, ed25519: devboxEd.publicKey });
const OPERATOR_FP = fingerprintOf({ rsa: operator.publicKey });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'business-works-parity-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

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

async function check(extract, state, { endpoint = TEST_ENDPOINT, expectExtractSha, operatorFp = OPERATOR_FP, argvOf = argv => argv } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'run-'));
  const files = inputFiles(extract, dir);
  const argv = argvOf(['--extract', files.path('extract'), '--expect-extract-sha256', expectExtractSha || files.extractSha,
    '--crosswalk', files.path('crosswalk'), '--expect-manual-sha256', MANUAL_SHA, '--devbox-key', files.path('devbox-key'),
    '--operator-key', files.path('operator-key'), '--expect-operator-fingerprint', operatorFp, '--out-dir', dir], dir);
  const lines = [];
  const seam = { write: line => lines.push(line), now: new Date(AT) };
  if (state) Object.assign(seam, { endpoint, state: typeof state === 'function' ? state : async () => state });
  const code = await run(argv, seam);
  const value = (name) => lines.find(line => line.startsWith(`${name}=`)).slice(name.length + 1);
  const opened = openEnvelope(fs.readFileSync(path.join(dir, value('blob'))), {
    purpose: 'works-parity', env: ENV, keyFingerprint: OPERATOR_FP, privateKey: operator.privateKey
  });
  return { code, lines, opened, value, dir, files, report: JSON.parse(opened.plaintext.toString('utf8')), count: (name) => Number(value(name)) };
}

const extract = extractOf(amendment('1', '2010-01-01', '2010-03-01'));

test('exits 0 on a matching fixture', async () => {
  assert.strictEqual((await check(extract, stateOf(loaded(extract)))).code, 0);
});

// [case, stored state]
const failingRows = [
  ['a changed date', () => {
    const state = loaded(extract);
    return stateOf({ ...state, works: state.works.map(work => (work.workTypeCode === 'amendment' ? { ...work, decisionDate: '2010-04-01' } : work)) });
  }],
  ['a duplicate external id', () => stateOf(loaded(extract), {
    rows: new Map([[PROJECT, { id: PROJECT, externalIds: [{ system: 'track', value: '7' }] }],
      ['project-beta', { id: 'project-beta', externalIds: [{ system: 'track', value: '7' }] }]])
  })],
  ['a duplicate sourceKey', () => {
    const state = loaded(extract);
    return stateOf({ ...state, works: [...state.works, { ...state.works.find(work => work.workTypeCode === 'amendment'), id: 'sheet-twin' }] });
  }]
];
for (const [label, build] of failingRows) {
  test(`exits 1 on ${label}`, async () => {
    assert.strictEqual((await check(extract, build())).code, 1);
  });
}

test('stdout holds counts and the report hash only; the sealed report holds kind, extract hash and time, signed by the devbox', async () => {
  const result = await check(extract, stateOf(loaded(extract), { track: [settledAmendment] }));
  assert.strictEqual(result.lines.filter(line => line.includes('amendment') || line.includes(PROJECT)).length, 0);
  assert.deepStrictEqual([result.report.kind, result.report.extractSha256, result.report.at], ['works-parity', result.files.extractSha, AT]);
  assert.strictEqual(sha256Hex(result.opened.plaintext), result.value('reportSha256'));
  assert.strictEqual(verify(devboxEd.publicKey, { purpose: 'works-parity', env: ENV, sha256: result.value('reportSha256') }, result.opened.signature), true);
});

test('extract.js open --purpose works-parity reads the sealed report back', async () => {
  const { cli, secrets } = require('../fixtures/works-import/harness');
  const result = await check(extract, stateOf(loaded(extract)));
  const key = path.join(result.dir, 'operator.key.pem');
  fs.writeFileSync(key, operator.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: secrets.operator }));
  const devboxPub = path.join(result.dir, 'devbox.pub.pem');
  fs.writeFileSync(devboxPub, pemOf(devboxRsa.publicKey, 'spki') + pemOf(devboxEd.publicKey, 'spki'));
  const out = path.join(result.dir, 'report.json');
  const lines = await cli(['open', '--env', ENV, '--purpose', 'works-parity', '--in', path.join(result.dir, result.value('blob')), '--out', out,
    '--key', key, '--passphrase-ref', 'operator', '--devbox-key', devboxPub, '--devbox-fingerprint', DEVBOX_FP, '--expect-sha256', result.value('reportSha256')]);
  assert.deepStrictEqual([lines, JSON.parse(fs.readFileSync(out, 'utf8')).kind], [[`worksParitySha256=${result.value('reportSha256')}`], 'works-parity']);
});

test('--out-dir holds only the inputs and one sealed blob afterwards', async () => {
  const result = await check(extract, stateOf(loaded(extract)));
  assert.deepStrictEqual(fs.readdirSync(result.dir).sort(), [...INPUTS, result.value('blob')].sort());
});

test('a wrong --expect-extract-sha256 refuses before the store is read', async () => {
  let read = false;
  await assert.rejects(check(extract, async () => { read = true; }, { expectExtractSha: 'b'.repeat(64) }),
    { message: 'extract SHA-256 does not match the expected value' });
  assert.strictEqual(read, false);
});

test('refuses an operator key whose fingerprint is not the expected one', async () => {
  await assert.rejects(check(extract, stateOf(loaded(extract)), { operatorFp: 'c'.repeat(64) }), { message: 'fingerprint of operator key does not match', refused: true });
});

test('refuses a test endpoint with no test state', async () => {
  await assert.rejects(run([], { endpoint: TEST_ENDPOINT }), { message: 'a test endpoint needs a test state' });
});

for (const endpoint of ['', 'https://demi-cosmos-prod.documents.azure.com:443/', 'https://demi-cosmos-test.documents.azure.com.evil.net/',
  'https://evil-demi-cosmos-test.documents.azure.com/', 'https://demi-cosmos-test.documents.azure.com@evil.net/']) {
  test(`refuses COSMOS_ENDPOINT ${endpoint || '(unset)'}`, async () => {
    await assert.rejects(check(extract, stateOf(loaded(extract)), { endpoint }), { message: 'COSMOS_ENDPOINT must name demi-cosmos-test' });
  });
}

// [case, argv edit, message]
const optionRows = [
  ['a missing option', argv => argv.slice(0, -2), /^missing --out-dir$/],
  ['an unknown option', argv => [...argv, '--keep', 'x'], /^options are /],
  ['an option given twice', argv => [...argv, '--extract', argv[1]], /^--extract given more than once$/],
  ['an --out-dir that is a file', (argv, dir) => [...argv.slice(0, -2), '--out-dir', path.join(dir, 'extract')], /^--out-dir must be a directory$/]
];
for (const [label, argvOf, message] of optionRows) {
  test(`refuses ${label}`, async () => {
    await assert.rejects(check(extract, stateOf(loaded(extract)), { argvOf }), { message });
  });
}

/** The live state read through stubbed repositories, with COSMOS_ENDPOINT on the test account. */
function stubRepositories(t, { marker, phases = { ...PHASES, ...LATER_YEARS } }) {
  const state = loaded(extract);
  const endpoint = process.env.COSMOS_ENDPOINT;
  process.env.COSMOS_ENDPOINT = TEST_ENDPOINT;
  t.after(() => { process.env.COSMOS_ENDPOINT = endpoint; });
  t.mock.method(projectsRepository, 'listVisible', async () => ({ items: [{ id: PROJECT }] }));
  t.mock.method(worksRepository, 'listByProject', async () => state.works);
  t.mock.method(worksRepository, 'get', async () => marker(state.markers.get(PROJECT)));
  t.mock.method(worksRepository, 'liveProjectIds', async ({ owner } = {}) => (owner === 'sheet' ? [PROJECT, 'project-beta'] : []));
  t.mock.method(commentPeriodsRepository, 'listEveryByProject', async () => []);
  t.mock.method(listsRepository, 'readWorksCatalog', async () => CATALOG);
  t.mock.method(phaseCatalog, 'load', async () => phases);
}

// [case, the stored marker, markerMissing]
const liveRows = [['a live marker', marker => marker, 0], ['a deleted marker', marker => ({ ...marker, deleted: true }), 1]];
for (const [label, marker, missing] of liveRows) {
  test(`liveState reads works, markers and catalogs through the repositories: markerMissing=${missing} for ${label}`, async (t) => {
    stubRepositories(t, { marker });
    const result = await check(extract);
    assert.deepStrictEqual([result.count('works') > 0, result.count('markerMissing'), result.count('sheetOutsideCrosswalk')], [true, missing, 1]);
  });
}

test('liveState refuses a phase catalog with a year that holds no entries', async (t) => {
  stubRepositories(t, { marker: one => one, phases: { ...PHASES, 2025: LATER_YEARS[2025] } });
  await assert.rejects(check(extract), { message: /^phase catalog has no entries for 2018$/ });
});

// [case, COSMOS_ENDPOINT, exit code]
const exitRows = [['a refusal', null, 2], ['an input file it cannot read', TEST_ENDPOINT, 1]];
for (const [label, endpoint, status] of exitRows) {
  test(`the script exits ${status} on ${label}`, () => {
    const env = { ...process.env, NODE_ENV: 'test' };
    delete env.COSMOS_ENDPOINT;
    if (endpoint) env.COSMOS_ENDPOINT = endpoint;
    const absent = path.join(TMP, 'absent');
    const argv = ['extract', 'expect-extract-sha256', 'crosswalk', 'expect-manual-sha256', 'devbox-key', 'operator-key', 'expect-operator-fingerprint']
      .flatMap(name => [`--${name}`, absent]).concat(['--out-dir', TMP]);
    const result = spawnSync(process.execPath, [path.join(__dirname, '../../src/scripts/check-business-works-parity.js'), ...argv], { env, encoding: 'utf8' });
    assert.strictEqual(result.status, status);
  });
}
