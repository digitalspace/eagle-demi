'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../../src/config');
const { run, readCrosswalk, COLUMNS } = require('../../src/scripts/works-crosswalk');
const { devboxKeysFromPem, fingerprintOf, sealEnvelope, openEnvelope, sha256Hex, sign } = require('../../src/utils/import-envelope');
const { logger } = require('../../src/utils/logger');

const ENV = 'test';
const SCRIPT = path.join(__dirname, '../../src/scripts/works-crosswalk.js');
const signoffRefs = { keepStaff: null, keepNumbers: null };
const pemOf = (key, type) => key.export({ type, format: 'pem' });
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
const ed = crypto.generateKeyPairSync('ed25519');
const operator = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
const devboxPem = pemOf(rsa.privateKey, 'pkcs8') + pemOf(ed.privateKey, 'pkcs8');
const keys = devboxKeysFromPem(devboxPem);
const operatorFingerprint = fingerprintOf({ rsa: operator.publicKey });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'works-crosswalk-'));
const fresh = () => fs.mkdtempSync(path.join(tmp, 'run-'));
const environmentName = config.environmentName;
config.environmentName = ENV;
test.after(() => {
  config.environmentName = environmentName;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Made-up projects; the Eagle ids are not real ObjectIds.
const E = { a: 'a'.repeat(24), b: 'b'.repeat(24), c: 'c'.repeat(24), d: 'd'.repeat(24), e: 'e'.repeat(24), f: 'f'.repeat(24) };
const trackRow = (id, name, eagleId = null, eagleName = name) =>
  ({ id, eagleId, sourceSystem: 'track', sources: { track: { name }, eagle: eagleId ? { name: eagleName } : null } });
const twin = (eagleId, name, extra = {}) =>
  ({ id: `eagle-${eagleId}`, eagleId, sourceSystem: 'eagle', sources: { track: null, eagle: { name } }, ...extra });
const register = (id, name, row) => ({ ref: { file: 'register.xlsx', sheet: 'Projects', row }, id, name });
const noManual = { matches: [], foldPairs: [] };

const toDevbox = (plaintext, purpose, extra = {}) => sealEnvelope(Buffer.from(plaintext), {
  purpose, env: ENV, keyFingerprint: keys.fingerprint, recipientKey: rsa.publicKey, ...extra
});

/** Writes the sealed inputs and returns the argv a run takes; `edit(files)` may swap a file before the argv is built. */
function inputs({ projects, aliases = [], flags = [], manual = noManual, manualSha, extractSha, operatorPrint, edit }) {
  const dir = fresh();
  const outDir = fresh();
  const file = (name, data) => {
    fs.writeFileSync(path.join(dir, name), data);
    return path.join(dir, name);
  };
  const manualText = typeof manual === 'string' ? manual : JSON.stringify(manual);
  const extractText = JSON.stringify({ schemaVersion: 1, env: ENV, staffIncluded: false, numbersReal: false, signoffRefs,
    records: { projects, amendments: aliases, transitions: [] }, flags });
  const files = {
    extract: file('extract.sealed.json', toDevbox(extractText, 'extract', { staffIncluded: false, numbersReal: false, signoffRefs })),
    manual: file('manual.sealed.json', toDevbox(manualText, 'manual-match')),
    devboxKey: file('devbox.key.pem', devboxPem),
    operatorKey: file('operator.pub.pem', pemOf(operator.publicKey, 'spki'))
  };
  if (edit) edit(files, dir);
  const argv = ['--env', ENV, '--extract', files.extract, '--expect-extract-sha256', extractSha || sha256Hex(Buffer.from(extractText)),
    '--manual', files.manual, '--expect-manual-sha256', manualSha || sha256Hex(Buffer.from(manualText)),
    '--devbox-key', files.devboxKey, '--operator-key', files.operatorKey,
    '--expect-operator-fingerprint', operatorPrint || operatorFingerprint, '--out-dir', outDir];
  return { argv, outDir, extractSha256: sha256Hex(Buffer.from(extractText)), manualSha256: sha256Hex(Buffer.from(manualText)) };
}

/** Runs the crosswalk over `opts` and opens its output as the operator would. */
async function crosswalk({ rows, ...opts }) {
  const { argv, outDir, ...hashes } = inputs(opts);
  const lines = [];
  const code = await run(argv, { write: line => lines.push(line), listRows: async () => rows });
  const [blob] = fs.readdirSync(outDir);
  const opened = openEnvelope(fs.readFileSync(path.join(outDir, blob)),
    { purpose: 'crosswalk', env: ENV, keyFingerprint: operatorFingerprint, privateKey: operator.privateKey });
  const csv = opened.plaintext.toString('utf8');
  const csvRows = csv.split('\r\n').slice(2, -1)
    .map(line => Object.fromEntries([...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m, i) => [COLUMNS[i], m[1].replace(/""/g, '"')])));
  return { code, lines, outDir, blob, csv, csvRows, opened, ...hashes, stat: key => lines.find(l => l.startsWith(`${key}=`)) };
}

const rowOf = (result, sheetId) => result.csvRows.find(r => r.sheetId === String(sheetId));
const stateOf = (result, sheetId) => rowOf(result, sheetId).state;
const forDevbox = result => toDevbox(result.opened.plaintext, 'crosswalk', { signature: result.opened.signature });

test('unmatched row exits 1 and the CSV lists it', async () => {
  const result = await crosswalk({
    projects: [register(90101, 'Alpha Mine', 4), register(90102, 'Gamma Quarry', 5)],
    rows: [trackRow('7001', 'Alpha Mine', E.a)]
  });
  assert.equal(result.code, 1);
  assert.equal(stateOf(result, 90101), 'exact');
  assert.deepEqual(rowOf(result, 90102), {
    row: '5', sheetId: '90102', sheetName: 'Gamma Quarry', state: 'unmatched', via: 'eagle', targetId: '',
    trackName: '', eagleName: '', eagleId: '', targetEagleId: ''
  });
  assert.equal(result.stat('unmatched'), 'unmatched=1');
  assert.equal(result.stat('exact'), 'exact=1');
});

test('aliases and names match normalized, on the Track name first, then the Eagle name', async () => {
  const result = await crosswalk({
    projects: [register(90111, 'Old Name', 4), register(90112, 'Hidden  Creek!', 5), register(90113, 'Quebec Cove', 6)],
    aliases: [{ ref: { row: 9, slot: 1 }, id: 90111, name: 'North & South Line' }],
    rows: [trackRow('7011', 'North and South-Line', E.a), trackRow('7012', 'Renamed Creek', E.b), twin(E.b, 'hidden creek'),
      trackRow('7018', 'Quebec Cove', E.e, 'Cove Other'), trackRow('7019', 'Romeo Cove', E.f, 'Quebec Cove')]
  });
  assert.equal(stateOf(result, 90111), 'exact');
  assert.deepEqual([rowOf(result, 90112).targetId, rowOf(result, 90112).via], ['7012', 'eagle']);
  assert.deepEqual([rowOf(result, 90113).targetId, rowOf(result, 90113).via], ['7018', 'track']);
});

test('an Eagle-name match reaches its Track row through the fold pair; two candidates in one tier are ambiguous', async () => {
  const result = await crosswalk({
    projects: [register(90121, 'Sierra Falls', 4), register(90122, 'Tango Ridge', 5)],
    rows: [trackRow('7020', 'Sierra Track Name'), twin(E.c, 'Sierra Falls'), trackRow('7021', 'Tango Ridge'), trackRow('7022', 'Tango-Ridge')],
    manual: { matches: [], foldPairs: [`7020:${E.c}`] }
  });
  assert.deepEqual([rowOf(result, 90121).targetId, rowOf(result, 90121).eagleId, stateOf(result, 90121)], ['7020', E.c, 'unlinked']);
  assert.equal(stateOf(result, 90122), 'ambiguous');
});

test("a target without the crosswalk's Eagle id is unlinked and exits 1", async () => {
  const result = await crosswalk({
    projects: [register(90201, 'Beta Wind', 4)],
    rows: [trackRow('7002', 'Beta Wind', null)],
    manual: { matches: [], foldPairs: [`7002:${E.b}`] }
  });
  assert.equal(result.code, 1);
  assert.equal(stateOf(result, 90201), 'unlinked');
  assert.equal(result.stat('unlinked'), 'unlinked=1');
});

test('a fold-pair twin not folded into its Track row is unfolded and exits 1, matched by hand or by name (526)', async () => {
  const manual = { matches: [{ sheetId: 90301, trackId: '7003' }], foldPairs: [`7003:${E.c}`, `7004:${E.d}`] };
  const projects = [register(90301, 'Typo Nme', 4), register(90302, 'Delta Port', 5)];
  const linked = [trackRow('7003', 'Carbon Gas', E.c), trackRow('7004', 'Delta Port', E.d)];
  const unfolded = await crosswalk({ projects, manual,
    rows: [...linked, twin(E.c, 'Carbon Gas'), twin(E.d, 'Delta Port', { foldedInto: '7003' })] });
  assert.equal(unfolded.code, 1);
  assert.deepEqual([stateOf(unfolded, 90301), stateOf(unfolded, 90302)], ['unfolded', 'unfolded']);

  const folded = await crosswalk({ projects, manual, rows: [...linked,
    twin(E.c, 'Carbon Gas', { foldedInto: '7003' }), twin(E.d, 'Delta Port', { foldedInto: '7004' })] });
  assert.equal(folded.code, 0);
  assert.deepEqual([stateOf(folded, 90301), stateOf(folded, 90302)], ['manual', 'exact']);
});

test('a DEMI-owned twin is unfolded and exits 1; a disowned relinked twin is not', async () => {
  const projects = [register(90401, 'Echo Dam', 4)];
  const owned = await crosswalk({ projects, rows: [trackRow('7005', 'Echo Dam', E.f), twin(E.f, 'Echo Dam', { demiOwnedAt: '2026-01-01' })] });
  assert.equal(owned.code, 1);
  assert.equal(stateOf(owned, 90401), 'unfolded');
  assert.equal(owned.stat('twinsBeside'), 'twinsBeside=0');

  const disowned = await crosswalk({ projects, rows: [trackRow('7005', 'Echo Dam', E.f), twin(E.f, 'Echo Dam')] });
  assert.equal(disowned.code, 0);
  assert.equal(stateOf(disowned, 90401), 'exact');
  assert.equal(disowned.stat('twinsBeside'), 'twinsBeside=1');
});

test('a manual file with another SHA-256 is refused', async () => {
  await assert.rejects(crosswalk({ projects: [], rows: [], manualSha: 'f'.repeat(64) }), /manual-match SHA-256 does not match/);
});

test('an extract with another SHA-256 is refused; the CSV header carries the extract and manual hashes', async () => {
  const projects = [register(90131, 'Uniform Bay', 4)];
  await assert.rejects(crosswalk({ projects, rows: [], extractSha: 'e'.repeat(64) }), /extract SHA-256 does not match/);
  const result = await crosswalk({ projects, rows: [trackRow('7023', 'Uniform Bay')] });
  assert.equal(result.csv.split('\r\n')[0], `"extractSha256","${result.extractSha256}","manualSha256","${result.manualSha256}"`);
  const read = readCrosswalk(forDevbox(result), { env: ENV, keys });
  assert.deepEqual([read.extractSha256, read.manualSha256], [result.extractSha256, result.manualSha256]);
});

test('on test the manual file is keyed by surrogate; a real register number is refused without naming it', async () => {
  const projects = [register(31337, 'Victor Flats', 4)];
  const rows = [trackRow('7024', 'Victor Flats'), trackRow('7025', 'Victor Flats Expansion')];
  await assert.rejects(crosswalk({ projects, rows, manual: { matches: [{ sheetId: 90501, trackId: '7025' }], foldPairs: [] } }), (err) => {
    assert.match(err.message, /^manual-match matches\[0\] names a sheet id the register does not hold; .*surrogate/);
    assert.ok(!/90501|31337|7025/.test(err.message));
    return true;
  });
  const keyed = await crosswalk({ projects, rows, manual: { matches: [{ sheetId: 31337, trackId: '7025' }], foldPairs: [] } });
  assert.deepEqual([stateOf(keyed, 31337), rowOf(keyed, 31337).targetId], ['manual', '7025']);
});

test('collision flagged', async () => {
  const result = await crosswalk({
    projects: [register(90601, 'Golf Mine', 4), register(90602, 'Golf Mine Phase 2', 5),
      register(90603, 'Hotel Pit', 6), register(90603, 'Hotel Pit', 7)],
    rows: [trackRow('7008', 'Golf Mine', E.a), twin(E.a, 'Golf Mine'), trackRow('7009', 'Hotel Pit')],
    manual: { matches: [{ sheetId: 90602, trackId: '7008' }], foldPairs: [] }
  });
  assert.equal(result.code, 1);
  assert.deepEqual(result.csvRows.map(r => r.state), ['collision', 'collision', 'collision', 'collision']);
  assert.equal(result.stat('twinsBeside'), 'twinsBeside=0');
});

test("= cell written as '=, read back as =", async () => {
  const result = await crosswalk({
    projects: [register(90701, '=India Mill', 4), register(90702, "'Juliet Bay", 5), register(90703, '@Lima\u202eWeir', 6)],
    rows: [trackRow('7010', 'India Mill'), trackRow('7013', 'Juliet Bay'), trackRow('7026', 'Lima Weir')]
  });
  assert.match(result.csv, /"'=India Mill"/);
  assert.match(result.csv, /"'@Lima Weir"/);
  const read = readCrosswalk(forDevbox(result), { env: ENV, keys });
  assert.deepEqual(read.rows.map(r => r.sheetName), ['=India Mill', "'Juliet Bay", '@Lima Weir']);
  assert.equal(read.sha256, result.stat('crosswalkCsvSha256').split('=')[1]);
});

test('readCrosswalk refuses a CSV whose signature does not verify, and returns only exact and manual rows', async () => {
  const result = await crosswalk({
    projects: [register(90801, 'Kilo Lake', 4), register(90802, 'Lima Hill', 5)],
    rows: [trackRow('7014', 'Kilo Lake')]
  });
  assert.deepEqual(readCrosswalk(forDevbox(result), { env: ENV, keys }).rows.map(r => r.sheetId), ['90801']);

  const { plaintext } = result.opened;
  const forged = sign(crypto.generateKeyPairSync('ed25519').privateKey, { purpose: 'crosswalk', env: ENV, sha256: sha256Hex(plaintext) });
  assert.throws(() => readCrosswalk(toDevbox(plaintext, 'crosswalk', { signature: forged }), { env: ENV, keys }), /signature does not verify/);

  const trailing = Buffer.from(plaintext.toString('utf8').replace(/\r\n$/, ',\r\n'));
  const signed = sign(ed.privateKey, { purpose: 'crosswalk', env: ENV, sha256: sha256Hex(trailing) });
  assert.throws(() => readCrosswalk(toDevbox(trailing, 'crosswalk', { signature: signed }), { env: ENV, keys }), /CSV is malformed/);
});

test('hostile or dropped register rows stop the run; an empty register or pool is refused', async () => {
  const result = await crosswalk({
    projects: [{ ref: { file: 'register.xlsx', row: 4 }, id: '90901', name: 'Mike Ridge' },
      { ref: { file: 'register.xlsx', row: 5 }, id: '__proto__', name: 'x'.repeat(600) },
      JSON.parse('{"ref":{"file":"register.xlsx","row":6},"id":90903,"name":["Mike Ridge"],"__proto__":{"id":90904}}')],
    flags: [{ file: 'register.xlsx', sheet: 'Projects', row: 7, field: 'id', kind: 'badId' },
      { file: 'register.xlsx', sheet: 'Projects', row: 8, field: 'name', kind: 'unnamedRow' },
      { file: 'amendments.xlsx', sheet: 'Projects', row: 9, field: 'id', kind: 'badId' }],
    rows: [trackRow('7015', 'Mike Ridge')]
  });
  assert.equal(result.code, 1);
  assert.deepEqual(result.csvRows.map(r => [r.row, r.sheetId, r.state]),
    [['4', '', 'badId'], ['5', '', 'badId'], ['6', '90903', 'unmatched'], ['7', '', 'badId'], ['8', '', 'unnamedRow']]);

  const manual = JSON.parse('{"matches":[{"sheetId":90903,"trackId":"7015","__proto__":{}}],"foldPairs":[]}');
  await assert.rejects(crosswalk({ projects: [register(90903, 'Mike Ridge', 4)], rows: [], manual }), /matches\[0\] is not a unique/);
  await assert.rejects(crosswalk({ projects: [], rows: [trackRow('7015', 'Mike Ridge')] }), /extract holds no register rows/);
  await assert.rejects(crosswalk({ projects: [register(90903, 'Mike Ridge', 4)], rows: [] }), /no live Track project rows/);
});

test('key, fingerprint, file and manual-shape guards refuse', async () => {
  const projects = [register(91201, 'Oscar Inlet', 4)];
  const rows = [trackRow('7027', 'Oscar Inlet')];
  await assert.rejects(crosswalk({ projects, rows, operatorPrint: 'a'.repeat(64) }), /fingerprint of operator key does not match/);
  await assert.rejects(crosswalk({ projects, rows, edit: (files, dir) => {
    files.manual = path.join(dir, 'link.sealed.json');
    fs.symlinkSync(path.join(dir, 'manual.sealed.json'), files.manual);
  } }), /is a symbolic link/);
  await assert.rejects(crosswalk({ projects, rows, edit: files => fs.appendFileSync(files.operatorKey, Buffer.alloc(64 * 1024)) }),
    /is over 65536 bytes/);
  await assert.rejects(crosswalk({ projects, rows, manual: { ...noManual, extra: [] } }), /must hold only matches and foldPairs/);
  await assert.rejects(crosswalk({ projects, rows, manual: { matches: [], foldPairs: ['7027:not-an-eagle-id'] } }), /foldPairs\[0\]/);

  const second = pemOf(crypto.generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey, 'pkcs8');
  const small = pemOf(crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey, 'pkcs8');
  assert.throws(() => devboxKeysFromPem(devboxPem + second), /unexpected rsa key/);
  assert.throws(() => devboxKeysFromPem(pemOf(rsa.privateKey, 'pkcs8')), /one RSA and one Ed25519/);
  assert.throws(() => devboxKeysFromPem(small + pemOf(ed.privateKey, 'pkcs8')), /under 3072 bits/);
});

test('--env must match the ENVIRONMENT the rows are read from', async (t) => {
  config.environmentName = 'prod';
  t.after(() => { config.environmentName = ENV; });
  await assert.rejects(crosswalk({ projects: [register(91301, 'Papa Lake', 4)], rows: [] }), /--env test does not match ENVIRONMENT prod/);
});

test('no plaintext file on the devbox', async () => {
  const result = await crosswalk({ projects: [register(91001, 'November Flats', 4)], rows: [trackRow('7016', 'November Flats')] });
  assert.deepEqual(fs.readdirSync(result.outDir), [result.blob]);
  assert.match(result.blob, /^[0-9a-f-]{36}\.sealed\.json$/);
  assert.equal(fs.statSync(path.join(result.outDir, result.blob)).mode & 0o777, 0o600);
});

const secret = ['Oscar Bend', 'Papa Point', '91101', '91102', '7017'];
// Hashes and the blob name are random hex, which can hold any digit run.
const named = lines => lines.map(line => line.replace(/[0-9a-f]{64}|[0-9a-f-]{36}/g, ''))
  .flatMap(line => secret.filter(value => line.includes(value)));

test('stdout, stderr and logger output contain no name or number', async (t) => {
  const said = [];
  for (const level of ['error', 'warn', 'info', 'debug']) t.mock.method(logger, level, (...args) => { said.push(JSON.stringify(args)); });
  t.mock.method(process.stderr, 'write', (chunk) => { said.push(String(chunk)); return true; });
  const projects = [register(91101, 'Oscar Bend', 4), register(91102, 'Papa Point', 5)];
  const result = await crosswalk({ projects, rows: [trackRow('7017', 'Oscar Bend')] });
  said.push(...result.lines);
  const badManual = { matches: [{ sheetId: 91101, trackId: 'Papa Point 7017' }], foldPairs: [] };
  await assert.rejects(crosswalk({ projects, rows: [], manual: badManual }), (err) => {
    said.push(err.message);
    return /matches\[0\]/.test(err.message);
  });
  assert.deepEqual(named(said), []);
});

test('the command line logs only the fixed failure line when a run fails', () => {
  const projects = [register(91101, 'Oscar Bend', 4)];
  const { argv } = inputs({ projects, manual: '{"matches": [Oscar Bend 91101 7017' });
  const preload = path.join(fresh(), 'environment.js');
  fs.writeFileSync(preload, `require(${JSON.stringify(require.resolve('../../src/config'))}).environmentName = 'test';\n`);
  const child = spawnSync(process.execPath, ['-r', preload, SCRIPT, ...argv], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
  const output = `${child.stdout}${child.stderr}`;
  assert.equal(child.status, 1);
  assert.match(output, /\[works-crosswalk\] failed\nError: manual-match file is not JSON\n/);
  assert.deepEqual(named([output]), []);
});
