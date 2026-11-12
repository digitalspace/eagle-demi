'use strict';

// Laptop-side tool: reads the business workbooks and hands DEMI only sealed envelopes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { parseArgs } = require('util');
const ExcelJS = require('exceljs');
const { logger } = require('../../src/utils/logger');
const {
  STAFF_FIELDS, fingerprintOf, publicKeysFromPem, sealEnvelope, openEnvelope, sha256Hex, verify
} = require('../../src/utils/import-envelope');

const ENVS = ['test', 'prod'];
const SENTINEL_DATE = '1995-06-30';
const NULL_TEXT = new Set(['', '---', 'n/a']);
const MIN_PASSPHRASE = 20;
const KEYRING_SERVICE = 'eagle-demi-works-import';
const NOW_FORMULA = /\b(NOW|TODAY)\s*\(/i;
const TRANSITION_PROCESS = 'transition order (2018)';
const SEAL_PURPOSES = ['crosswalk', 'manual-match'];
const OPEN_PURPOSES = ['crosswalk', 'report'];
const SURROGATE_AAD = Buffer.from('works-import-surrogates');
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const D = 'date';
const T = 'text';
const pad = n => String(n).padStart(2, '0');
const fileNamed = name => new RegExp(`^${name}( \\d+)?\\.xlsx$`, 'i');
// Entry: [letter, field (null: label checked, value never read), band label on the row above, header label, type].
const under = (band, cols) => cols.map(([col, field, header, type = T]) => [col, field, band, header, type]);
const blocks = (from, count, band, columns) => ({ from, count, band: s => `${band} ${pad(s)}`, columns });
const ID_NAME = [...under('ID', [['A', 'id', 'ID', 'id']]), ...under('Project Information', [['B', 'name', 'Name']])];
const INTERRUPTION = [[0, null, 'No.'], [1, 'type', 'Type'], [2, 'appliedTo', 'Applied To'],
  [3, 'startDate', 'Start Date', D], [4, 'endDate', 'End Date', D], [5, null, 'Days']];
const START_END = [['startDate', 'endDate']];
const MAIN = { bandRow: 3, headerRow: 4 };

// The only workbooks, tabs and columns read; every other tab (For BI, Lookups, TEMP, ...) is never opened.
const SOURCES = [
  { key: 'projects', file: fileNamed('01 - Project Business Intelligence Data'), tab: 'Projects', ...MAIN,
    ranges: [['intakeDate', 'decisionDate']], columns: [...ID_NAME,
      ...under('Project Information', [['C', 'proponent', 'Proponent/Certificate Holder'], ['D', 'status', 'Status'],
        ['E', null, 'Work'], ['F', 'ceaa', 'CEAA'], ['G', 'subsector', 'Subsector'], ['H', 'regionEnv', 'Region (ENV)'],
        ['I', 'regionFlnro', 'Region (FLNRO)'], ['J', 'investment', 'Investment $'], ['K', 'notes', 'Notes']]),
      ...under('Team Information', [['L', 'epd', 'EPD'], ['M', 'lead', 'Lead']]),
      ...under('Intake (Start)', [['Q', 'intakeType', 'Type'], ['R', 'intakeDate', 'Date', D]]),
      ...under('Determination', [['S', 'determinationType', 'Type'], ['T', 'determinationDate', 'Date', D]]),
      ...under('Scope', [['U', 's11Order', 's.11/14 Order', D], ['V', 'draftAir', 'Draft AIR', D], ['W', 'airAccepted', 'AIR', D]]),
      ...under('Evaluation', [['X', 'start30', 'Start (30)', D]]), ...under('Review', [['Y', 'start180', 'Start (180)', D]]),
      ...under('Decision', [['Z', 'start45', 'Start (45)', D], ['AA', 'decision', 'Decision'],
        ['AB', 'decisionDate', 'Date', D], ['AC', 'far', 'F.A.R.']]),
      ...under('Substantially Started', [['AE', 'substantialStartStatus', 'Status'],
        ['AF', 'substantialStartDate', 'Date', D], ['AG', 'substantialStartFlag', 'SS?']]),
      ...under('Certificate Information', [['AH', 'expiryDate', 'Expiry Date', D],
        ['AI', 'extensionDate', 'Extension Date', D], ['AJ', 'extensionExpiry', 'Extension Expiry', D]])] },
  { key: 'amendments', file: fileNamed('02 - Project Amendment Data'), tab: 'Amendments', ...MAIN, columns: ID_NAME,
    ranges: START_END, blocks: blocks('D', 15, 'Amendment', [[0, null, 'No.'], [1, 'complexity', 'Complexity'],
      [2, 'status', 'Status'], [3, 'startDate', 'Start Date', D], [4, 'endDate', 'End Date', D]]) },
  { key: 'suspensions', file: fileNamed('03 - Project Suspension Data'), tab: 'Suspensions', ...MAIN, columns: ID_NAME,
    ranges: START_END, blocks: blocks('E', 10, 'Suspension', INTERRUPTION) },
  { key: 'extensions', file: fileNamed('04 - Project Extension Data'), tab: 'Extensions', ...MAIN, columns: ID_NAME,
    ranges: START_END, blocks: blocks('E', 10, 'Extension', INTERRUPTION) },
  { key: 'orderVariations', file: fileNamed('05 - Project Section 13 Data'), tab: 'Section 13', ...MAIN, columns: ID_NAME,
    blocks: blocks('D', 10, 'Variation', [[0, null, 'No.'], [1, 'date', 'Date', D]]) },
  { key: 'commentPeriods', file: fileNamed('06 - Project PCP Data'), tab: 'PCPs', ...MAIN, columns: ID_NAME,
    ranges: START_END, blocks: blocks('D', 10, 'Public Comment Period',
      [[0, 'type', 'Type'], [1, 'startDate', 'Start Date', D], [2, 'endDate', 'End Date', D]]) },
  // No ID column: these rows join to the register by project name.
  { key: 'timeline2002', file: fileNamed('Calculating Timelines for the 2002 Act'), tab: '2002', bandRow: 8, headerRow: 9,
    columns: [...under('Project Information', [['A', 'name', 'Project Name']]),
      ...under('Intake (A)', [['B', 'intakeDate', 'Intake (A)', D]]), ...under('s.10 / Det (B)', [['D', 'determinationDate', 'Determination', D]]),
      ...under('Scope (C)', [['F', 's11Order', 's.11/14 Order', D]]), ...under('AIR (D)', [['H', 'airAccepted', 'AIR Accepted', D]]),
      ...under('Evaluation (F)', [['N', 'start30', 'Start (30)', D]]), ...under('Review (H)', [['Q', 'start180', 'Start (180)', D]]),
      ...under('Referral (I)', [['S', 'start45', 'Start (45)', D]]),
      ...under('Decision (J)', [['U', 'decisionDate', 'Date', D], ['V', 'decision', 'Decision']])] },
  // Columns A, G and H only: the sheet's Notes (E) and EPD (F) columns are never read.
  { key: 'transitions', file: fileNamed('01 - Project Assessment BI Sheet'), tab: 'EA Process Data', ...MAIN,
    columns: [...under('ID', [['A', 'id', 'No.', 'id']]), ...under('Intake', [['G', 'process', 'Type'], ['H', 'date', 'Date', D]])],
    keep: row => String(row.process || '').toLowerCase() === TRANSITION_PROCESS }
];

function cached(value) {
  if (value == null || value instanceof Date || typeof value !== 'object') return value ?? null;
  if ('formula' in value || 'sharedFormula' in value || 'result' in value) return cached(value.result);
  if (Array.isArray(value.richText)) return value.richText.map(r => r.text).join('');
  if ('text' in value) return cached(value.text);
  return null;
}

function typed(cell, type) {
  // A =NOW() date is "still open" in the sheet; its cached value is only the day it was saved.
  if (type === D && NOW_FORMULA.test(cell.formula || '')) return { value: null, flag: 'nowFormula' };
  const value = cached(cell.value);
  if (typeof value === 'string' && NULL_TEXT.has(value.trim().toLowerCase())) return { value: null };
  if (value == null) return { value: null };
  if (type === 'id') {
    const text = String(value).trim();
    return /^\d+$/.test(text) ? { value: Number(text) } : { value: null, flag: 'badId' };
  }
  if (type === D) {
    if (value instanceof Date) return { value: value.toISOString().slice(0, 10) };
    const text = String(value).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? { value: text } : { value: null, flag: 'badDate' };
  }
  if (value instanceof Date) return { value: value.toISOString().slice(0, 10) };
  return { value: typeof value === 'string' ? value.trim() : value };
}

const label = (ws, rowNo, col) =>
  String(cached(ws.getRow(rowNo).getCell(col).value) ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const columnNumber = letters => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);

/** [base columns, then one column list per block slot], each entry [column, field, band, header, type]. */
function columnsOf(source) {
  const b = source.blocks;
  const slot = s => b.columns.map(([offset, field, header, type = T]) =>
    [columnNumber(b.from) + (s - 1) * b.columns.length + offset, field, b.band(s), header, type]);
  return [source.columns, ...Array.from({ length: b ? b.count : 0 }, (_, i) => slot(i + 1))];
}

/** Refuses a sheet whose band or header labels differ from the map, before any row is read. */
function checkHeaders(ws, source, file) {
  for (const [col, , band, header] of columnsOf(source).flat()) {
    if (label(ws, source.bandRow, col) !== band.toLowerCase() || label(ws, source.headerRow, col) !== header.toLowerCase()) {
      throw new Error(`${file} / ${ws.name}: column ${ws.getColumn(col).letter} is not "${band}" / "${header}"`);
    }
  }
}

function pick(row, columns, ref, flags) {
  const out = {};
  for (const [col, field, , , type] of columns) {
    if (!field) continue;
    const { value, flag } = typed(row.getCell(col), type);
    out[field] = value;
    if (flag) flags.push({ ...ref, field, kind: flag });
    if (type === D && value === SENTINEL_DATE) flags.push({ ...ref, field, kind: 'sentinel' });
  }
  return out;
}

const blank = rec => Object.values(rec).every(v => v == null);

function rangeFlags(source, rec, ref, flags) {
  for (const [start, end] of source.ranges || []) {
    if (rec[start] && rec[end] && rec[end] < rec[start]) flags.push({ ...ref, field: end, kind: 'endBeforeStart' });
  }
}

function readSheet(ws, source, file, out) {
  checkHeaders(ws, source, file);
  const [, ...slots] = columnsOf(source);
  for (let r = source.headerRow + 1; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    const ref = { file, sheet: ws.name, row: r };
    const flags = [];
    const base = pick(row, source.columns, ref, flags);
    // Ids and slot numbers are pre-filled far below the data, so only a named project is a row.
    if (source.keep ? !source.keep(base) : base.name == null) continue;
    if ('id' in base && base.id == null) {
      out.flags.push({ ...ref, field: 'id', kind: 'badId' });
      continue;
    }
    if (!source.blocks) {
      rangeFlags(source, base, ref, flags);
      out.records[source.key].push({ ref, ...base });
    }
    slots.forEach((columns, i) => {
      const slotRef = { ...ref, slot: i + 1 };
      const slotFlags = [];
      const fields = pick(row, columns, slotRef, slotFlags);
      if (blank(fields)) return;
      rangeFlags(source, fields, slotRef, slotFlags);
      flags.push(...slotFlags);
      out.records[source.key].push({ ref: slotRef, id: base.id, name: base.name, ...fields });
    });
    out.flags.push(...flags);
  }
}

function countsOf(records) {
  const counts = Object.fromEntries(Object.entries(records).map(([key, rows]) => [key, rows.length]));
  counts.projects = new Set(records.projects.map(r => r.id)).size;
  counts.transitionsDated = records.transitions.filter(r => r.date).length;
  return counts;
}

/** Reads the mapped columns of every workbook in `dir`, in memory. */
async function readFolder(dir) {
  const files = fs.readdirSync(dir);
  const out = { records: {}, flags: [] };
  for (const source of SOURCES) {
    const matches = files.filter(f => source.file.test(f));
    if (matches.length !== 1) throw new Error(`${source.key}: expected one workbook, found ${matches.length}`);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(dir, matches[0]));
    const ws = workbook.getWorksheet(source.tab);
    if (!ws) throw new Error(`${matches[0]}: no tab "${source.tab}"`);
    out.records[source.key] = [];
    readSheet(ws, source, matches[0], out);
  }
  return { ...out, counts: countsOf(out.records) };
}

/** Reads a secret from the OS keyring or a 1Password `op://` reference; never from a file. */
function readSecretRef(ref, env) {
  const [cmd, args] = ref.startsWith('op://') ? ['op', ['read', '--no-newline', ref]]
    : process.platform === 'darwin' ? ['security', ['find-generic-password', '-s', KEYRING_SERVICE, '-a', ref, '-w']]
      : ['secret-tool', ['lookup', 'service', KEYRING_SERVICE, 'account', ref]];
  let secret;
  try {
    secret = execFileSync(cmd, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\r?\n$/, '');
  } catch {
    secret = '';
  }
  if (!secret) throw new Error(`no keyring entry for ${ref}`);
  return secret;
}

function passphraseFrom(ref, env) {
  const secret = readSecretRef(ref, env);
  if (secret.length < MIN_PASSPHRASE) throw new Error(`passphrase for ${ref} is shorter than ${MIN_PASSPHRASE} characters`);
  return secret;
}

const writeNew = (file, data) => fs.writeFileSync(file, data, { mode: 0o600, flag: 'wx' });
const surrogateKey = (passphrase, salt) => crypto.scryptSync(passphrase, salt, 32, SCRYPT);

function loadSurrogates(file, passphrase) {
  if (!fs.existsSync(file)) return new Map();
  try {
    const box = JSON.parse(fs.readFileSync(file, 'utf8'));
    const decipher = crypto.createDecipheriv('aes-256-gcm',
      surrogateKey(passphrase, Buffer.from(box.salt, 'base64')), Buffer.from(box.iv, 'base64'));
    decipher.setAAD(SURROGATE_AAD);
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(box.ciphertext, 'base64')), decipher.final()]);
    return new Map(JSON.parse(plain.toString('utf8')));
  } catch {
    // A fresh map here would re-mint every surrogate and tombstone the test sheet works.
    throw new Error(`surrogate map ${file} could not be opened`);
  }
}

function saveSurrogates(file, map, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', surrogateKey(passphrase, salt), iv);
  cipher.setAAD(SURROGATE_AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify([...map])), cipher.final()]);
  const tmp = `${file}.${process.pid}.tmp`;
  writeNew(tmp, JSON.stringify({
    v: 1, salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64')
  }));
  fs.renameSync(tmp, file);
}

function surrogateOf(map, id) {
  if (!map.has(id)) {
    const used = new Set(map.values());
    let next;
    do next = crypto.randomInt(100000, 1000000); while (used.has(next));
    map.set(id, next);
  }
  return map.get(id);
}

function need(opts, ...names) {
  const missing = names.filter(n => !opts[n]);
  if (missing.length) throw new Error(`missing --${missing.join(', --')}`);
  if (opts.env && !ENVS.includes(opts.env)) throw new Error(`--env must be one of ${ENVS.join(', ')}`);
}

function recipientOf(pemFile, expectFingerprint) {
  const keys = publicKeysFromPem(fs.readFileSync(pemFile, 'utf8'));
  const fingerprint = fingerprintOf(keys);
  if (fingerprint !== String(expectFingerprint).toLowerCase()) throw new Error(`fingerprint of ${pemFile} does not match`);
  return { keys, fingerprint };
}

const shaLabel = purpose => `${purpose.replace(/-(\w)/g, (_, c) => c.toUpperCase())}Sha256`;

function keygen(o, io) {
  need(o, 'env', 'out-dir', 'passphrase-ref');
  const passphrase = passphraseFrom(o['passphrase-ref'], io.env);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }
  });
  const base = path.join(o['out-dir'], `operator-${o.env}`);
  writeNew(`${base}.key.pem`, privateKey);
  writeNew(`${base}.pub.pem`, publicKey);
  io.write(`fingerprint=${fingerprintOf({ rsa: publicKey })}`);
}

function policyOf(o) {
  const keepStaff = o['keep-staff-on-test'] || null;
  const keepNumbers = o['keep-numbers-on-test'] || null;
  if (o.env !== 'test' && (keepStaff || keepNumbers)) throw new Error('--keep-*-on-test apply to --env test only');
  return {
    staffIncluded: o.env !== 'test' || Boolean(keepStaff),
    numbersReal: o.env !== 'test' || Boolean(keepNumbers),
    signoffRefs: { keepStaff, keepNumbers }
  };
}

async function extract(o, io) {
  need(o, 'env', 'in', 'recipient-key', 'expect-fingerprint', 'out');
  const { keys, fingerprint } = recipientOf(o['recipient-key'], o['expect-fingerprint']);
  const policy = policyOf(o);
  let surrogates = null;
  if (!policy.numbersReal) {
    need(o, 'surrogates', 'surrogate-passphrase-ref');
    const passphrase = passphraseFrom(o['surrogate-passphrase-ref'], io.env);
    surrogates = { passphrase, map: loadSurrogates(o.surrogates, passphrase) };
  }
  const data = await readFolder(o.in);
  for (const row of Object.values(data.records).flat()) {
    if (!policy.staffIncluded) STAFF_FIELDS.forEach(f => delete row[f]);
    if (surrogates && 'id' in row) row.id = surrogateOf(surrogates.map, row.id);
  }
  if (surrogates) saveSurrogates(o.surrogates, surrogates.map, surrogates.passphrase);
  const plaintext = Buffer.from(JSON.stringify({ schemaVersion: 1, env: o.env, ...policy, ...data }));
  writeNew(o.out, sealEnvelope(plaintext, {
    purpose: 'extract', env: o.env, keyFingerprint: fingerprint, recipientKey: keys.rsa, ...policy
  }));
  Object.entries(data.counts).forEach(([key, n]) => io.write(`${key}=${n}`));
  const kinds = data.flags.reduce((acc, f) => ({ ...acc, [f.kind]: (acc[f.kind] || 0) + 1 }), {});
  Object.entries(kinds).forEach(([kind, n]) => io.write(`flag.${kind}=${n}`));
  io.write(`plaintextSha256=${sha256Hex(plaintext)}`);
}

function seal(o, io) {
  need(o, 'env', 'purpose', 'in', 'recipient-key', 'expect-fingerprint', 'out');
  if (!SEAL_PURPOSES.includes(o.purpose)) throw new Error(`--purpose must be one of ${SEAL_PURPOSES.join(', ')}`);
  const { keys, fingerprint } = recipientOf(o['recipient-key'], o['expect-fingerprint']);
  const plaintext = fs.readFileSync(o.in);
  const sha256 = sha256Hex(plaintext);
  let signature;
  if (o.purpose === 'crosswalk') {
    need(o, 'signature');
    signature = fs.readFileSync(o.signature, 'utf8').trim();
    if (!keys.ed25519 || !verify(keys.ed25519, { purpose: o.purpose, env: o.env, sha256 }, signature)) {
      throw new Error('crosswalk signature does not verify');
    }
  }
  writeNew(o.out, sealEnvelope(plaintext, {
    purpose: o.purpose, env: o.env, keyFingerprint: fingerprint, recipientKey: keys.rsa, signature
  }));
  io.write(`${shaLabel(o.purpose)}=${sha256}`);
}

function open(o, io) {
  need(o, 'env', 'purpose', 'in', 'out', 'key', 'passphrase-ref', 'devbox-key', 'devbox-fingerprint', 'expect-sha256');
  if (!OPEN_PURPOSES.includes(o.purpose)) throw new Error(`--purpose must be one of ${OPEN_PURPOSES.join(', ')}`);
  const devbox = recipientOf(o['devbox-key'], o['devbox-fingerprint']).keys;
  const privateKey = crypto.createPrivateKey({
    key: fs.readFileSync(o.key), passphrase: passphraseFrom(o['passphrase-ref'], io.env)
  });
  const keyFingerprint = fingerprintOf({ rsa: crypto.createPublicKey(privateKey) });
  const opened = openEnvelope(fs.readFileSync(o.in), { purpose: o.purpose, env: o.env, keyFingerprint, privateKey });
  const sha256 = sha256Hex(opened.plaintext);
  if (!devbox.ed25519 || !verify(devbox.ed25519, { purpose: o.purpose, env: o.env, sha256 }, opened.signature)) {
    throw new Error('devbox signature does not verify');
  }
  if (sha256 !== String(o['expect-sha256']).toLowerCase()) throw new Error('SHA-256 does not match --expect-sha256');
  writeNew(o.out, opened.plaintext);
  writeNew(`${o.out}.sig`, `${opened.signature}\n`);
  io.write(`${shaLabel(o.purpose)}=${sha256}`);
}

const COMMANDS = { keygen, extract, seal, open };
const OPTIONS = Object.fromEntries([
  'env', 'in', 'out', 'out-dir', 'passphrase-ref', 'recipient-key', 'expect-fingerprint', 'keep-staff-on-test',
  'keep-numbers-on-test', 'surrogates', 'surrogate-passphrase-ref', 'purpose', 'signature', 'key', 'devbox-key',
  'devbox-fingerprint', 'expect-sha256'
].map(name => [name, { type: 'string' }]));

async function run(argv, { env = process.env, write = line => process.stdout.write(`${line}\n`) } = {}) {
  const [command, ...rest] = argv;
  const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
  if (!handler) throw new Error(`usage: extract.js <${Object.keys(COMMANDS).join('|')}> [options]`);
  const { values } = parseArgs({ args: rest, options: OPTIONS, strict: true, allowPositionals: false });
  await handler(values, { env, write });
}

module.exports = { run, readFolder, SOURCES, KEYRING_SERVICE };

if (require.main === module) {
  run(process.argv.slice(2)).then(() => process.exit(0)).catch((err) => {
    logger.error(`[works-extract] ${err.message}`);
    process.exit(1);
  });
}
