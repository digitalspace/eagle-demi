'use strict';

// Devbox tool (`scripts/demi-devbox.sh run --env <env> -- node src/scripts/works-crosswalk.js <options>`): nothing
// decrypted is written; the CSV leaves only signed and sealed to the operator, and exit 1 still writes it.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { systemAccess } = require('../helpers/access-sql');
const projectsRepository = require('../repositories/projects');
const { eagleOnlyProjectId, isEagleOnlyProjectId, isDemiOwnedProject, hasValue } = require('../merge/project');
const {
  fingerprintOf, publicKeysFromPem, sealEnvelope, openEnvelope, openExtract, sha256Hex, sign, verify
} = require('../utils/import-envelope');
const { logger } = require('../utils/logger');

const ENVS = ['test', 'prod'];
const PURPOSE = 'crosswalk';
const STATES = ['exact', 'manual', 'ambiguous', 'unmatched', 'unlinked', 'unfolded', 'collision', 'badId'];
const PASSING = new Set(['exact', 'manual']);
const COLUMNS = ['row', 'sheetId', 'sheetName', 'state', 'via', 'targetId', 'trackName', 'eagleName', 'eagleId', 'targetEagleId'];
const REGISTER = 'projects';
const REGISTER_TAB = 'Projects';
// Files 02-06: every name they give a register id is an alias of that id.
const ALIAS_SOURCES = ['amendments', 'suspensions', 'extensions', 'orderVariations', 'commentPeriods'];
const MAX_BYTES = { extract: 64 * 1024 * 1024, manual: 1024 * 1024, key: 64 * 1024 };
const MAX_NAME = 500;
const MAX_MANUAL_ENTRIES = 1000;
// `'` too, so a cell that already starts with one survives the strip in readCrosswalk.
const FORMULA_START = /^[=+\-@\t\r']/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
const CSV_CELL = /"((?:[^"]|"")*)"(?:,|$)/y;
const EAGLE_ID = /^[0-9a-f]{24}$/;
const TRACK_ID = /^[1-9]\d{0,9}$/;
const FOLD_PAIR = /^([1-9]\d{0,9}):([0-9a-f]{24})$/;
const PRIVATE_PEM = /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/g;
const SHA256 = /^[0-9a-f]{64}$/;

const refuse = message => { throw new Error(message); };
const textOf = v => (typeof v === 'string' && v.length <= MAX_NAME ? v : null);
const sheetIdOf = v => (Number.isSafeInteger(v) && v > 0 ? v : null);
const positionOf = ref => (ref && typeof ref === 'object' && Number.isSafeInteger(ref.row) ? ref.row : null);
const eagleIdOf = v => (typeof v === 'string' && EAGLE_ID.test(v) ? v : null);

/** Lowercase, `&` as "and", every character but letters and digits dropped. */
const normalized = name => name.normalize('NFKC').toLowerCase().replace(/&/g, 'and').replace(/[^\p{L}\p{N}]+/gu, '');

function addTo(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

const unionOf = (keys, map) => new Set([...keys].flatMap(key => [...(map.get(key) || [])]));

/** Reads one regular file of at most `max` bytes, refusing a symbolic link. */
function readCapped(file, max) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > max) refuse(`${file} is not a regular file of at most ${max} bytes`);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** The devbox RSA and Ed25519 private keys from one PKCS#8 PEM, and their combined fingerprint. */
function devboxKeysOf(pemText) {
  const keys = {};
  for (const block of String(pemText).match(PRIVATE_PEM) || []) {
    const key = crypto.createPrivateKey(block);
    const kind = key.asymmetricKeyType;
    if ((kind !== 'rsa' && kind !== 'ed25519') || keys[kind]) refuse('devbox key file must hold one RSA and one Ed25519 key');
    keys[kind] = key;
  }
  if (!keys.rsa || !keys.ed25519) refuse('devbox key file must hold one RSA and one Ed25519 key');
  const fingerprint = fingerprintOf({ rsa: crypto.createPublicKey(keys.rsa), ed25519: crypto.createPublicKey(keys.ed25519) });
  return { ...keys, fingerprint };
}

/** `{matches: [{sheetId, trackId}], foldPairs: ['trackId:eagleId']}`; errors name the entry index only. */
function manualOf(plaintext) {
  let doc;
  try {
    doc = JSON.parse(plaintext.toString('utf8'));
  } catch {
    refuse('manual-match file is not JSON');
  }
  const keysAre = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join() === [...keys].sort().join();
  if (!keysAre(doc, ['matches', 'foldPairs'])) refuse('manual-match file must hold only matches and foldPairs');
  const listed = Array.isArray(doc.matches) && Array.isArray(doc.foldPairs) &&
    doc.matches.length <= MAX_MANUAL_ENTRIES && doc.foldPairs.length <= MAX_MANUAL_ENTRIES;
  if (!listed) refuse(`manual-match matches and foldPairs must be arrays of at most ${MAX_MANUAL_ENTRIES}`);
  const matches = new Map();
  doc.matches.forEach((entry, i) => {
    const valid = keysAre(entry, ['sheetId', 'trackId']) && sheetIdOf(entry.sheetId) &&
      typeof entry.trackId === 'string' && TRACK_ID.test(entry.trackId) && !matches.has(entry.sheetId);
    if (!valid) refuse(`manual-match matches[${i}] is not a unique {sheetId, trackId}`);
    matches.set(entry.sheetId, entry.trackId);
  });
  const foldEagleOf = new Map();
  const foldTrackOf = new Map();
  doc.foldPairs.forEach((pair, i) => {
    const [, trackId, eagleId] = (typeof pair === 'string' && FOLD_PAIR.exec(pair)) || [];
    if (!trackId || foldEagleOf.has(trackId) || foldTrackOf.has(eagleId)) refuse(`manual-match foldPairs[${i}] is not a unique trackId:eagleId`);
    foldEagleOf.set(trackId, eagleId);
    foldTrackOf.set(eagleId, trackId);
  });
  return { matches, foldEagleOf, foldTrackOf };
}

/** Register rows grouped by sheet id with every alias name, plus rows whose id is unusable. */
function sheetProjectsOf(extract) {
  const own = key => (Object.hasOwn(extract.records, key) && Array.isArray(extract.records[key]) ? extract.records[key] : []);
  const aliases = new Map();
  for (const record of ALIAS_SOURCES.flatMap(own)) {
    const name = textOf(record.name);
    if (sheetIdOf(record.id) && name) addTo(aliases, sheetIdOf(record.id), normalized(name));
  }
  const byId = new Map();
  const bad = [];
  for (const record of own(REGISTER)) {
    const entry = { row: positionOf(record.ref), sheetId: sheetIdOf(record.id), sheetName: textOf(record.name) };
    if (!entry.sheetId) bad.push(entry);
    else if (byId.has(entry.sheetId)) byId.get(entry.sheetId).push(entry);
    else byId.set(entry.sheetId, [entry]);
  }
  // The extractor drops a register row whose id is not digits; it must still stop the crosswalk.
  const flags = Array.isArray(extract.flags) ? extract.flags : [];
  for (const flag of flags) {
    if (flag && flag.kind === 'badId' && flag.sheet === REGISTER_TAB) bad.push({ row: positionOf(flag), sheetId: null, sheetName: null });
  }
  return { byId, aliases, bad };
}

/** Live Track rows by id, Track name and Eagle id; Eagle names to Eagle ids; `eagle-<id>` twins by row id. */
function poolOf(rows) {
  const pool = { byId: new Map(), trackByName: new Map(), trackByEagleId: new Map(), eagleByName: new Map(), twins: new Map() };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string') continue;
    const eagleId = eagleIdOf(row.eagleId);
    const eagleName = textOf(row.sources?.eagle?.name);
    if (eagleId && eagleName) addTo(pool.eagleByName, normalized(eagleName), eagleId);
    if (isEagleOnlyProjectId(row.id)) {
      pool.twins.set(row.id, row);
      continue;
    }
    if (!row.sources?.track || !TRACK_ID.test(row.id)) continue;
    pool.byId.set(row.id, row);
    const trackName = textOf(row.sources.track.name);
    if (trackName) addTo(pool.trackByName, normalized(trackName), row.id);
    if (eagleId) addTo(pool.trackByEagleId, eagleId, row.id);
  }
  return pool;
}

const single = (ids, via, extra = {}) => (ids.size === 1
  ? { state: 'exact', via, targetId: [...ids][0], ...extra }
  : { state: ids.size ? 'ambiguous' : 'unmatched', via, ...extra });

/** Manual entry, else the Track name, else the Eagle name; a tier with two candidates is ambiguous. */
function matchOf(sheetId, names, pool, manual) {
  if (manual.matches.has(sheetId)) {
    const targetId = manual.matches.get(sheetId);
    return pool.byId.has(targetId) ? { state: 'manual', via: 'manual', targetId } : { state: 'unmatched', via: 'manual' };
  }
  const tracked = unionOf(names, pool.trackByName);
  if (tracked.size) return single(tracked, 'track');
  const eagleIds = unionOf(names, pool.eagleByName);
  if (eagleIds.size !== 1) return single(eagleIds, 'eagle');
  const [eagleId] = eagleIds;
  const fold = manual.foldTrackOf.get(eagleId);
  const targets = pool.trackByEagleId.get(eagleId) || new Set(fold && pool.byId.has(fold) ? [fold] : []);
  return single(targets, 'eagle', { eagleId });
}

/** The twin beside a target is `unfolded` when it is a fold-pair twin without `foldedInto`, or still DEMI-owned. */
function linkStateOf(match, pool, manual) {
  const target = pool.byId.get(match.targetId);
  const targetEagleId = eagleIdOf(target.eagleId);
  const eagleId = manual.foldEagleOf.get(match.targetId) || match.eagleId || targetEagleId;
  const twin = eagleId ? pool.twins.get(eagleOnlyProjectId(eagleId)) : null;
  const unfolded = Boolean(twin) && ((manual.foldTrackOf.has(eagleId) && !hasValue(twin.foldedInto)) || isDemiOwnedProject(twin));
  let { state } = match;
  if (eagleId && targetEagleId !== eagleId) state = 'unlinked';
  else if (unfolded) state = 'unfolded';
  return {
    ...match, state, eagleId, targetEagleId, twinBeside: Boolean(twin) && !unfolded,
    trackName: textOf(target.sources.track.name), eagleName: textOf(target.sources?.eagle?.name) || textOf(twin?.sources?.eagle?.name)
  };
}

/** One crosswalk row per register row, in sheet order, with state counts and `twinsBeside`. */
function crosswalkOf(sheet, pool, manual) {
  const rows = sheet.bad.map(entry => ({ ...entry, state: 'badId' }));
  for (const [sheetId, entries] of sheet.byId) {
    const names = new Set([...(sheet.aliases.get(sheetId) || []), ...entries.map(e => e.sheetName && normalized(e.sheetName))]);
    names.delete(null);
    const match = matchOf(sheetId, names, pool, manual);
    const linked = match.targetId ? linkStateOf(match, pool, manual) : match;
    entries.forEach(entry => rows.push({ ...entry, ...linked, state: entries.length > 1 ? 'collision' : linked.state }));
  }
  const claims = new Map();
  rows.filter(r => r.targetId).forEach(r => addTo(claims, r.targetId, r.sheetId));
  for (const row of rows) {
    if (row.targetId && claims.get(row.targetId).size > 1) row.state = 'collision';
  }
  rows.sort((a, b) => (a.row ?? Infinity) - (b.row ?? Infinity));
  const counts = Object.fromEntries(STATES.map(state => [state, rows.filter(r => r.state === state).length]));
  return { rows, counts, twinsBeside: new Set(rows.filter(r => r.twinBeside).map(r => r.targetId)).size };
}

const cellOf = (value) => {
  const text = value == null ? '' : String(value).replace(CONTROL, ' ');
  return `"${(FORMULA_START.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
};
const lineOf = cells => cells.map(cellOf).join(',');

function csvOf(rows, manualSha256) {
  return [lineOf(['manualSha256', manualSha256]), lineOf(COLUMNS), ...rows.map(r => lineOf(COLUMNS.map(c => r[c])))]
    .join('\r\n').concat('\r\n');
}

function cellsOf(line) {
  const cells = [];
  CSV_CELL.lastIndex = 0;
  while (CSV_CELL.lastIndex < line.length) {
    const match = CSV_CELL.exec(line);
    if (!match) refuse('crosswalk CSV is malformed');
    const text = match[1].replace(/""/g, '"');
    cells.push(text.startsWith("'") ? text.slice(1) : text);
  }
  return cells;
}

/**
 * Opens a crosswalk the operator sealed to the devbox, verifies the devbox signature over
 * {purpose: 'crosswalk', env, sha256}, and returns its exact and manual rows only.
 */
function readCrosswalk(sealed, { env, keys }) {
  const opened = openEnvelope(sealed, { purpose: PURPOSE, env, keyFingerprint: keys.fingerprint, privateKey: keys.rsa });
  const sha256 = sha256Hex(opened.plaintext);
  if (!verify(crypto.createPublicKey(keys.ed25519), { purpose: PURPOSE, env, sha256 }, opened.signature)) {
    refuse('crosswalk signature does not verify');
  }
  const text = opened.plaintext.toString('utf8');
  if (!text.endsWith('\r\n')) refuse('crosswalk CSV is malformed');
  const [head, columns, ...lines] = text.split('\r\n').slice(0, -1).map(cellsOf);
  const shaped = head && head.length === 2 && head[0] === 'manualSha256' && SHA256.test(head[1]) &&
    columns && columns.join() === COLUMNS.join() && lines.every(cells => cells.length === COLUMNS.length);
  if (!shaped) refuse('crosswalk CSV is malformed');
  const rows = lines.map(cells => Object.fromEntries(COLUMNS.map((c, i) => [c, cells[i]]))).filter(r => PASSING.has(r.state));
  return { sha256, manualSha256: head[1], rows };
}

const OPTIONS = Object.fromEntries([
  'env', 'extract', 'manual', 'expect-manual-sha256', 'devbox-key', 'operator-key', 'expect-operator-fingerprint', 'out-dir'
].map(name => [name, { type: 'string' }]));

function optionsOf(argv) {
  const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false });
  const missing = Object.keys(OPTIONS).filter(name => !values[name]);
  if (missing.length) refuse(`missing --${missing.join(', --')}`);
  if (!ENVS.includes(values.env)) refuse(`--env must be one of ${ENVS.join(', ')}`);
  return values;
}

function operatorOf(o) {
  const operator = publicKeysFromPem(readCapped(o['operator-key'], MAX_BYTES.key).toString('utf8'));
  const fingerprint = fingerprintOf({ rsa: operator.rsa });
  if (fingerprint !== o['expect-operator-fingerprint'].toLowerCase()) refuse('operator key fingerprint does not match');
  return { rsa: operator.rsa, fingerprint };
}

/** The manual-match file is parsed only once its plaintext SHA-256 equals `--expect-manual-sha256`. */
function openManual(o, keys) {
  const opened = openEnvelope(readCapped(o.manual, MAX_BYTES.manual), {
    purpose: 'manual-match', env: o.env, keyFingerprint: keys.fingerprint, privateKey: keys.rsa
  });
  const sha256 = sha256Hex(opened.plaintext);
  if (sha256 !== o['expect-manual-sha256'].toLowerCase()) refuse('manual-match SHA-256 does not match --expect-manual-sha256');
  return { ...manualOf(opened.plaintext), sha256 };
}

async function liveRows() {
  return (await projectsRepository.listVisible(systemAccess(), {})).items;
}

/** Resolves the exit code. @param {object} [deps] test seam {write, listRows} */
async function run(argv, { write = line => process.stdout.write(`${line}\n`), listRows = liveRows } = {}) {
  const o = optionsOf(argv);
  const keys = devboxKeysOf(readCapped(o['devbox-key'], MAX_BYTES.key).toString('utf8'));
  const operator = operatorOf(o);
  const manual = openManual(o, keys);
  const { extract } = openExtract(readCapped(o.extract, MAX_BYTES.extract), {
    env: o.env, keyFingerprint: keys.fingerprint, privateKey: keys.rsa
  });
  const result = crosswalkOf(sheetProjectsOf(extract), poolOf(await listRows()), manual);
  const csv = Buffer.from(csvOf(result.rows, manual.sha256));
  const sha256 = sha256Hex(csv);
  const signature = sign(keys.ed25519, { purpose: PURPOSE, env: o.env, sha256 });
  const blob = `${crypto.randomUUID()}.sealed.json`;
  fs.writeFileSync(path.join(o['out-dir'], blob), sealEnvelope(csv, {
    purpose: PURPOSE, env: o.env, keyFingerprint: operator.fingerprint, recipientKey: operator.rsa, signature
  }), { mode: 0o600, flag: 'wx' });
  STATES.forEach(state => write(`${state}=${result.counts[state]}`));
  write(`twinsBeside=${result.twinsBeside}`);
  write(`crosswalkCsvSha256=${sha256}`);
  write(`manualSha256=${manual.sha256}`);
  write(`blob=${blob}`);
  return result.rows.every(r => PASSING.has(r.state)) ? 0 : 1;
}

module.exports = { run, readCrosswalk, devboxKeysOf, normalized, COLUMNS, STATES };

if (require.main === module) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }, (err) => {
    logger.error('[works-crosswalk] failed', { error: err.message, stack: err.stack });
    process.exitCode = 1;
  });
}
