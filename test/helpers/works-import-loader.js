'use strict';

// The loader tests' harness: made-up keys, sealed inputs on disk, a fake DEMI and the run helpers.

const test = require('node:test');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('../../src/scripts/load-business-works');
const { OVERRIDE_MARKER_ID } = require('../../src/domain/work-model');
const { keptFrom } = require('../../src/repositories/works');
const { devboxKeysFromPem, fingerprintOf, openEnvelope, sealEnvelope, sha256Hex, sign } = require('../../src/utils/import-envelope');
const { COLUMNS } = require('../../src/scripts/works-crosswalk');
const { CATALOG, PHASES, PROJECT, NUMBER, fakeLists, register, amendment, trackWork } = require('./works-import-fakes');

const ENV = 'test';
const T0 = Date.parse('2026-11-13T18:00:00Z');
const pemOf = (key, type) => key.export({ type, format: 'pem' });
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
const ed = crypto.generateKeyPairSync('ed25519');
const operator = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
const keys = devboxKeysFromPem(pemOf(rsa.privateKey, 'pkcs8') + pemOf(ed.privateKey, 'pkcs8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'load-business-works-'));
const endpoint = process.env.COSMOS_ENDPOINT;
const testHost = 'https://demi-cosmos-test.documents.azure.com:443/';
process.env.COSMOS_ENDPOINT = testHost;
test.after(() => {
  if (endpoint === undefined) delete process.env.COSMOS_ENDPOINT;
  else process.env.COSMOS_ENDPOINT = endpoint;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const TRACK = [trackWork(43, { startDate: '2023-03-01', decisionDate: '2023-11-07' }), trackWork(45, { startDate: '2015-03-01', decisionDate: '2015-05-07' })];

/** A fake DEMI: works keyed by id with etags from each save, one project row, and every derive call. */
function fakeDemi() {
  const docs = new Map(TRACK.map(doc => [doc.id, { ...doc, _etag: '"t"' }]));
  const state = { saves: 0, derived: [], docs, projectFields: [], row: { id: PROJECT, externalIds: [], reviewExtensions: [], reviewSuspensions: [], _etag: '"r"' } };
  const keep = (field, value) => {
    state.projectFields.push(field);
    state.row = { ...state.row, [field]: [...(state.row[field] || []), value], _etag: `"r${n += 1}"` };
    return state.row._etag;
  };
  let n = 0;
  // As works.save: an update keeps `source`, `owner` and the adopt fields of the document it replaces.
  const saveWork = async (doc, { owner, existing } = {}) => {
    const stored = { ...(existing ? keptFrom(doc, existing, owner) : doc), _etag: `"w${n += 1}"` };
    docs.set(doc.id, stored);
    state.saves += 1;
    return { status: 'written', etag: stored._etag };
  };
  return Object.assign(state, {
    worksCatalog: async () => CATALOG,
    phaseCatalog: async () => PHASES,
    works: async () => [...docs.values()].filter(doc => doc.id !== OVERRIDE_MARKER_ID),
    marker: async () => docs.get(OVERRIDE_MARKER_ID) || null,
    project: async id => (id === PROJECT ? { ...state.row } : null),
    externalIdHolders: async () => [],
    commentPeriods: async () => [],
    trackPublic: async () => [],
    saveWork,
    tombstone: async doc => saveWork({ ...doc, deleted: true }),
    addExternalId: async (_id, pair) => ({ status: 'set', etag: keep('externalIds', pair) }),
    appendHistory: async (_id, field, entry) => ({ status: 'appended', etag: keep(field, entry) }),
    closeHistory: async (_id, field, entryId, effectiveTo) => {
      state.projectFields.push(field);
      state.row = { ...state.row, [field]: state.row[field].map(one => (one.id === entryId ? { ...one, effectiveTo } : one)), _etag: `"r${n += 1}"` };
      return { status: 'closed', etag: state.row._etag };
    },
    patchDerived: async (id) => { state.derived.push(id); return { status: 'patched', etag: '"d"' }; }
  });
}

const toDevbox = (text, purpose, extra = {}) => sealEnvelope(Buffer.from(text), { purpose, env: ENV, keyFingerprint: keys.fingerprint, recipientKey: rsa.publicKey, ...extra });
/** The devbox key, 0600 in its own 0700 folder, as works-import-key.js writes it. */
function keyFile() {
  const dir = fs.mkdtempSync(path.join(tmp, 'key-'));
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'devbox-key.pem');
  fs.writeFileSync(file, pemOf(rsa.privateKey, 'pkcs8') + pemOf(ed.privateKey, 'pkcs8'), { mode: 0o600 });
  return file;
}

const cell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;

/** Sealed extract and signed crosswalk on disk, and the argv of a dry run over them. */
const NO_SIGNOFF = { staffIncluded: false, numbersReal: false, signoffRefs: { keepStaff: null, keepNumbers: null } };

function inputs({ records = { projects: [register], amendments: [amendment(1, '2023-06-01', '2023-11-07')] }, crosswalkRows, flags = NO_SIGNOFF, extractEnv = ENV } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'in-'));
  const outDir = fs.mkdtempSync(path.join(tmp, 'out-'));
  const extractText = JSON.stringify({ schemaVersion: 1, env: ENV, ...flags, records });
  const extractSha256 = sha256Hex(Buffer.from(extractText));
  const manualSha256 = sha256Hex(Buffer.from('manual'));
  const rows = crosswalkRows || [{ row: 5, sheetId: NUMBER, state: 'exact', targetId: PROJECT }];
  const csv = [['extractSha256', extractSha256, 'manualSha256', manualSha256], COLUMNS, ...rows.map(r => COLUMNS.map(c => r[c]))]
    .map(line => line.map(cell).join(',')).join('\r\n').concat('\r\n');
  const crosswalkSha256 = sha256Hex(Buffer.from(csv));
  const signature = sign(keys.ed25519, { purpose: 'crosswalk', env: ENV, sha256: crosswalkSha256 });
  const file = (name, data) => { fs.writeFileSync(path.join(dir, name), data); return path.join(dir, name); };
  const argv = [
    '--extract', file('extract.sealed.json', toDevbox(extractText, 'extract', { ...flags, env: extractEnv })),
    '--expect-sha256', extractSha256,
    '--crosswalk', file('crosswalk.sealed.json', toDevbox(csv, 'crosswalk', { signature })),
    '--expect-crosswalk-sha256', crosswalkSha256, '--expect-manual-sha256', manualSha256,
    '--devbox-key', keyFile(), '--expect-devbox-fingerprint', keys.fingerprint,
    '--operator-key', file('operator.pub.pem', pemOf(operator.publicKey, 'spki')),
    '--expect-operator-fingerprint', fingerprintOf({ rsa: operator.publicKey }), '--out-dir', outDir
  ];
  return { argv, outDir, dir };
}

async function load(argv, demi = fakeDemi(), at = T0) {
  const lines = [];
  await run(argv, { write: line => lines.push(line), demi, now: () => at });
  const value = key => (lines.find(line => line.startsWith(`${key}=`)) || '').slice(key.length + 1);
  return { lines, value, demi };
}

/** The sealed dry-run report, opened as the operator opens it. */
const reportOf = (outDir, blob) => JSON.parse(openEnvelope(fs.readFileSync(path.join(outDir, blob)), {
  purpose: 'works-report', env: ENV, keyFingerprint: fingerprintOf({ rsa: operator.publicKey }), privateKey: operator.privateKey
}).plaintext);

const liveArgs = (planSha256, { signoff = 'so-1' } = {}) =>
  ['--live', '--operator', 'operator-upn', '--run-ref', 'run-1', ...(signoff ? ['--signoff-ref', signoff] : []), '--expect-plan-sha256', planSha256];

const STAFF = { staffIncluded: true, numbersReal: true, signoffRefs: { keepStaff: 'so-staff', keepNumbers: 'so-numbers' } };
const staffed = () => inputs({ flags: STAFF, records: { projects: [{ ...register, epd: 'staff-value-1', lead: 'staff-value-2', notes: 'staff-value-3' }],
  amendments: [amendment(1, '2023-06-01', '2023-11-07')] } });

/** A dry run then a live run at `at` on `demi`; resolves the live run's output. */
async function liveRun(given, demi, { signoff, at = T0 } = {}) {
  const planSha256 = (await load(given.argv, demi, at)).value('planSha256');
  return load([...given.argv, ...liveArgs(planSha256, { signoff })], demi, at);
}

async function liveLoad(t, given, signoff) {
  fakeLists(t);
  const demi = fakeDemi();
  await liveRun(given, demi, { signoff });
  return demi;
}

module.exports = {
  ENV, T0, PROJECT, NUMBER, TRACK, keys, operator, testHost, fakeDemi, inputs, keyFile, load, reportOf, liveArgs, STAFF, staffed, liveRun, liveLoad
};
