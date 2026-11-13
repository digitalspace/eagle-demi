'use strict';

// Devbox tool (`scripts/demi-devbox.sh run --env <env> -- node src/scripts/works-crosswalk.js <options>`): nothing
// decrypted is written; the CSV leaves only signed and sealed to the operator, and exit 1 still writes it.

const crypto = require('crypto');
const { parseArgs } = require('util');
const { systemAccess } = require('../helpers/access-sql');
const projectsRepository = require('../repositories/projects');
const { eagleOnlyProjectId, isEagleOnlyProjectId, isDemiOwnedProject } = require('../merge/project');
const {
  devboxKeysFromPem, publicKeysFromPem, readCapped, fingerprintOf, openEnvelope, openExtract, sha256Hex, verify, writeSealed
} = require('../utils/import-envelope');
const { logger } = require('../utils/logger');

const ENVS = ['test', 'prod'];
const PURPOSE = 'crosswalk';
const STATES = ['exact', 'manual', 'ambiguous', 'unmatched', 'unlinked', 'unfolded', 'collision', 'badId', 'unnamedRow'];
const PASSING = new Set(['exact', 'manual']);
const COLUMNS = ['row', 'sheetId', 'sheetName', 'state', 'via', 'targetId', 'trackName', 'eagleName', 'eagleId', 'targetEagleId'];
const HEADER = ['extractSha256', 'manualSha256'];
const REGISTER = 'projects';
const REGISTER_TAB = 'Projects';
// The extractor drops a register row with either flag; each must still stop the crosswalk.
const REGISTER_FLAGS = new Set(['badId', 'unnamedRow']);
// Files 02-06: every name they give a register id is an alias of that id.
const ALIAS_SOURCES = ['amendments', 'suspensions', 'extensions', 'orderVariations', 'commentPeriods'];
const MAX_BYTES = { extract: 64 * 1024 * 1024, manual: 1024 * 1024, key: 64 * 1024 };
const MAX_NAME = 500;
const MAX_MANUAL_ENTRIES = 1000;
// `'` too, so a cell that already starts with one survives the strip in readCrosswalk.
const FORMULA_START = /^[=+\-@']/;
// Zero-width space, line and paragraph separators, BOM; ZWJ and ZWNJ stay, since names can need them.
const INVISIBLE = [0x200b, 0x2028, 0x2029, 0xfeff].map(code => String.fromCharCode(code)).join('');
// C0 and C1 controls, and bidi controls that could make a reviewer read a cell other than it is.
const CONTROL = new RegExp(`[\\p{Cc}\\p{Bidi_Control}${INVISIBLE}]`, 'gu');
// scripts/works-import/surrogates.js draws test surrogates from this range.
const SURROGATE_RANGE = [100000, 999999];
const COSMOS_HOST = /^demi-cosmos-(test|prod)\.documents\.azure\.com$/;
const CSV_CELL = /"((?:[^"]|"")*)"(,?)/y;
const EAGLE_ID = /^[0-9a-f]{24}$/;
const TRACK_ID = /^[1-9]\d{0,9}$/;
const FOLD_PAIR = /^([1-9]\d{0,9}):([0-9a-f]{24})$/;
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
  doc.matches.forEach((entry, index) => {
    const valid = keysAre(entry, ['sheetId', 'trackId']) && sheetIdOf(entry.sheetId) &&
      typeof entry.trackId === 'string' && TRACK_ID.test(entry.trackId) && !matches.has(entry.sheetId);
    if (!valid) refuse(`manual-match matches[${index}] is not a unique {sheetId, trackId}`);
    matches.set(entry.sheetId, { trackId: entry.trackId, index });
  });
  const foldEagleOf = new Map();
  const foldTrackOf = new Map();
  const foldIndex = new Map();
  doc.foldPairs.forEach((pair, i) => {
    const [, trackId, eagleId] = (typeof pair === 'string' && FOLD_PAIR.exec(pair)) || [];
    if (!trackId || foldEagleOf.has(trackId) || foldTrackOf.has(eagleId)) refuse(`manual-match foldPairs[${i}] is not a unique trackId:eagleId`);
    foldEagleOf.set(trackId, eagleId);
    foldTrackOf.set(eagleId, trackId);
    foldIndex.set(trackId, i);
  });
  return { matches, foldEagleOf, foldTrackOf, foldIndex };
}

/** Register rows grouped by sheet id with every alias name, plus rows the extractor dropped or whose id is unusable. */
function sheetProjectsOf(extract) {
  const own = key => (Object.hasOwn(extract.records, key) && Array.isArray(extract.records[key]) ? extract.records[key] : []);
  const register = own(REGISTER);
  if (register.length === 0) refuse('extract holds no register rows');
  const aliases = new Map();
  for (const record of ALIAS_SOURCES.flatMap(own)) {
    const name = textOf(record.name);
    if (sheetIdOf(record.id) && name) addTo(aliases, sheetIdOf(record.id), normalized(name));
  }
  const byId = new Map();
  const dropped = [];
  for (const record of register) {
    const entry = { row: positionOf(record.ref), sheetId: sheetIdOf(record.id), sheetName: textOf(record.name) };
    if (!entry.sheetId) dropped.push({ ...entry, state: 'badId' });
    else if (byId.has(entry.sheetId)) byId.get(entry.sheetId).push(entry);
    else byId.set(entry.sheetId, [entry]);
  }
  const files = new Set(register.map(record => record.ref?.file).filter(file => typeof file === 'string'));
  for (const flag of Array.isArray(extract.flags) ? extract.flags : []) {
    const onRegister = flag && files.has(flag.file) && flag.sheet === REGISTER_TAB && REGISTER_FLAGS.has(flag.kind);
    if (onRegister) dropped.push({ row: positionOf(flag), sheetId: null, sheetName: null, state: flag.kind });
  }
  return { byId, aliases, dropped };
}

/**
 * Refuses a manual entry for an id the register lacks, and on test one outside the surrogate range: there the
 * register holds surrogates, and a real register number must never reach the devbox.
 */
function checkManualIds(manual, sheet, numbersReal) {
  const hint = numbersReal ? '' : '; this extract holds surrogate ids, so key the file by surrogate, translated with ' +
    'the surrogate map on the operator machine, and never put a real register number on the devbox';
  for (const [sheetId, { index }] of manual.matches) {
    if (!numbersReal && (sheetId < SURROGATE_RANGE[0] || sheetId > SURROGATE_RANGE[1])) {
      refuse(`manual-match matches[${index}] is not a surrogate id${hint}`);
    }
    if (!sheet.byId.has(sheetId)) refuse(`manual-match matches[${index}] names a sheet id the register does not hold${hint}`);
  }
}

/** Refuses a fold pair whose Track id names no live project row. */
function checkFoldPairs(manual, pool) {
  for (const [trackId, index] of manual.foldIndex) {
    if (!pool.byId.has(trackId)) refuse(`manual-match foldPairs[${index}] names a Track id with no live project row`);
  }
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
  // An unset COSMOS_ENDPOINT or a failed client must not read as every row unmatched.
  if (pool.byId.size === 0) refuse('no live Track project rows were read; check COSMOS_ENDPOINT and the Cosmos client');
  return pool;
}

const single = (ids, via, extra = {}) => (ids.size === 1
  ? { state: 'exact', via, targetId: [...ids][0], ...extra }
  : { state: ids.size ? 'ambiguous' : 'unmatched', via, ...extra });

/** Manual entry, else the Track name, else the Eagle name; a tier with two candidates is ambiguous. */
function matchOf(sheetId, names, pool, manual) {
  if (manual.matches.has(sheetId)) {
    const { trackId } = manual.matches.get(sheetId);
    return pool.byId.has(trackId) ? { state: 'manual', via: 'manual', targetId: trackId } : { state: 'unmatched', via: 'manual' };
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

/** A twin beside the target is `unfolded` when it is a fold-pair twin not folded into that pair's Track row, or DEMI-owned. */
function linkStateOf(match, pool, manual) {
  const target = pool.byId.get(match.targetId);
  const targetEagleId = eagleIdOf(target.eagleId);
  const eagleId = manual.foldEagleOf.get(match.targetId) || match.eagleId || targetEagleId;
  const twin = eagleId ? pool.twins.get(eagleOnlyProjectId(eagleId)) : null;
  const fold = manual.foldTrackOf.get(eagleId);
  const unfolded = Boolean(twin) && ((fold && String(twin.foldedInto ?? '') !== fold) || isDemiOwnedProject(twin));
  let { state } = match;
  if ((eagleId && targetEagleId !== eagleId) || (fold && fold !== match.targetId)) state = 'unlinked';
  else if (unfolded) state = 'unfolded';
  return {
    ...match, state, eagleId, targetEagleId, twinBeside: Boolean(twin) && !unfolded,
    trackName: textOf(target.sources.track.name), eagleName: textOf(target.sources?.eagle?.name) || textOf(twin?.sources?.eagle?.name)
  };
}

/** One crosswalk row per register row, in sheet order, with state counts and `twinsBeside`. */
function crosswalkOf(sheet, pool, manual) {
  const rows = [...sheet.dropped];
  for (const [sheetId, entries] of sheet.byId) {
    const names = new Set([...(sheet.aliases.get(sheetId) || []), ...entries.map(e => e.sheetName && normalized(e.sheetName))]);
    names.delete(null);
    names.delete('');
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
  const besides = rows.filter(r => r.twinBeside && PASSING.has(r.state)).map(r => r.targetId);
  return { rows, counts, twinsBeside: new Set(besides).size };
}

const cellOf = (value) => {
  const text = value == null ? '' : String(value).replace(CONTROL, ' ');
  // Spreadsheets skip leading blanks before reading a formula.
  return `"${(FORMULA_START.test(text.trimStart()) ? `'${text}` : text).replace(/"/g, '""')}"`;
};
const lineOf = cells => cells.map(cellOf).join(',');

function csvOf(rows, hashes) {
  return [lineOf(HEADER.flatMap(key => [key, hashes[key]])), lineOf(COLUMNS), ...rows.map(r => lineOf(COLUMNS.map(c => r[c])))]
    .join('\r\n').concat('\r\n');
}

function cellsOf(line) {
  const cells = [];
  CSV_CELL.lastIndex = 0;
  let comma = ',';
  while (CSV_CELL.lastIndex < line.length) {
    const match = comma ? CSV_CELL.exec(line) : null;
    if (!match) refuse('crosswalk CSV is malformed');
    comma = match[2];
    const text = match[1].replace(/""/g, '"');
    cells.push(text.startsWith("'") ? text.slice(1) : text);
  }
  if (comma) refuse('crosswalk CSV is malformed');
  return cells;
}

/**
 * Opens a crosswalk the operator sealed to the devbox, verifies the devbox signature over
 * {purpose: 'crosswalk', env, sha256} and the input hashes in its header, and returns its exact and manual rows only.
 */
function readCrosswalk(sealed, { env, keys, expectExtractSha256, expectManualSha256 }) {
  const opened = openEnvelope(sealed, { purpose: PURPOSE, env, keyFingerprint: keys.fingerprint, privateKey: keys.rsa });
  const sha256 = sha256Hex(opened.plaintext);
  if (!verify(crypto.createPublicKey(keys.ed25519), { purpose: PURPOSE, env, sha256 }, opened.signature)) {
    refuse('crosswalk signature does not verify');
  }
  const text = opened.plaintext.toString('utf8');
  if (!text.endsWith('\r\n')) refuse('crosswalk CSV is malformed');
  const [head, columns, ...lines] = text.split('\r\n').slice(0, -1).map(cellsOf);
  const shaped = head && head.length === 4 && head[0] === HEADER[0] && head[2] === HEADER[1] &&
    SHA256.test(head[1]) && SHA256.test(head[3]) && columns && columns.join() === COLUMNS.join() &&
    lines.every(cells => cells.length === COLUMNS.length);
  if (!shaped) refuse('crosswalk CSV is malformed');
  if (head[1] !== String(expectExtractSha256).toLowerCase()) refuse('crosswalk was not built from the expected extract');
  if (head[3] !== String(expectManualSha256).toLowerCase()) refuse('crosswalk was not built from the expected manual-match file');
  const rows = lines.map(cells => Object.fromEntries(COLUMNS.map((c, i) => [c, cells[i]]))).filter(r => PASSING.has(r.state));
  return { sha256, extractSha256: head[1], manualSha256: head[3], rows };
}

const OPTIONS = Object.fromEntries([
  'env', 'extract', 'expect-extract-sha256', 'manual', 'expect-manual-sha256', 'devbox-key', 'operator-key',
  'expect-operator-fingerprint', 'out-dir'
].map(name => [name, { type: 'string' }]));

/** The environment named by the Cosmos host the rows come from; demi-run binds only COSMOS_ENDPOINT. */
function cosmosEnvironment() {
  const host = URL.canParse(process.env.COSMOS_ENDPOINT || '') ? new URL(process.env.COSMOS_ENDPOINT).hostname : '';
  const [, env] = COSMOS_HOST.exec(host) || [];
  return env || refuse('COSMOS_ENDPOINT names no demi-cosmos-test or demi-cosmos-prod account');
}

function optionsOf(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }));
  } catch {
    refuse(`options are --${Object.keys(OPTIONS).join(', --')}, each with one value`);
  }
  const missing = Object.keys(OPTIONS).filter(name => !values[name]);
  if (missing.length) refuse(`missing --${missing.join(', --')}`);
  if (!ENVS.includes(values.env)) refuse(`--env must be one of ${ENVS.join(', ')}`);
  // --env picks the keys and the signed statement; the rows come from the account COSMOS_ENDPOINT names.
  if (values.env !== cosmosEnvironment()) refuse(`--env ${values.env} does not match the COSMOS_ENDPOINT account`);
  return values;
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
  const keys = devboxKeysFromPem(readCapped(o['devbox-key'], MAX_BYTES.key).toString('utf8'));
  // RSA only, as `extract.js keygen` prints it and `extract.js open` rebuilds it.
  const operator = publicKeysFromPem(readCapped(o['operator-key'], MAX_BYTES.key).toString('utf8')).rsa;
  const operatorFingerprint = fingerprintOf({ rsa: operator });
  if (operatorFingerprint !== o['expect-operator-fingerprint'].toLowerCase()) refuse('fingerprint of operator key does not match');
  const manual = openManual(o, keys);
  const { extract, numbersReal, sha256: extractSha256 } = openExtract(readCapped(o.extract, MAX_BYTES.extract), {
    env: o.env, keyFingerprint: keys.fingerprint, privateKey: keys.rsa, expectSha256: o['expect-extract-sha256']
  });
  const sheet = sheetProjectsOf(extract);
  checkManualIds(manual, sheet, numbersReal === true);
  const pool = poolOf(await listRows());
  checkFoldPairs(manual, pool);
  const result = crosswalkOf(sheet, pool, manual);
  const csv = Buffer.from(csvOf(result.rows, { extractSha256, manualSha256: manual.sha256 }));
  const { name: blob, sha256 } = writeSealed(o['out-dir'], csv, {
    purpose: PURPOSE, env: o.env, recipient: { rsa: operator, fingerprint: operatorFingerprint }, signingKey: keys.ed25519
  });
  STATES.forEach(state => write(`${state}=${result.counts[state]}`));
  write(`twinsBeside=${result.twinsBeside}`);
  write(`crosswalkCsvSha256=${sha256}`);
  write(`manualSha256=${manual.sha256}`);
  write(`blob=${blob}`);
  return result.rows.every(r => PASSING.has(r.state)) ? 0 : 1;
}

module.exports = { run, readCrosswalk, COLUMNS, COSMOS_HOST };

if (require.main === module) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }, (err) => {
    logger.error('[works-crosswalk] failed', { error: err.message, stack: err.stack });
    process.exitCode = 1;
  });
}
