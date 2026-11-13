'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, readCrosswalk, devboxKeysOf, COLUMNS } = require('../../src/scripts/works-crosswalk');
const { fingerprintOf, sealEnvelope, openEnvelope, sha256Hex, sign } = require('../../src/utils/import-envelope');
const { logger } = require('../../src/utils/logger');

const ENV = 'test';
const signoffRefs = { keepStaff: null, keepNumbers: null };
const pemOf = (key, type) => key.export({ type, format: 'pem' });
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
const ed = crypto.generateKeyPairSync('ed25519');
const operator = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
const devboxPem = pemOf(rsa.privateKey, 'pkcs8') + pemOf(ed.privateKey, 'pkcs8');
const keys = devboxKeysOf(devboxPem);
const operatorFingerprint = fingerprintOf({ rsa: operator.publicKey });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'works-crosswalk-'));
let n = 0;
const fresh = () => fs.mkdtempSync(path.join(tmp, `run-${(n += 1)}-`));

// Made-up projects; the Eagle ids are not real ObjectIds.
const E = { a: 'a'.repeat(24), b: 'b'.repeat(24), c: 'c'.repeat(24), d: 'd'.repeat(24), f: 'f'.repeat(24) };
const trackRow = (id, name, eagleId = null, eagleName = name) =>
  ({ id, eagleId, sourceSystem: 'track', sources: { track: { name }, eagle: eagleId ? { name: eagleName } : null } });
const twin = (eagleId, name, extra = {}) =>
  ({ id: `eagle-${eagleId}`, eagleId, sourceSystem: 'eagle', sources: { track: null, eagle: { name } }, ...extra });
const register = (id, name, row) => ({ ref: { file: 'register.xlsx', sheet: 'Projects', row }, id, name });

const toDevbox = (plaintext, purpose, extra = {}) => sealEnvelope(Buffer.from(plaintext), {
  purpose, env: ENV, keyFingerprint: keys.fingerprint, recipientKey: rsa.publicKey, ...extra
});

/** Writes the sealed inputs, runs the crosswalk, and opens its output as the operator would. */
async function crosswalk({ projects, aliases = [], flags = [], rows, manual = { matches: [], foldPairs: [] }, manualSha }) {
  const dir = fresh();
  const outDir = fresh();
  const file = (name, data) => {
    fs.writeFileSync(path.join(dir, name), data);
    return path.join(dir, name);
  };
  const manualText = typeof manual === 'string' ? manual : JSON.stringify(manual);
  const extract = { schemaVersion: 1, env: ENV, staffIncluded: false, numbersReal: false, signoffRefs,
    records: { projects, amendments: aliases, transitions: [] }, flags };
  const lines = [];
  const code = await run([
    '--env', ENV,
    '--extract', file('extract.sealed.json', toDevbox(JSON.stringify(extract), 'extract',
      { staffIncluded: false, numbersReal: false, signoffRefs })),
    '--manual', file('manual.sealed.json', toDevbox(manualText, 'manual-match')),
    '--expect-manual-sha256', manualSha || sha256Hex(Buffer.from(manualText)),
    '--devbox-key', file('devbox.key.pem', devboxPem),
    '--operator-key', file('operator.pub.pem', pemOf(operator.publicKey, 'spki')),
    '--expect-operator-fingerprint', operatorFingerprint,
    '--out-dir', outDir
  ], { write: line => lines.push(line), listRows: async () => rows });
  const [blob] = fs.readdirSync(outDir);
  const sealed = fs.readFileSync(path.join(outDir, blob));
  const opened = openEnvelope(sealed, { purpose: 'crosswalk', env: ENV, keyFingerprint: operatorFingerprint, privateKey: operator.privateKey });
  const csv = opened.plaintext.toString('utf8');
  const csvRows = csv.split('\r\n').slice(2, -1)
    .map(line => Object.fromEntries([...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m, i) => [COLUMNS[i], m[1].replace(/""/g, '"')])));
  return { code, lines, outDir, blob, sealed, csv, csvRows, opened, stat: (key) => lines.find(l => l.startsWith(`${key}=`)) };
}

const stateOf = (result, sheetId) => result.csvRows.find(r => r.sheetId === String(sheetId)).state;

test('unmatched row exits 1 and the CSV lists it', async () => {
  const result = await crosswalk({
    projects: [register(90101, 'Alpha Mine', 4), register(90102, 'Gamma Quarry', 5)],
    rows: [trackRow('7001', 'Alpha Mine', E.a)]
  });
  assert.equal(result.code, 1);
  assert.equal(stateOf(result, 90101), 'exact');
  assert.deepEqual(result.csvRows.find(r => r.sheetId === '90102'), {
    row: '5', sheetId: '90102', sheetName: 'Gamma Quarry', state: 'unmatched', via: 'eagle', targetId: '',
    trackName: '', eagleName: '', eagleId: '', targetEagleId: ''
  });
  assert.equal(result.stat('unmatched'), 'unmatched=1');
  assert.equal(result.stat('exact'), 'exact=1');
});

test('aliases and names match normalized, on the Track name first, then the Eagle name', async () => {
  const result = await crosswalk({
    projects: [register(90111, 'Old Name', 4), register(90112, 'Hidden  Creek!', 5)],
    aliases: [{ ref: { row: 9, slot: 1 }, id: 90111, name: 'North & South Line' }],
    rows: [trackRow('7011', 'North and South-Line', E.a), trackRow('7012', 'Renamed Creek', E.b), twin(E.b, 'hidden creek')]
  });
  assert.equal(stateOf(result, 90111), 'exact');
  assert.equal(result.csvRows.find(r => r.sheetId === '90112').targetId, '7012');
  assert.equal(result.csvRows.find(r => r.sheetId === '90112').via, 'eagle');
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

test('a fold-pair twin without foldedInto is unfolded and exits 1, matched by hand or by name (526)', async () => {
  const manual = { matches: [{ sheetId: 90301, trackId: '7003' }], foldPairs: [`7003:${E.c}`, `7004:${E.d}`] };
  const projects = [register(90301, 'Typo Nme', 4), register(90302, 'Delta Port', 5)];
  const linked = [trackRow('7003', 'Carbon Gas', E.c), trackRow('7004', 'Delta Port', E.d)];
  const unfolded = await crosswalk({ projects, manual, rows: [...linked, twin(E.c, 'Carbon Gas'), twin(E.d, 'Delta Port')] });
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

test('manual row wins over a fuzzy candidate', async () => {
  const result = await crosswalk({
    projects: [register(90501, 'Fox River', 4)],
    rows: [trackRow('7006', 'Fox River'), trackRow('7007', 'Fox River Expansion')],
    manual: { matches: [{ sheetId: 90501, trackId: '7007' }], foldPairs: [] }
  });
  assert.equal(result.code, 0);
  assert.deepEqual([stateOf(result, 90501), result.csvRows[0].targetId], ['manual', '7007']);
});

test('collision flagged', async () => {
  const result = await crosswalk({
    projects: [register(90601, 'Golf Mine', 4), register(90602, 'Golf Mine Phase 2', 5),
      register(90603, 'Hotel Pit', 6), register(90603, 'Hotel Pit', 7)],
    rows: [trackRow('7008', 'Golf Mine'), trackRow('7009', 'Hotel Pit')],
    manual: { matches: [{ sheetId: 90602, trackId: '7008' }], foldPairs: [] }
  });
  assert.equal(result.code, 1);
  assert.deepEqual(result.csvRows.map(r => r.state), ['collision', 'collision', 'collision', 'collision']);
});

test("= cell written as '=, read back as =", async () => {
  const result = await crosswalk({
    projects: [register(90701, '=India Mill', 4), register(90702, "'Juliet Bay", 5)],
    rows: [trackRow('7010', 'India Mill'), trackRow('7013', 'Juliet Bay')]
  });
  assert.match(result.csv, /"'=India Mill"/);
  const forDevbox = toDevbox(result.opened.plaintext, 'crosswalk', { signature: result.opened.signature });
  const read = readCrosswalk(forDevbox, { env: ENV, keys });
  assert.deepEqual(read.rows.map(r => r.sheetName), ['=India Mill', "'Juliet Bay"]);
  assert.equal(read.sha256, result.stat('crosswalkCsvSha256').split('=')[1]);
});

test('readCrosswalk refuses a CSV whose signature does not verify, and returns only exact and manual rows', async () => {
  const result = await crosswalk({
    projects: [register(90801, 'Kilo Lake', 4), register(90802, 'Lima Hill', 5)],
    rows: [trackRow('7014', 'Kilo Lake')]
  });
  const { plaintext } = result.opened;
  const read = readCrosswalk(toDevbox(plaintext, 'crosswalk', { signature: result.opened.signature }), { env: ENV, keys });
  assert.deepEqual(read.rows.map(r => r.sheetId), ['90801']);

  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  const forged = sign(other, { purpose: 'crosswalk', env: ENV, sha256: sha256Hex(plaintext) });
  assert.throws(() => readCrosswalk(toDevbox(plaintext, 'crosswalk', { signature: forged }), { env: ENV, keys }), /signature does not verify/);
});

test('hostile register cells become badId rows and pollute nothing', async () => {
  const result = await crosswalk({
    projects: [{ ref: { row: 4 }, id: '90901', name: 'Mike Ridge' }, { ref: { row: 5 }, id: { __proto__: null }, name: 'x'.repeat(600) },
      JSON.parse('{"ref":{"row":6},"id":90903,"name":["Mike Ridge"],"__proto__":{"polluted":true}}')],
    flags: [{ file: 'register.xlsx', sheet: 'Projects', row: 7, field: 'id', kind: 'badId' }],
    rows: [trackRow('7015', 'Mike Ridge')]
  });
  assert.equal(result.code, 1);
  assert.deepEqual(result.csvRows.map(r => [r.row, r.state]), [['4', 'badId'], ['5', 'badId'], ['6', 'unmatched'], ['7', 'badId']]);
  assert.equal({}.polluted, undefined);
});

test('no plaintext file on the devbox', async () => {
  const result = await crosswalk({ projects: [register(91001, 'November Flats', 4)], rows: [trackRow('7016', 'November Flats')] });
  assert.deepEqual(fs.readdirSync(result.outDir), [result.blob]);
  assert.match(result.blob, /^[0-9a-f-]{36}\.sealed\.json$/);
  assert.equal(fs.statSync(path.join(result.outDir, result.blob)).mode & 0o777, 0o600);
  assert.ok(!result.sealed.includes('November'));
});

test('stdout, stderr and logger output contain no name or number', async (t) => {
  const said = [];
  for (const level of ['error', 'warn', 'info', 'debug']) t.mock.method(logger, level, (...args) => { said.push(JSON.stringify(args)); });
  t.mock.method(process.stderr, 'write', (chunk) => { said.push(String(chunk)); return true; });
  const secret = ['Oscar Bend', 'Papa Point', '91101', '91102', '7017'];
  const projects = [register(91101, 'Oscar Bend', 4), register(91102, 'Papa Point', 5)];
  const result = await crosswalk({ projects, rows: [trackRow('7017', 'Oscar Bend')] });
  said.push(...result.lines);
  const badManual = { matches: [{ sheetId: 91101, trackId: 'Papa Point 7017' }], foldPairs: [] };
  await assert.rejects(crosswalk({ projects, rows: [], manual: badManual }), (err) => {
    said.push(err.message);
    return /matches\[0\]/.test(err.message);
  });
  await assert.rejects(crosswalk({ projects, rows: [], manual: '{"matches": [Oscar Bend 91101' }), (err) => {
    said.push(err.message);
    return true;
  });
  // Hashes and the blob name are random hex, which can hold any digit run.
  const plain = said.map(line => line.replace(/[0-9a-f]{64}|[0-9a-f-]{36}/g, ''));
  for (const value of secret) assert.ok(!plain.some(line => line.includes(value)), `output names ${value}`);
});
