'use strict';

// The works loader's options, its test-only and file checks, the sealed inputs and the DEMI reads, through the
// repositories load-business-works.js passes in.

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const cosmos = require('../db/cosmos-nosql');
const { COSMOS_HOST, readCrosswalk } = require('./works-crosswalk');
const {
  MAX_BACKUP_BYTES, MAX_KEY_BYTES, devboxKeysFromPem, fingerprintOf, openExtract, publicKeysFromPem, readCapped
} = require('../utils/import-envelope');

const ENV = 'test';
const TEST_DATABASE = 'demi';
const MAX_BYTES = { extract: 64 * 1024 * 1024, crosswalk: 16 * 1024 * 1024, backup: MAX_BACKUP_BYTES, key: MAX_KEY_BYTES };
const INPUTS = ['extract', 'expect-sha256', 'crosswalk', 'expect-crosswalk-sha256', 'expect-manual-sha256', 'devbox-key',
  'expect-devbox-fingerprint', 'operator-key', 'expect-operator-fingerprint', 'out-dir'];
const LIVE = ['operator', 'run-ref', 'signoff-ref', 'expect-plan-sha256'];
const OPTIONS = { ...Object.fromEntries([...INPUTS, ...LIVE].map(name => [name, { type: 'string' }])), live: { type: 'boolean' }, help: { type: 'boolean' } };
const HELP = [
  'Usage: load-business-works.js --extract <sealed> --expect-sha256 <hex> --crosswalk <sealed> --expect-crosswalk-sha256 <hex>',
  '  --expect-manual-sha256 <hex> --devbox-key <pem> --expect-devbox-fingerprint <hex> --operator-key <pem>',
  '  --expect-operator-fingerprint <hex> --out-dir <dir>',
  '  [--live --operator <upn> --run-ref <id> --signoff-ref <id> --expect-plan-sha256 <hex>]',
  'Dry run by default; --live writes. Runs only where COSMOS_ENDPOINT is https://demi-cosmos-test and the database is demi.',
  'Before a run, the operator opens the crosswalk the devbox sealed to them, checks it, and seals it back to the devbox:',
  '  yarn works:extract seal --env test --purpose crosswalk --in <crosswalk.csv> --signature <signature file>',
  '    --recipient-key <devbox public keys pem> --expect-fingerprint <devbox fingerprint> --out <file>.sealed.json',
  'After a --live run, the operator reseals the works-backup in --out-dir to the devbox, for a rollback. Nothing plain is written:',
  '  yarn works:extract reseal --env test --purpose works-backup --in <backup>.sealed.json --key <operator key pem>',
  '    --passphrase-ref <ref> --expect-sha256 <backupSha256> --recipient-key <devbox public keys pem>',
  '    --expect-fingerprint <devbox fingerprint> --out <file>.sealed.json',
  '--live is refused from the command line until the rollback (W8b) can open the works-backup it writes.',
  '--signoff-ref must be one of the sign-off refs the extract carries, when it carries any. The batch records it to show',
  '  the load matched the extract; it is not proof that anyone signed off.',
  'The transitions tab joins as the sheet-to-master map defaults: refused (transitionJoinUndecided) until the business decides',
  'that column A holds the register id, so no sheet work takes a transition date from it.'
];

const refuse = (message) => { throw new Error(message); };

/** Test only: any Cosmos host but https://demi-cosmos-test, or another database, refuses in dry run and live alike. */
function testEnvironment(endpoint = process.env.COSMOS_ENDPOINT, database = cosmos.DATABASE_ID) {
  const url = URL.canParse(endpoint || '') ? new URL(endpoint) : null;
  const [, env] = (url && COSMOS_HOST.exec(url.hostname)) || [];
  if (!url || url.protocol !== 'https:' || env !== ENV) refuse('COSMOS_ENDPOINT is not https://demi-cosmos-test; this loader runs on test only');
  if (database !== TEST_DATABASE) refuse(`the Cosmos database is not ${TEST_DATABASE}`);
  return ENV;
}

function optionsOf(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false, tokens: true });
  } catch {
    refuse(`options are --${Object.keys(OPTIONS).join(', --')}`);
  }
  const names = parsed.tokens.filter(token => token.kind === 'option').map(token => token.name);
  if (new Set(names).size !== names.length) refuse('each option may be given once');
  const { values } = parsed;
  if (values.help) return values;
  const missing = [...INPUTS, ...(values.live ? LIVE : [])].filter(name => !values[name]);
  if (missing.length) refuse(`missing --${missing.join(', --')}`);
  return values;
}

const ownedBy = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();

const checkKeyStat = (stat) => {
  if ((stat.mode & 0o077) !== 0 || !ownedBy(stat)) refuse('the devbox key must be a 0600 file of this user');
};

/**
 * The devbox keys, from a 0600 file of this user in a 0700 folder of this user, opened once without following a
 * link; refused unless their fingerprint is `expectFingerprint`.
 */
const FOLDER_REFUSED = 'the devbox key folder must be 0700 and this user\'s';

/** The key folder, checked on the fstat of a descriptor opened without following a link. */
function checkKeyFolder(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  } catch {
    refuse(FOLDER_REFUSED);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || !ownedBy(stat)) refuse(FOLDER_REFUSED);
  } finally {
    fs.closeSync(fd);
  }
}

function devboxKeysOf(file, expectFingerprint) {
  checkKeyFolder(path.dirname(path.resolve(file)));
  const pem = readCapped(file, MAX_BYTES.key, { label: 'the devbox key', check: checkKeyStat });
  const keys = devboxKeysFromPem(pem.toString('utf8'));
  if (keys.fingerprint !== String(expectFingerprint).toLowerCase()) refuse('fingerprint of the devbox key does not match');
  return keys;
}

function openInputs(o, env) {
  const keys = devboxKeysOf(o['devbox-key'], o['expect-devbox-fingerprint']);
  const operator = publicKeysFromPem(readCapped(o['operator-key'], MAX_BYTES.key).toString('utf8')).rsa;
  const recipient = { rsa: operator, fingerprint: fingerprintOf({ rsa: operator }) };
  if (recipient.fingerprint !== o['expect-operator-fingerprint'].toLowerCase()) refuse('fingerprint of operator key does not match');
  const opened = openExtract(readCapped(o.extract, MAX_BYTES.extract), {
    env, keyFingerprint: keys.fingerprint, privateKey: keys.rsa, expectSha256: o['expect-sha256']
  });
  const crosswalk = readCrosswalk(readCapped(o.crosswalk, MAX_BYTES.crosswalk), {
    env, keys, expectExtractSha256: opened.sha256, expectManualSha256: o['expect-manual-sha256']
  });
  if (crosswalk.sha256 !== o['expect-crosswalk-sha256'].toLowerCase()) refuse('crosswalk SHA-256 does not match --expect-crosswalk-sha256');
  const sheetIds = crosswalk.rows.map(row => Number(row.sheetId));
  if (new Set(sheetIds).size !== sheetIds.length) refuse('the crosswalk names one sheet number twice');
  return { keys, recipient, opened, crosswalk };
}

/** The stored state of the crosswalk's projects, read as check-business-works-parity.js reads it. */
async function readStored(demi, projectIds) {
  const state = { rows: new Map(), works: new Map(), markers: new Map(), commentPeriods: new Map(), trackPublic: new Map() };
  for (const projectId of projectIds) {
    const row = await demi.project(projectId);
    if (!row) continue;
    state.rows.set(projectId, row);
    state.works.set(projectId, await demi.works(projectId));
    const marker = await demi.marker(projectId);
    if (marker) state.markers.set(projectId, marker);
    state.commentPeriods.set(projectId, await demi.commentPeriods(projectId));
    state.trackPublic.set(projectId, await demi.trackPublic(row));
  }
  return state;
}

/** Project ids other than `projectId` that hold each planned external id, read before the plan is hashed. */
async function heldElsewhere(demi, plan) {
  const held = new Set();
  for (const entry of plan.entries.filter(one => one.action === 'addExternalId')) {
    const holders = await demi.externalIdHolders(entry.pair.system, entry.pair.value);
    if (holders.some(id => String(id) !== String(entry.projectId))) held.add(entry);
  }
  return held;
}

module.exports = { ENV, MAX_BYTES, HELP, optionsOf, testEnvironment, devboxKeysOf, openInputs, readStored, heldElsewhere };
