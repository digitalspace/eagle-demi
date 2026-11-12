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
const HEADER_ROW = 1;
const SKIP_SHEETS = /\bbi\b|2018/i;
const TRANSITION_PROCESS = 'transition order (2018)';
const SEAL_PURPOSES = ['crosswalk', 'manual-match'];
const OPEN_PURPOSES = ['crosswalk', 'report'];
const SURROGATE_AAD = Buffer.from('works-import-surrogates');
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const D = 'date';
const T = 'text';
const ID_NAME = [['A', 'id', 'ID', 'id'], ['B', 'name', 'Project Name', T]];
const DATED = [['C', 'appliedTo', 'Applied To', T], ['D', 'startDate', 'Start Date', D], ['E', 'endDate', 'End Date', D]];
const START_END = [['startDate', 'endDate']];

// The only columns read: [letter, field, header the workbook must show, type]. Every header is
// checked before any row is read, so a moved column stops the run instead of shifting values.
const SOURCES = [
  {
    key: 'projects', file: /^01\s.*project.*\.xlsx$/i, ranges: [['intakeDate', 'decisionDate']],
    columns: [...ID_NAME,
      ['C', 'status', 'Status', T], ['D', 'region', 'Region', T], ['E', 'subsector', 'Sub-Sector', T],
      ['F', 'ceaa', 'CEAA', T], ['G', 'intakeType', 'Intake Type', T], ['H', 'intakeDate', 'Intake Date', D],
      ['I', 'determinationType', 'Determination Type', T], ['J', 'determinationDate', 'Determination Date', D],
      ['K', 's11Order', 's.11/14 Order', D], ['L', 'draftAir', 'Draft AIR', D], ['M', 'airAccepted', 'AIR Accepted', D],
      ['N', 'start30', 'Start (30)', D], ['O', 'start180', 'Start (180)', D], ['P', 'start45', 'Start (45)', D],
      ['Q', 'decision', 'Decision', T], ['R', 'decisionDate', 'Decision Date', D], ['S', 'far', 'F.A.R.', T],
      ['T', 'epd', 'EPD', T], ['U', 'lead', 'Lead', T], ['V', 'investment', 'Investment', T], ['W', 'notes', 'Notes', T],
      ['AE', 'substantiallyStarted', 'Substantially Started', T], ['AF', 'substantiallyStartedDate', 'Date', D],
      ['AG', 'expiry', 'Expiry', D], ['AI', 'extensionDate', 'Extension Date', D],
      ['AJ', 'extensionExpiry', 'Extension Expiry', D]]
  },
  {
    key: 'amendments', file: /^02\s.*\.xlsx$/i, columns: ID_NAME, ranges: START_END,
    bands: { from: 'D', width: 5, columns: [[0, 'title', 'Amendment', T], [1, 'complexity', 'Complexity', T],
      [2, 'status', 'Status', T], [3, 'startDate', 'Start Date', D], [4, 'endDate', 'End Date', D]] }
  },
  { key: 'suspensions', file: /^03\s.*\.xlsx$/i, columns: [...ID_NAME, ...DATED], ranges: START_END },
  { key: 'extensions', file: /^04\s.*\.xlsx$/i, columns: [...ID_NAME, ...DATED], ranges: START_END },
  {
    key: 'orderVariations', file: /^05\s.*\.xlsx$/i, columns: ID_NAME,
    bands: { from: 'C', width: 2, columns: [[0, 'section', 'Section', T], [1, 'date', 'Date', D]] }
  },
  {
    key: 'commentPeriods', file: /^06\s.*\.xlsx$/i, ranges: START_END,
    columns: [...ID_NAME, ['C', 'type', 'Type', T], ['D', 'startDate', 'Start Date', D], ['E', 'endDate', 'End Date', D]]
  },
  {
    key: 'timeline2002', file: /2002.*\.xlsx$/i,
    columns: [...ID_NAME, ['C', 'determinationDate', 'Determination Date', D], ['D', 's11Order', 's.11/14 Order', D],
      ['E', 'draftAir', 'Draft AIR', D], ['F', 'airAccepted', 'AIR Accepted', D], ['G', 'start30', 'Start (30)', D],
      ['H', 'start180', 'Start (180)', D], ['I', 'start45', 'Start (45)', D], ['J', 'decision', 'Decision', T],
      ['K', 'decisionDate', 'Decision Date', D]]
  },
  {
    // Columns A, G and H only: the sheet's EPD (F) and Notes (E) columns are never read.
    key: 'transitions', file: /assess\s*bi.*\.xlsx$/i, sheet: /^ea process data$/i,
    columns: [['A', 'id', 'ID', 'id'], ['G', 'process', 'Process', T], ['H', 'date', 'Date', D]],
    keep: row => String(row.process || '').toLowerCase() === TRANSITION_PROCESS
  }
];

function cached(value) {
  if (value == null || value instanceof Date || typeof value !== 'object') return value ?? null;
  if ('formula' in value || 'sharedFormula' in value || 'result' in value) return cached(value.result);
  if (Array.isArray(value.richText)) return value.richText.map(r => r.text).join('');
  if ('text' in value) return cached(value.text);
  return null;
}

function typed(raw, type) {
  const value = cached(raw);
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

function headerText(ws, col) {
  return String(cached(ws.getRow(HEADER_ROW).getCell(col).value) ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function bandColumns(bands, slot) {
  const start = ws => ws.getColumn(bands.from).number + (slot - 1) * bands.width;
  return ws => bands.columns.map(([offset, field, header, type]) => [start(ws) + offset, field, header, type]);
}

/** Refuses a sheet whose headers differ from the map; returns how many bands it holds. */
function checkHeaders(ws, source, file) {
  const expect = (col, header) => {
    if (headerText(ws, col) !== header.toLowerCase()) {
      throw new Error(`${file} / ${ws.name}: column ${ws.getColumn(col).letter} header is not "${header}"`);
    }
  };
  source.columns.forEach(([col, , header]) => expect(col, header));
  if (!source.bands) return 0;
  let slots = 0;
  while (headerText(ws, ws.getColumn(source.bands.from).number + slots * source.bands.width)) {
    slots += 1;
    bandColumns(source.bands, slots)(ws).forEach(([col, , header]) => expect(col, header));
  }
  return slots;
}

function pick(row, columns, ref, flags) {
  const out = {};
  for (const [col, field, , type] of columns) {
    const { value, flag } = typed(row.getCell(col).value, type);
    out[field] = value;
    if (flag) flags.push({ ...ref, field, kind: flag });
    if (type === D && value === SENTINEL_DATE) flags.push({ ...ref, field, kind: 'sentinel' });
  }
  return out;
}

const blank = (rec, skip = []) => Object.entries(rec).every(([k, v]) => skip.includes(k) || v == null);

function rangeFlags(source, rec, ref, flags) {
  for (const [start, end] of source.ranges || []) {
    if (rec[start] && rec[end] && rec[end] < rec[start]) flags.push({ ...ref, field: end, kind: 'endBeforeStart' });
  }
}

function readSheet(ws, source, file, out) {
  const slots = checkHeaders(ws, source, file);
  for (let r = HEADER_ROW + 1; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    const ref = { file, sheet: ws.name, row: r };
    const flags = [];
    const base = pick(row, source.columns, ref, flags);
    if (blank(base) || (source.keep && !source.keep(base))) continue;
    if (base.id == null) {
      out.flags.push({ ...ref, field: 'id', kind: 'badId' });
      continue;
    }
    if (!source.bands) {
      rangeFlags(source, base, ref, flags);
      out.records[source.key].push({ ref, ...base });
    }
    for (let slot = 1; slot <= slots; slot += 1) {
      const slotRef = { ...ref, slot };
      const fields = pick(row, bandColumns(source.bands, slot)(ws), slotRef, flags);
      if (blank(fields)) continue;
      rangeFlags(source, fields, slotRef, flags);
      out.records[source.key].push({ ref: slotRef, id: base.id, name: base.name, ...fields });
    }
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
  const files = fs.readdirSync(dir).filter(f => /\.xlsx$/i.test(f) && !f.startsWith('~$'));
  const out = { records: {}, flags: [] };
  for (const source of SOURCES) {
    const matches = files.filter(f => source.file.test(f));
    if (matches.length !== 1) throw new Error(`${source.key}: expected one workbook, found ${matches.length}`);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(dir, matches[0]));
    out.records[source.key] = [];
    for (const ws of workbook.worksheets) {
      if (source.sheet ? source.sheet.test(ws.name) : !SKIP_SHEETS.test(ws.name)) readSheet(ws, source, matches[0], out);
    }
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

function writeNew(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600, flag: 'wx' });
}

function surrogateKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32, SCRYPT);
}

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
    if (surrogates) row.id = surrogateOf(surrogates.map, row.id);
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
