'use strict';

// Devbox, test only: `scripts/demi-devbox.sh run --env test -- node src/scripts/check-business-works-parity.js <options>`.
// Read-only; stdout holds counts only, and listed items go sealed to the operator, as sourceKeys hold sheet numbers.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { systemAccess, PUBLIC_ROLES } = require('../helpers/access-sql');
const projectsRepository = require('../repositories/projects');
const worksRepository = require('../repositories/works');
const commentPeriodsRepository = require('../repositories/comment-periods');
const listsRepository = require('../repositories/lists');
const phaseCatalog = require('../domain/phase-catalog');
const { mapBusinessWorks } = require('../domain/business-works-map');
const { idOf } = require('../domain/extensions');
const { EXTENSION_LIST_FIELDS } = require('../ownership/project');
const {
  DATE_KEYS, OVERRIDE_MARKER_ID, OVERRIDE_TYPES, dayOf, listOf, overrideBoundaryOf, settledBefore, sourceOf,
  untilTrackHidden, workTypeCodeOf
} = require('../domain/work-model');
const {
  devboxKeysFromPem, fingerprintOf, openExtract, publicKeysFromPem, readCapped, sealEnvelope, sha256Hex, sign
} = require('../utils/import-envelope');
const { COSMOS_HOST, readCrosswalk } = require('./works-crosswalk');
const { logger } = require('../utils/logger');

const ENV = 'test';
// `extract.js open --purpose report` reads it back.
const REPORT_PURPOSE = 'report';
const OPTIONS = ['extract', 'expect-extract-sha256', 'crosswalk', 'expect-manual-sha256', 'devbox-key', 'operator-key',
  'expect-operator-fingerprint', 'out-dir'];
const MAX_BYTES = { extract: 64 * 1024 * 1024, crosswalk: 4 * 1024 * 1024, key: 64 * 1024 };
const COUNTS = ['mismatch', 'duplicateSourceKey', 'duplicateExternalId', 'danglingEagleItemId', 'commentPeriodMissing',
  'commentPeriodNotPublic', 'undatedDates', 'hiddenDrift', 'untilTrackHidden', 'sheetHiddenByMovedBoundary', 'overrideHeldOff'];
const FAILING = ['mismatch', 'duplicateSourceKey', 'duplicateExternalId'];
const SKIPPED_PATHS = new Set(['provenance', 'sourceRef', 'links', 'undated']);

const refuse = (message) => { throw new Error(message); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Options, refused unless COSMOS_ENDPOINT is the test account: Daniel's rule keeps this check off prod. */
function optionsOf(argv, endpoint = process.env.COSMOS_ENDPOINT) {
  const host = URL.canParse(endpoint || '') ? new URL(endpoint).hostname : '';
  const [, env] = COSMOS_HOST.exec(host) || [];
  if (env !== ENV) refuse('COSMOS_ENDPOINT must name demi-cosmos-test');
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: Object.fromEntries(OPTIONS.map(name => [name, { type: 'string' }])), strict: true }));
  } catch {
    refuse(`options are --${OPTIONS.join(', --')}, each with one value`);
  }
  const missing = OPTIONS.filter(name => !values[name]);
  if (missing.length) refuse(`missing --${missing.join(', --')}`);
  return values;
}

/** The keys, the decrypted extract and the crosswalk Map of register number to project id; nothing touches disk. */
function openInputs(o) {
  const keys = devboxKeysFromPem(readCapped(o['devbox-key'], MAX_BYTES.key).toString('utf8'));
  const operator = publicKeysFromPem(readCapped(o['operator-key'], MAX_BYTES.key).toString('utf8')).rsa;
  if (fingerprintOf({ rsa: operator }) !== o['expect-operator-fingerprint'].toLowerCase()) refuse('fingerprint of operator key does not match');
  const { extract, sha256 } = openExtract(readCapped(o.extract, MAX_BYTES.extract), {
    env: ENV, keyFingerprint: keys.fingerprint, privateKey: keys.rsa, expectSha256: o['expect-extract-sha256']
  });
  const { rows } = readCrosswalk(readCapped(o.crosswalk, MAX_BYTES.crosswalk), {
    env: ENV, keys, expectExtractSha256: sha256, expectManualSha256: o['expect-manual-sha256']
  });
  return { keys, operator, extract, crosswalk: new Map(rows.map(row => [Number(row.sheetId), row.targetId])) };
}

/** Signs the report with the devbox key and seals it to the operator under a random name; returns the name and hash. */
function writeReport(report, { keys, operator, outDir }) {
  const plaintext = Buffer.from(JSON.stringify(report));
  const sha256 = sha256Hex(plaintext);
  const signature = sign(keys.ed25519, { purpose: REPORT_PURPOSE, env: ENV, sha256 });
  const blob = `${crypto.randomUUID()}.sealed.json`;
  fs.writeFileSync(path.join(outDir, blob), sealEnvelope(plaintext, {
    purpose: REPORT_PURPOSE, env: ENV, keyFingerprint: fingerprintOf({ rsa: operator }), recipientKey: operator, signature
  }), { mode: 0o600, flag: 'wx' });
  return { blob, sha256 };
}

/** Every date a work holds by path; list items key on their id, so a reorder is no change. */
function datesOf(value, path = '', out = new Map()) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => datesOf(item, `${path}[${(isObject(item) && (item.id ?? item.catalogId)) ?? i}]`, out));
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (DATE_KEYS.includes(key)) out.set(`${path}.${key}`, dayOf(child) ?? null);
      else if (!SKIPPED_PATHS.has(key) && typeof child === 'object') datesOf(child, `${path}.${key}`, out);
    }
  }
  return out;
}

function changedDates(sheet, stored) {
  const [a, b] = [datesOf(sheet), datesOf(stored)];
  return [...new Set([...a.keys(), ...b.keys()])].filter(path => a.get(path) !== b.get(path)).sort();
}

const childrenOf = (work, key) => listOf(work.phases).flatMap(phase => listOf(phase && phase[key])).filter(isObject);
const groupBy = (items, keyOf) => items.reduce((map, item) => map.set(keyOf(item), [...(map.get(keyOf(item)) || []), item]), new Map());

function makeTally() {
  const counts = Object.fromEntries(COUNTS.map(name => [name, 0]));
  const items = [];
  const add = (name, fields) => {
    counts[name]++;
    items.push({ list: name, ...fields });
  };
  return { counts, items, add };
}

/** Stored sheet works against the extract by sourceKey: dates, works missing either side, repeated keys. */
function checkWorks(tally, { all, fresh, sheetWorks, markers }) {
  const mapped = new Map(all.works.map(work => [work.sourceKey, work]));
  const repeated = new Set(all.report.filter(entry => entry.reason === 'duplicateKey').map(entry => entry.sourceKey));
  repeated.forEach(sourceKey => tally.add('duplicateSourceKey', { side: 'sheet', sourceKey }));
  const stored = groupBy(sheetWorks, work => work.sourceKey);
  for (const [sourceKey, works] of stored) {
    if (works.length > 1) tally.add('duplicateSourceKey', { side: 'stored', sourceKey, workIds: works.map(work => work.id).join(',') });
    for (const work of works) {
      const sheet = mapped.get(sourceKey);
      if (!sheet) {
        if (!repeated.has(sourceKey)) tally.add('mismatch', { reason: 'notInSheet', project: work.projectId, workId: work.id, sourceKey });
        continue;
      }
      if (String(sheet.projectId) !== String(work.projectId)) tally.add('mismatch', { reason: 'projectChanged', workId: work.id, sourceKey });
      const paths = changedDates(sheet, work);
      if (paths.length) tally.add('mismatch', { reason: 'dateChanged', project: work.projectId, workId: work.id, sourceKey, paths: paths.join(',') });
    }
  }
  // A marker's trackAlive and fresh untilTrack keys go under hiddenDrift, not here.
  const explained = new Set(fresh.markers.flatMap(marker => [...marker.untilTrack, ...listOf(markers.get(String(marker.projectId))?.trackAlive).map(pair => pair.sourceKey)]));
  for (const work of fresh.works.filter(one => !stored.has(one.sourceKey) && !explained.has(one.sourceKey))) {
    tally.add('mismatch', { reason: 'notStored', project: work.projectId, sourceKey: work.sourceKey });
  }
}

/** Interruption links to Eagle items absent from the row, and milestone links to missing or private comment periods. */
function checkLinks(tally, { sheetWorks, rows, commentPeriods }) {
  for (const work of sheetWorks) {
    const row = rows.get(String(work.projectId)) || {};
    const itemIds = new Set(EXTENSION_LIST_FIELDS.flatMap(field => listOf(row[field])).filter(isObject).map(idOf));
    for (const child of childrenOf(work, 'interruptions')) {
      const id = child.links && child.links.eagleItemId;
      if (id && !itemIds.has(id)) tally.add('danglingEagleItemId', { project: work.projectId, workId: work.id, child: child.id });
    }
    const periods = new Map(listOf(commentPeriods.get(String(work.projectId))).map(period => [period.id, period]));
    for (const child of childrenOf(work, 'milestones')) {
      const id = child.links && child.links.commentPeriodId;
      if (!id) continue;
      const period = periods.get(id);
      const fields = { project: work.projectId, workId: work.id, child: child.id, commentPeriodId: id };
      if (!period) tally.add('commentPeriodMissing', fields);
      else if (!listOf(period.read).some(role => PUBLIC_ROLES.includes(role))) tally.add('commentPeriodNotPublic', fields);
    }
    if (isObject(work.undated) && Object.keys(work.undated).length) {
      tally.add('undatedDates', { project: work.projectId, workId: work.id, fields: Object.keys(work.undated).sort().join(',') });
    }
  }
}

const pairKey = (trackWorkId, sourceKey) => `${trackWorkId}|${sourceKey}`;

/** One active marker against W7's pairing over the extract, the stored Track works and the current boundary. */
function checkMarker(tally, { projectId, marker, fresh, sheet, track }) {
  const boundary = overrideBoundaryOf(track);
  const keyOf = new Map(sheet.map(work => [work.id, work.sourceKey]));
  const storedKeys = new Set(sheet.map(work => work.sourceKey));
  const trackById = new Map(track.map(work => [work.id, work]));
  const freshMarker = fresh.markers.find(one => String(one.projectId) === projectId) ||
    { hidden: [], trackAlive: [], untilTrack: [] };
  const drift = (reason, fields) => tally.add('hiddenDrift', { project: projectId, reason, ...fields });

  const storedHidden = new Set(listOf(marker.hidden).map(pair => pairKey(pair.trackWorkId, keyOf.get(pair.sheetWorkId))));
  const freshHidden = new Set(freshMarker.hidden.map(pair => pairKey(pair.trackWorkId, pair.sourceKey)));
  for (const pair of freshMarker.hidden.filter(one => !storedHidden.has(pairKey(one.trackWorkId, one.sourceKey)))) {
    drift('matchNotHidden', { trackWorkId: pair.trackWorkId, sourceKey: pair.sourceKey });
  }
  for (const pair of listOf(marker.hidden)) {
    if (freshHidden.has(pairKey(pair.trackWorkId, keyOf.get(pair.sheetWorkId)))) continue;
    const trackWork = trackById.get(pair.trackWorkId);
    const reason = !trackWork ? 'hiddenTrackGone' : settledBefore(trackWork, boundary) ? 'hiddenNotMatched' : 'hiddenNotSettled';
    drift(reason, { trackWorkId: pair.trackWorkId, sheetWorkId: pair.sheetWorkId });
  }
  const storedAlive = new Set(listOf(marker.trackAlive).map(pair => pairKey(pair.trackWorkId, pair.sourceKey)));
  for (const pair of listOf(marker.trackAlive).filter(one => !trackById.has(one.trackWorkId))) {
    drift('trackAliveGone', { trackWorkId: pair.trackWorkId, sourceKey: pair.sourceKey });
  }
  for (const pair of freshMarker.trackAlive.filter(one => storedKeys.has(one.sourceKey) && !storedAlive.has(pairKey(one.trackWorkId, one.sourceKey)))) {
    drift('aliveNotSkipped', { trackWorkId: pair.trackWorkId, sourceKey: pair.sourceKey });
  }

  const replaced = new Set();
  for (const trackWork of track) {
    for (const sheetWorkId of untilTrackHidden(sheet, [trackWork], marker)) {
      replaced.add(keyOf.get(sheetWorkId));
      tally.add('untilTrackHidden', { project: projectId, sheetWorkId, sourceKey: keyOf.get(sheetWorkId), trackWorkId: trackWork.id });
    }
  }
  const movedKeys = new Set();
  for (const work of sheet.filter(one => OVERRIDE_TYPES.includes(workTypeCodeOf(one)) && !listOf(marker.untilTrack).includes(one.id))) {
    const closed = dayOf(work.decisionDate);
    if (closed && closed >= boundary && closed < marker.boundaryAtLoad) {
      movedKeys.add(work.sourceKey);
      tally.add('sheetHiddenByMovedBoundary', { project: projectId, workId: work.id, sourceKey: work.sourceKey, boundary });
    }
  }
  const storedUntil = new Set(listOf(marker.untilTrack).map(id => keyOf.get(id)));
  const freshUntil = new Set(freshMarker.untilTrack);
  for (const sourceKey of [...storedUntil].filter(key => !freshUntil.has(key) && !replaced.has(key))) drift('untilTrackChanged', { sourceKey });
  for (const sourceKey of [...freshUntil].filter(key => !storedUntil.has(key) && !movedKeys.has(key))) drift('untilTrackChanged', { sourceKey });
}

/** (system, value) pairs that more than one project claims, stored or from the extract. */
function checkExternalIds(tally, { rows, fresh }) {
  const claims = new Map();
  const claim = (projectId, entry) => {
    if (!isObject(entry) || !entry.system || !entry.value) return;
    const key = `${entry.system}:${entry.value}`;
    claims.set(key, (claims.get(key) || new Set()).add(String(projectId)));
  };
  for (const [id, row] of rows) listOf(row.externalIds).forEach(entry => claim(id, entry));
  for (const project of fresh.projects) listOf(project.externalIds).forEach(entry => claim(project.projectId, entry));
  for (const [key, projects] of claims) {
    if (projects.size > 1) tally.add('duplicateExternalId', { system: key.split(':')[0], projects: [...projects].sort().join(',') });
  }
}

/** Counts and item lines from the extract, the stored state and the catalogs; pure. */
function parityOf({ extract, crosswalk, catalog, phaseCatalog: phases, rows, works, markers, commentPeriods, at }) {
  const projectIds = [...new Set([...crosswalk.values()].map(String))];
  const ofSource = (id, source) => listOf(works.get(id)).filter(work => sourceOf(work) === source);
  const trackWorks = new Map(projectIds.map(id => [id, ofSource(id, 'track')]));
  const base = {
    catalog, phaseCatalog: phases, crosswalk, batchId: 'parity-check', batchAt: at, storedProjects: rows,
    eagleItems: new Map(projectIds.map(id => [id, { ...(rows.get(id) || {}), commentPeriods: listOf(commentPeriods.get(id)) }]))
  };
  const all = mapBusinessWorks(extract, base);
  const fresh = mapBusinessWorks(extract, { ...base, trackWorks, markers });
  const tally = makeTally();
  const sheetWorks = projectIds.flatMap(id => ofSource(id, 'sheet'));
  checkWorks(tally, { all, fresh, sheetWorks, markers });
  checkLinks(tally, { sheetWorks, rows, commentPeriods });
  checkExternalIds(tally, { rows, fresh });
  for (const [projectId, marker] of markers) {
    if (marker.active !== true) tally.add('overrideHeldOff', { project: projectId });
    else checkMarker(tally, { projectId, marker, fresh, sheet: ofSource(projectId, 'sheet'), track: trackWorks.get(projectId) || [] });
  }
  return tally;
}

async function liveState(crosswalk) {
  const projectIds = [...new Set([...crosswalk.values()].map(String))];
  const { items } = await projectsRepository.listVisible(systemAccess(), {});
  const works = new Map();
  const markers = new Map();
  const commentPeriods = new Map();
  for (const id of projectIds) {
    works.set(id, await worksRepository.listByProject(id));
    const marker = await worksRepository.get(id, OVERRIDE_MARKER_ID);
    if (marker) markers.set(id, marker);
    commentPeriods.set(id, await commentPeriodsRepository.listEveryByProject(id, systemAccess()));
  }
  const catalog = await listsRepository.readWorksCatalog();
  if (!catalog) refuse('no works catalog stored');
  return { rows: new Map(items.map(row => [String(row.id), row])), works, markers, commentPeriods, catalog,
    phaseCatalog: await phaseCatalog.load() };
}

/** Resolves the exit code; exit 1 on a mismatch, a duplicate external id or sourceKey. @param {object} [deps] test seam {state, write, endpoint, now} */
async function run(argv, deps = {}) {
  const write = deps.write || (line => process.stdout.write(`${line}\n`));
  const o = optionsOf(argv, deps.endpoint);
  const { keys, operator, extract, crosswalk } = openInputs(o);
  const state = await (deps.state || liveState)(crosswalk);
  const { counts, items } = parityOf({ extract, crosswalk, ...state, at: (deps.now || new Date()).toISOString() });
  const { blob, sha256 } = writeReport({ counts, items }, { keys, operator, outDir: o['out-dir'] });
  COUNTS.forEach(name => write(`${name}=${counts[name]}`));
  write(`reportSha256=${sha256}`);
  write(`blob=${blob}`);
  return FAILING.some(name => counts[name] > 0) ? 1 : 0;
}

module.exports = { run };

if (require.main === module) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }, (err) => {
    logger.error(`[business-works-parity] ${err.message}`);
    process.exitCode = 1;
  });
}
