'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, readFolder } = require('../../scripts/works-import/extract');
const {
  fingerprintOf, openEnvelope, openExtract, sealEnvelope, sign, sha256Hex
} = require('../../src/utils/import-envelope');
const {
  buildWorkbooks, STAFF_VALUES, NEVER_READ_VALUES, PROJECT_NAMES, REAL_IDS
} = require('../fixtures/works-import/build-workbooks');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'works-extract-'));
const sheetsDir = path.join(tmp, 'sheets');
const throwaway = (length = 40) => crypto.randomBytes(length).toString('hex').slice(0, length);
const secrets = { surrogate: throwaway(), operator: throwaway(), short: throwaway(19), other: throwaway() };
let n = 0;
const fresh = (name) => {
  n += 1;
  const dir = path.join(tmp, `${name}-${n}`);
  fs.mkdirSync(dir);
  return dir;
};

// A stand-in for `secret-tool lookup service <s> account <ref>`: the account is the fifth argument.
function fakeKeyring() {
  const bin = fresh('bin');
  const cases = Object.entries(secrets).map(([ref, value]) => `  ${ref}) printf '%s\\n' '${value}' ;;`).join('\n');
  const script = `#!/bin/sh\ncase "$5" in\n${cases}\n  *) exit 1 ;;\nesac\n`;
  for (const name of ['secret-tool', 'security']) fs.writeFileSync(path.join(bin, name), script, { mode: 0o700 });
  return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}
const env = fakeKeyring();

function devboxKeys() {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ed = crypto.generateKeyPairSync('ed25519');
  const pemFile = path.join(fresh('devbox'), 'devbox.pub.pem');
  fs.writeFileSync(pemFile, [rsa.publicKey, ed.publicKey].map(k => k.export({ type: 'spki', format: 'pem' })).join(''));
  return { rsa, ed, pemFile, fingerprint: fingerprintOf({ rsa: rsa.publicKey, ed25519: ed.publicKey }) };
}
const devbox = devboxKeys();

async function cli(argv) {
  const lines = [];
  await run(argv, { env, write: line => lines.push(line) });
  return lines;
}

async function extractTo(args, keys = devbox) {
  const out = path.join(fresh('out'), 'extract.json');
  const lines = await cli(['extract', '--in', sheetsDir, '--recipient-key', keys.pemFile,
    '--expect-fingerprint', keys.fingerprint, '--out', out, ...args]);
  const sealed = fs.readFileSync(out);
  const opened = openExtract(sealed, { env: args[args.indexOf('--env') + 1], keyFingerprint: keys.fingerprint, privateKey: keys.rsa.privateKey });
  return { out, lines, sealed, ...opened };
}

const surrogateArgs = file => ['--surrogates', file, '--surrogate-passphrase-ref', 'surrogate'];

test.before(async () => {
  fs.mkdirSync(sheetsDir);
  await buildWorkbooks(sheetsDir);
});
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('fixture rules: \'045\' reads as 45, \'---\' and \'n/a\' as null, sentinel and end-before-start flagged', async () => {
  const { records, flags, counts } = await readFolder(sheetsDir);
  const first = records.projects.find(r => r.id === 45);
  assert.equal(first.name, PROJECT_NAMES[0], 'cached formula result, not an evaluated formula');
  assert.equal(first.regionEnv, null);
  assert.equal(first.ceaa, null);
  assert.equal(first.intakeDate, '1995-06-30');
  assert.equal(first.status, 'Active');
  assert.deepEqual(first.ref, { file: '01 - Project Business Intelligence Data 4.xlsx', sheet: 'Projects', row: 5 });
  assert.equal(records.projects.find(r => r.id === 7).substantialStartDate, '2004-02-02');
  assert.equal(records.amendments.find(r => r.id === 45 && r.ref.slot === 2).endDate, null);
  assert.deepEqual(records.suspensions.map(r => [r.ref.slot, r.appliedTo, r.endDate]),
    [[1, 'Application Review', null], [2, 'Pre-Application', '1998-04-01']]);
  assert.deepEqual(records.timeline2002.map(r => [r.name, r.decision, r.decisionDate]),
    [[PROJECT_NAMES[2], 'Incomplete/Inactive', null]]);

  const kinds = flags.map(f => `${f.sheet}:${f.row}:${f.slot || 0}:${f.field}:${f.kind}`).sort();
  assert.deepEqual(kinds, [
    'Amendments:5:1:endDate:endBeforeStart',
    'Projects:5:0:intakeDate:sentinel',
    'Projects:6:0:decisionDate:endBeforeStart',
    'Projects:8:0:id:badId',
    'Suspensions:5:1:endDate:nowFormula'
  ]);
  assert.deepEqual(counts, {
    projects: 3, amendments: 3, suspensions: 2, extensions: 1, orderVariations: 2,
    commentPeriods: 2, timeline2002: 1, transitions: 2, transitionsDated: 1
  });
});

test('a block whose band label moved is refused before any row is read', async () => {
  const dir = fresh('moved');
  await buildWorkbooks(dir);
  const ExcelJS = require('exceljs');
  const file = path.join(dir, '03 - Project Suspension Data.xlsx');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  workbook.getWorksheet('Suspensions').getCell('E3').value = 'Suspension 02';
  await workbook.xlsx.writeFile(file);
  await assert.rejects(readFolder(dir), /column E is not "Suspension 01" \/ "No\."/);
});

test('real-folder counts', { skip: !process.env.WORKS_REAL_DIR && 'set WORKS_REAL_DIR on the laptop' }, async () => {
  const { counts } = await readFolder(process.env.WORKS_REAL_DIR);
  assert.deepEqual(counts, {
    projects: 362, amendments: 329, suspensions: 77, extensions: 86, orderVariations: 157,
    commentPeriods: 386, timeline2002: 177, transitions: 8, transitionsDated: 6
  });
});

test('test extract holds no staff column, no investment and no real number without sign-off refs', async () => {
  const plain = await extractTo(['--env', 'test', ...surrogateArgs(path.join(fresh('map'), 'surrogates.json'))]);
  const text = plain.plaintext.toString('utf8');
  assert.equal(plain.staffIncluded, false);
  assert.equal(plain.numbersReal, false);
  for (const value of STAFF_VALUES) assert.equal(text.includes(value), false);
  for (const row of Object.values(plain.extract.records).flat()) {
    assert.equal(['epd', 'lead', 'notes', 'investment'].some(f => f in row), false);
    assert.equal(REAL_IDS.includes(row.id), false);
  }
  assert.equal(plain.extract.records.timeline2002.some(row => 'id' in row), false);

  const kept = await extractTo(['--env', 'test', '--keep-staff-on-test', 'SIGNOFF-1', '--keep-numbers-on-test', 'SIGNOFF-2']);
  assert.deepEqual(kept.signoffRefs, { keepStaff: 'SIGNOFF-1', keepNumbers: 'SIGNOFF-2' });
  assert.equal(kept.extract.records.projects.find(r => r.id === 45).epd, STAFF_VALUES[0]);
});

test('surrogates are stable across two operator keys', async () => {
  const map = path.join(fresh('map'), 'surrogates.json');
  const first = await extractTo(['--env', 'test', ...surrogateArgs(map)]);
  const second = await extractTo(['--env', 'test', ...surrogateArgs(map)], devboxKeys());
  const idsByName = ({ extract }) => Object.fromEntries(extract.records.projects.map(r => [r.name, r.id]));
  assert.deepEqual(idsByName(second), idsByName(first));
  assert.equal(new Set(Object.values(idsByName(first))).size, 3);
});

test('surrogate passphrase is read from the keyring, not a file', async () => {
  const map = path.join(fresh('map'), 'surrogates.json');
  await extractTo(['--env', 'test', ...surrogateArgs(map)]);
  const wrong = ['--env', 'test', '--surrogates', map, '--surrogate-passphrase-ref'];
  await assert.rejects(extractTo([...wrong, 'other']), /surrogate map .* could not be opened/);

  const fileRef = path.join(fresh('ref'), 'passphrase.txt');
  fs.writeFileSync(fileRef, secrets.surrogate);
  await assert.rejects(extractTo([...wrong, fileRef]), /no keyring entry/);
  await assert.rejects(extractTo(['--env', 'test', '--surrogates', map, '--surrogate-passphrase-file', fileRef]), /Unknown option/);
});

test('transition read holds no EPD or Notes value', async () => {
  const { plaintext, extract } = await extractTo(['--env', 'prod']);
  for (const value of NEVER_READ_VALUES) assert.equal(plaintext.toString('utf8').includes(value), false);
  assert.deepEqual(extract.records.transitions.map(r => Object.keys(r).sort()), [
    ['date', 'id', 'process', 'ref'], ['date', 'id', 'process', 'ref']
  ]);
});

test('extract writes no plaintext file', async () => {
  const before = fs.readdirSync(sheetsDir).sort();
  const { out, sealed, lines } = await extractTo(['--env', 'prod']);
  assert.deepEqual(fs.readdirSync(path.dirname(out)), ['extract.json']);
  assert.deepEqual(fs.readdirSync(sheetsDir).sort(), before);
  for (const value of [...PROJECT_NAMES, ...STAFF_VALUES]) assert.equal(sealed.includes(String(value)), false);
  assert.match(lines.at(-1), /^plaintextSha256=[0-9a-f]{64}$/);
  assert.equal(lines.some(line => PROJECT_NAMES.some(name => line.includes(name))), false);
});

test('keygen refuses a 19-character passphrase', async () => {
  const dir = fresh('keys');
  await assert.rejects(cli(['keygen', '--env', 'test', '--out-dir', dir, '--passphrase-ref', 'short']), /shorter than 20/);
  assert.deepEqual(fs.readdirSync(dir), []);

  const [line] = await cli(['keygen', '--env', 'test', '--out-dir', dir, '--passphrase-ref', 'operator']);
  const pem = fs.readFileSync(path.join(dir, 'operator-test.key.pem'));
  assert.throws(() => crypto.createPrivateKey(pem));
  assert.equal(line, `fingerprint=${fingerprintOf({ rsa: fs.readFileSync(path.join(dir, 'operator-test.pub.pem'), 'utf8') })}`);
});

async function operator() {
  const dir = fresh('operator');
  await cli(['keygen', '--env', 'test', '--out-dir', dir, '--passphrase-ref', 'operator']);
  const publicKey = fs.readFileSync(path.join(dir, 'operator-test.pub.pem'), 'utf8');
  return { keyFile: path.join(dir, 'operator-test.key.pem'), publicKey, fingerprint: fingerprintOf({ rsa: publicKey }) };
}

function devboxSends(op, body, statement) {
  const file = path.join(fresh('blob'), 'crosswalk.sealed');
  fs.writeFileSync(file, sealEnvelope(Buffer.from(body), {
    purpose: 'crosswalk', env: 'test', keyFingerprint: op.fingerprint, recipientKey: op.publicKey,
    signature: sign(devbox.ed.privateKey, statement)
  }));
  return file;
}

test('open refuses a bad signature or hash', async () => {
  const op = await operator();
  const body = 'row,state\n1,exact\n';
  const sha256 = sha256Hex(body);
  const openArgs = (file, out, expect) => ['open', '--env', 'test', '--purpose', 'crosswalk', '--in', file, '--out', out,
    '--key', op.keyFile, '--passphrase-ref', 'operator', '--devbox-key', devbox.pemFile,
    '--devbox-fingerprint', devbox.fingerprint, '--expect-sha256', expect];

  const good = devboxSends(op, body, { purpose: 'crosswalk', env: 'test', sha256 });
  const out = path.join(fresh('review'), 'crosswalk.csv');
  await assert.rejects(cli(openArgs(good, out, sha256Hex('other'))), /does not match --expect-sha256/);
  const forged = devboxSends(op, body, { purpose: 'report', env: 'test', sha256 });
  await assert.rejects(cli(openArgs(forged, out, sha256)), /devbox signature does not verify/);
  assert.equal(fs.existsSync(out), false);

  assert.deepEqual(await cli(openArgs(good, out, sha256)), [`crosswalkSha256=${sha256}`]);
  assert.equal(fs.readFileSync(out, 'utf8'), body);
});

test('seal prints the manual-match SHA-256', async () => {
  const file = path.join(fresh('manual'), 'manual-match.csv');
  fs.writeFileSync(file, 'sheetId,trackId\n1,2\n');
  const out = path.join(path.dirname(file), 'manual-match.sealed');
  const lines = await cli(['seal', '--env', 'test', '--purpose', 'manual-match', '--in', file, '--out', out,
    '--recipient-key', devbox.pemFile, '--expect-fingerprint', devbox.fingerprint]);
  assert.deepEqual(lines, [`manualMatchSha256=${sha256Hex(fs.readFileSync(file))}`]);
  const opened = openEnvelope(fs.readFileSync(out), {
    purpose: 'manual-match', env: 'test', keyFingerprint: devbox.fingerprint, privateKey: devbox.rsa.privateKey
  });
  assert.equal(opened.plaintext.toString('utf8'), fs.readFileSync(file, 'utf8'));
});
