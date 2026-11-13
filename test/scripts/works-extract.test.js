'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ExcelJS = require('exceljs');
const { readFolder, readInput } = require('../../scripts/works-import/cells');
const { fingerprintOf, openEnvelope, sealEnvelope, sign, sha256Hex } = require('../../src/utils/import-envelope');
const {
  buildWorkbooks, STAFF_VALUES, NEVER_READ_VALUES, PROJECT_NAMES, REAL_IDS
} = require('../fixtures/works-import/build-workbooks');
const {
  EXTRACT, tmp, sheetsDir, secrets, fresh, copyOfSheets, modeOf, devboxKeys, devbox, cli, extractTo, newMap, surrogateArgs
} = require('../fixtures/works-import/harness');

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
  const second = records.projects.find(r => r.id === 7);
  assert.equal(second.name, PROJECT_NAMES[1], 'rich text joined');
  assert.equal(second.substantialStartDate, '2004-02-02');
  assert.equal(second.expiryDate, '2026-12-01', 'a longer volatile formula keeps its cached value');
  const third = records.projects.find(r => r.id === 120);
  assert.deepEqual([third.proponent, third.subsector, third.decisionDate], [null, null, null]);
  assert.equal(records.amendments.find(r => r.id === 45 && r.ref.slot === 2).endDate, null);
  assert.deepEqual(records.suspensions.map(r => [r.ref.slot, r.appliedTo, r.endDate]),
    [[1, 'Application Review', null], [2, 'Pre-Application', '1998-04-01']]);
  assert.deepEqual(records.timeline2002.map(r => [r.name, r.decision, r.decisionDate]),
    [[PROJECT_NAMES[2], 'Incomplete/Inactive', null]]);

  const kinds = flags.map(f => `${f.sheet}:${f.row}:${f.slot || 0}:${f.field}:${f.kind}`).sort();
  assert.deepEqual(kinds, [
    'Amendments:5:1:endDate:endBeforeStart',
    'Amendments:7:0:name:unnamedRow',
    'Projects:10:0:id:duplicateId',
    'Projects:11:0:id:badId',
    'Projects:5:0:intakeDate:sentinel',
    'Projects:6:0:decisionDate:endBeforeStart',
    'Projects:6:0:expiryDate:volatileFormula',
    'Projects:7:0:airAccepted:badDate',
    'Projects:7:0:decisionDate:badDate',
    'Projects:7:0:draftAir:badDate',
    'Projects:7:0:proponent:errorCell',
    'Projects:7:0:subsector:errorCell',
    'Projects:8:0:id:badId',
    'Projects:9:0:name:unnamedRow',
    'Suspensions:5:1:endDate:nowFormula'
  ]);
  assert.deepEqual(counts, {
    projects: 3, amendments: 3, suspensions: 2, extensions: 1, orderVariations: 2,
    commentPeriods: 2, timeline2002: 1, transitions: 2, transitionsDated: 1
  });
});

test('a block whose band label moved is refused before any row is read', async () => {
  const dir = copyOfSheets();
  const file = path.join(dir, '03 - Project Suspension Data.xlsx');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  workbook.getWorksheet('Suspensions').getCell('E3').value = 'Suspension 02';
  await workbook.xlsx.writeFile(file);
  await assert.rejects(readFolder(dir), /column E is not "Suspension 01" \/ "No\."/);
});

test('two workbooks matching one name, a symbolic link and an oversized file are refused', async () => {
  const twice = copyOfSheets();
  fs.copyFileSync(path.join(twice, '06 - Project PCP Data 1.xlsx'), path.join(twice, '06 - Project PCP Data 2.xlsx'));
  await assert.rejects(readFolder(twice), /commentPeriods: expected one workbook, found 2/);

  const projects = '01 - Project Business Intelligence Data 4.xlsx';
  const linked = copyOfSheets();
  fs.renameSync(path.join(linked, projects), path.join(linked, 'elsewhere.bin'));
  fs.symlinkSync(path.join(linked, 'elsewhere.bin'), path.join(linked, projects));
  await assert.rejects(readFolder(linked), /is a symbolic link/);

  assert.throws(() => readInput(linked, projects, 0), /is a symbolic link/, 'lstat check where O_NOFOLLOW is missing');

  const large = copyOfSheets();
  fs.truncateSync(path.join(large, projects), 50 * 1024 * 1024 + 1);
  await assert.rejects(readFolder(large), /is over 52428800 bytes/);

  // Central directory entries declare each inflated size at offset 24.
  const declare = async (sizeOf, pattern) => {
    const dir = copyOfSheets();
    const zip = fs.readFileSync(path.join(dir, projects));
    const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    for (let at = zip.indexOf(signature), i = 0; at >= 0; at = zip.indexOf(signature, at + 4), i += 1) {
      zip.writeUInt32LE(sizeOf(i), at + 24);
    }
    fs.writeFileSync(path.join(dir, projects), zip);
    await assert.rejects(readFolder(dir), pattern);
  };
  await declare(i => (i === 0 ? 300 * 1024 * 1024 : 1), /holds an entry over 209715200 bytes/);
  await declare(() => 150 * 1024 * 1024, /inflates to over 524288000 bytes/);
});

test('real-folder counts', { skip: !process.env.WORKS_REAL_DIR && 'set WORKS_REAL_DIR on the laptop' }, async () => {
  const { counts } = await readFolder(process.env.WORKS_REAL_DIR);
  assert.deepEqual(counts, {
    projects: 362, amendments: 329, suspensions: 77, extensions: 86, orderVariations: 157,
    commentPeriods: 386, timeline2002: 177, transitions: 8, transitionsDated: 6
  });
});

test('test extract holds no staff column, no investment and no real number without sign-off refs', async () => {
  const plain = await extractTo(['--env', 'test', ...surrogateArgs(newMap(), '--new-surrogates')]);
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
  await assert.rejects(extractTo(['--env', 'prod', '--keep-staff-on-test', 'SIGNOFF-1']), /--env test only/);
});

test('surrogates are stable across two operator keys', async () => {
  const map = newMap();
  const first = await extractTo(['--env', 'test', ...surrogateArgs(map, '--new-surrogates')]);
  const second = await extractTo(['--env', 'test', ...surrogateArgs(map)], devboxKeys());
  const idsByName = ({ extract }) => Object.fromEntries(extract.records.projects.map(r => [r.name, r.id]));
  assert.deepEqual(idsByName(second), idsByName(first));
  assert.equal(new Set(Object.values(idsByName(first))).size, 3);
});

test('a missing surrogate map needs --new-surrogates, which refuses an existing map', async () => {
  const map = newMap();
  await assert.rejects(extractTo(['--env', 'test', ...surrogateArgs(map)]),
    (err) => err.message.includes(`${path.resolve(map)} not found. Pass --new-surrogates only on the very first run`));
  assert.equal(fs.existsSync(map), false);
  await assert.rejects(extractTo(['--env', 'test', '--surrogate-passphrase-ref', 'surrogate', '--new-surrogates']),
    /missing --surrogates/);
  await extractTo(['--env', 'test', ...surrogateArgs(map, '--new-surrogates')]);
  const before = fs.readFileSync(map);
  await assert.rejects(extractTo(['--env', 'test', ...surrogateArgs(map, '--new-surrogates')]), /exists; drop --new-surrogates/);
  assert.deepEqual(fs.readFileSync(map), before);
  for (const args of [['--env', 'prod', ...surrogateArgs(map)], ['--env', 'prod', '--new-surrogates'],
    ['--env', 'test', '--keep-numbers-on-test', 'SIGNOFF-2', ...surrogateArgs(map)]]) {
    await assert.rejects(extractTo(args), /apply only when numbers are replaced/);
  }
});

test('a surrogate map that appears during a --new-surrogates run is left unchanged', async () => {
  const map = newMap();
  const running = extractTo(['--env', 'test', ...surrogateArgs(map, '--new-surrogates')]);
  fs.writeFileSync(map, 'written by another run');
  await assert.rejects(running, /appeared during this run; it was left unchanged/);
  assert.equal(fs.readFileSync(map, 'utf8'), 'written by another run');
  assert.deepEqual(fs.readdirSync(path.dirname(map)), [path.basename(map)]);
});

test('an empty or corrupt surrogate map is refused and left unchanged', async () => {
  for (const content of ['', '{"v":1,"iv":"AAAA","tag":"AAAA","salt":"AAAA","ciphertext":"AAAA"}']) {
    const map = newMap();
    fs.writeFileSync(map, content);
    await assert.rejects(extractTo(['--env', 'test', ...surrogateArgs(map)]), /could not be opened/);
    assert.equal(fs.readFileSync(map, 'utf8'), content);
    assert.equal(fs.existsSync(`${map}.lock`), false);
  }
});

test('a held lock refuses a second run and stays; this run releases its own lock on failure', async () => {
  const map = newMap();
  await extractTo(['--env', 'test', ...surrogateArgs(map, '--new-surrogates')]);
  assert.equal(fs.existsSync(`${map}.lock`), false);
  fs.writeFileSync(`${map}.lock`, '1');
  await assert.rejects(extractTo(['--env', 'test', ...surrogateArgs(map)]),
    (err) => /holds the surrogate map\. Delete it only when no run is active$/.test(err.message));
  assert.equal(fs.readFileSync(`${map}.lock`, 'utf8'), '1');
  fs.writeFileSync(`${map}.lock`, '2147483646');
  await assert.rejects(extractTo(['--env', 'test', ...surrogateArgs(map)]), /process 2147483646 named in it is not running/);
  fs.rmSync(`${map}.lock`);

  await assert.rejects(extractTo(['--env', 'test', '--surrogates', map, '--surrogate-passphrase-ref', 'other']), /could not be opened/);
  assert.equal(fs.existsSync(`${map}.lock`), false);
  await assert.rejects(cli(['extract', '--env', 'test', '--in', path.join(tmp, 'no-such-dir'), ...surrogateArgs(map),
    '--recipient-key', devbox.pemFile, '--expect-fingerprint', devbox.fingerprint,
    '--out', path.join(fresh('out'), 'x.sealed.json')]), /ENOENT/);
  assert.equal(fs.existsSync(`${map}.lock`), false);

  const running = extractTo(['--env', 'test', ...surrogateArgs(map)]);
  fs.writeFileSync(`${map}.lock`, '1');
  await running;
  assert.equal(fs.readFileSync(`${map}.lock`, 'utf8'), '1', 'a lock now naming another run is left alone');
});

test('SIGTERM during a run removes the surrogate map lock', async () => {
  const map = newMap();
  const bin = fresh('slow-bin');
  fs.writeFileSync(path.join(bin, 'secret-tool'), `#!/bin/sh\nsleep 2\nprintf '%s\\n' '${secrets.surrogate}'\n`, { mode: 0o700 });
  const child = spawn(process.execPath, [EXTRACT, 'extract', '--env', 'test', '--in', sheetsDir, ...surrogateArgs(map, '--new-surrogates'),
    '--recipient-key', devbox.pemFile, '--expect-fingerprint', devbox.fingerprint, '--out', path.join(fresh('out'), 'x.sealed.json')],
  { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, stdio: 'ignore' });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve(signal)));
  for (let i = 0; i < 100 && !fs.existsSync(`${map}.lock`); i += 1) await new Promise(r => setTimeout(r, 50));
  assert.equal(fs.existsSync(`${map}.lock`), true, 'lock taken before the keyring read');
  child.kill('SIGTERM');
  assert.equal(await exited, 'SIGTERM');
  assert.equal(fs.existsSync(`${map}.lock`), false);
  assert.equal(fs.existsSync(map), false);
});

test('surrogate passphrase is read from the keyring, not a file', async () => {
  const map = newMap();
  await extractTo(['--env', 'test', ...surrogateArgs(map, '--new-surrogates')]);
  const wrong = ['--env', 'test', '--surrogates', map, '--surrogate-passphrase-ref'];
  await assert.rejects(extractTo([...wrong, 'other']), /surrogate map .* could not be opened/);

  const fileRef = path.join(fresh('ref'), 'passphrase.txt');
  fs.writeFileSync(fileRef, secrets.surrogate);
  await assert.rejects(extractTo([...wrong, fileRef]), /no keyring entry/);
  await assert.rejects(extractTo(['--env', 'test', '--surrogates', map, '--surrogate-passphrase-file', fileRef]), /Unknown option/);
});

test('a missing keyring tool is named, not reported as a missing entry', async () => {
  const noTools = { ...process.env, PATH: fresh('empty-bin') };
  await assert.rejects(cli(['keygen', '--env', 'test', '--out-dir', fresh('keys'), '--passphrase-ref', 'operator'], noTools),
    /(secret-tool|security) is not installed/);

  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    await assert.rejects(cli(['keygen', '--env', 'test', '--out-dir', fresh('keys'), '--passphrase-ref', 'operator']),
      /not supported on win32/);
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
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
  assert.deepEqual(fs.readdirSync(path.dirname(out)), ['extract.sealed.json']);
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
  return { dir, keyFile: path.join(dir, 'operator-test.key.pem'), publicKey, fingerprint: fingerprintOf({ rsa: publicKey }) };
}

function devboxSends(op, body, statement) {
  const file = path.join(fresh('blob'), 'crosswalk.sealed.json');
  fs.writeFileSync(file, sealEnvelope(Buffer.from(body), {
    purpose: 'crosswalk', env: 'test', keyFingerprint: op.fingerprint, recipientKey: op.publicKey,
    signature: sign(devbox.ed.privateKey, statement)
  }));
  return file;
}

const openArgs = (op, file, out, expect) => ['open', '--env', 'test', '--purpose', 'crosswalk', '--in', file,
  '--out', out, '--key', op.keyFile, '--passphrase-ref', 'operator', '--devbox-key', devbox.pemFile,
  '--devbox-fingerprint', devbox.fingerprint, '--expect-sha256', expect];

test('open refuses a bad signature or hash', async () => {
  const op = await operator();
  const body = 'row,state\n1,exact\n';
  const sha256 = sha256Hex(body);
  const good = devboxSends(op, body, { purpose: 'crosswalk', env: 'test', sha256 });
  const out = path.join(fresh('review'), 'crosswalk.csv');
  await assert.rejects(cli(openArgs(op, good, out, sha256Hex('other'))), /does not match --expect-sha256/);
  const forged = devboxSends(op, body, { purpose: 'report', env: 'test', sha256 });
  await assert.rejects(cli(openArgs(op, forged, out, sha256)), /devbox signature does not verify/);
  assert.equal(fs.existsSync(out), false);

  assert.deepEqual(await cli(openArgs(op, good, out, sha256)), [`crosswalkSha256=${sha256}`]);
  assert.equal(fs.readFileSync(out, 'utf8'), body);
});

test('every output is mode 0600 and never overwritten', async () => {
  const op = await operator();
  assert.equal(modeOf(op.keyFile), 0o600);
  await assert.rejects(cli(['keygen', '--env', 'test', '--out-dir', op.dir, '--passphrase-ref', 'operator']), /already exists/);
  const onlyPub = fresh('keys');
  fs.writeFileSync(path.join(onlyPub, 'operator-test.pub.pem'), 'placeholder');
  await assert.rejects(cli(['keygen', '--env', 'test', '--out-dir', onlyPub, '--passphrase-ref', 'operator']), /already exists/);
  assert.deepEqual(fs.readdirSync(onlyPub), ['operator-test.pub.pem']);

  const map = newMap();
  const { out } = await extractTo(['--env', 'test', ...surrogateArgs(map, '--new-surrogates')]);
  assert.deepEqual([modeOf(out), modeOf(map)], [0o600, 0o600]);
  await assert.rejects(extractTo(['--env', 'prod'], devbox, out), /already exists/);
  await assert.rejects(extractTo(['--env', 'prod'], devbox, path.join(fresh('out'), 'extract.json')), /must end with \.sealed\.json/);

  const body = 'row\n';
  const blob = devboxSends(op, body, { purpose: 'crosswalk', env: 'test', sha256: sha256Hex(body) });
  const review = path.join(fresh('review'), 'crosswalk.csv');
  await cli(openArgs(op, blob, review, sha256Hex(body)));
  assert.deepEqual([modeOf(review), modeOf(`${review}.sig`)], [0o600, 0o600]);
  const sigOnly = path.join(fresh('review'), 'crosswalk.csv');
  fs.writeFileSync(`${sigOnly}.sig`, 'old');
  await assert.rejects(cli(openArgs(op, blob, sigOnly, sha256Hex(body))), /already exists/);
  assert.equal(fs.existsSync(sigOnly), false);
});

function sealArgs(purpose, file, out, ...extra) {
  return ['seal', '--env', 'test', '--purpose', purpose, '--in', file, '--out', out,
    '--recipient-key', devbox.pemFile, '--expect-fingerprint', devbox.fingerprint, ...extra];
}

test('seal prints the manual-match SHA-256', async () => {
  const file = path.join(fresh('manual'), 'manual-match.csv');
  fs.writeFileSync(file, 'sheetId,trackId\n1,2\n');
  const out = path.join(path.dirname(file), 'manual-match.sealed.json');
  await assert.rejects(cli(sealArgs('manual-match', file, path.join(path.dirname(file), 'manual-match.json'))),
    /must end with \.sealed\.json/);
  const lines = await cli(sealArgs('manual-match', file, out));
  assert.deepEqual(lines, [`manualMatchSha256=${sha256Hex(fs.readFileSync(file))}`]);
  assert.equal(modeOf(out), 0o600);
  const opened = openEnvelope(fs.readFileSync(out), {
    purpose: 'manual-match', env: 'test', keyFingerprint: devbox.fingerprint, privateKey: devbox.rsa.privateKey
  });
  assert.equal(opened.plaintext.toString('utf8'), fs.readFileSync(file, 'utf8'));
});

test('seal refuses a crosswalk whose devbox signature does not verify', async () => {
  const dir = fresh('crosswalk');
  const file = path.join(dir, 'crosswalk.csv');
  fs.writeFileSync(file, 'row,state\n1,exact\n');
  const sha256 = sha256Hex(fs.readFileSync(file));
  fs.writeFileSync(path.join(dir, 'bad.sig'), sign(devbox.ed.privateKey, { purpose: 'report', env: 'test', sha256 }));
  fs.writeFileSync(path.join(dir, 'good.sig'), sign(devbox.ed.privateKey, { purpose: 'crosswalk', env: 'test', sha256 }));
  const out = path.join(dir, 'crosswalk.sealed.json');
  await assert.rejects(cli(sealArgs('crosswalk', file, out, '--signature', path.join(dir, 'bad.sig'))), /does not verify/);
  assert.equal(fs.existsSync(out), false);
  assert.deepEqual(await cli(sealArgs('crosswalk', file, out, '--signature', path.join(dir, 'good.sig'))),
    [`crosswalkSha256=${sha256}`]);
});

test('seal refuses a works-backup whose devbox signature does not verify', async () => {
  const dir = fresh('works-backup');
  const file = path.join(dir, 'works-backup.json');
  fs.writeFileSync(file, '{"batchId":"b-1","documents":[],"projects":[]}');
  const sha256 = sha256Hex(fs.readFileSync(file));
  fs.writeFileSync(path.join(dir, 'bad.sig'), sign(devbox.ed.privateKey, { purpose: 'works-report', env: 'test', sha256 }));
  const out = path.join(dir, 'works-backup.sealed.json');
  await assert.rejects(cli(sealArgs('works-backup', file, out, '--signature', path.join(dir, 'bad.sig'))),
    /works-backup signature does not verify/);
  assert.equal(fs.existsSync(out), false);
});
