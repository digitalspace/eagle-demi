'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { liveDemi } = require('../../src/scripts/load-business-works');
const { PRIVATE_KEYS } = require('../../src/repositories/works');
const { KINDS } = require('../../src/scripts/works-import-batch');
const { OVERRIDE_MARKER_ID } = require('../../src/domain/work-model');
const projects = require('../../src/repositories/projects');
const { deriveInputs } = require('../../src/domain/works-derive');
const { logger } = require('../../src/utils/logger');
const { fakeLists, ref, register, amendment } = require('../helpers/works-import-fakes');
const {
  PROJECT, NUMBER, testHost, fakeDemi, inputs, load, reportOf, liveArgs, staffed, liveLoad
} = require('../helpers/works-import-loader');

test('dry run twice on unchanged input gives the same planSha256', async () => {
  const { argv } = inputs();
  assert.equal((await load(argv)).value('planSha256'), (await load(argv)).value('planSha256'));
});

test('a planned document changed in between changes planSha256', async () => {
  const { argv } = inputs();
  const demi = fakeDemi();
  const before = (await load(argv, demi)).value('planSha256');
  demi.docs.set('sheet-old', { id: 'sheet-old', projectId: PROJECT, source: 'sheet', owner: 'sheet', sourceKey: '101:amendment:9', _etag: '"o"' });
  assert.notEqual((await load(argv, demi)).value('planSha256'), before);
});

test('a sheet number missing from the crosswalk fails the dry run', async () => {
  const { argv } = inputs({ records: { projects: [register, { ...register, id: 102, ref: ref('Projects') }] } });
  await assert.rejects(load(argv), /not in the signed crosswalk/);
});

test('refuses an unknown Cosmos host, prod included, in the dry run', async (t) => {
  t.after(() => { process.env.COSMOS_ENDPOINT = testHost; });
  process.env.COSMOS_ENDPOINT = 'https://demi-cosmos-prod.documents.azure.com:443/';
  await assert.rejects(load(inputs().argv), /test only/);
});

test('refuses the prod Cosmos host in live mode', async (t) => {
  t.after(() => { process.env.COSMOS_ENDPOINT = testHost; });
  process.env.COSMOS_ENDPOINT = 'https://demi-cosmos-prod.documents.azure.com:443/';
  await assert.rejects(load([...inputs().argv, ...liveArgs('0'.repeat(64))]), /test only/);
});

test('no plaintext file on the devbox: the dry run writes one sealed 0600 report and nothing else', async () => {
  const { argv, outDir, dir } = inputs();
  const before = fs.readdirSync(dir).sort();
  const { value } = await load(argv);
  assert.deepEqual(fs.readdirSync(outDir), [value('blob')]);
  assert.match(value('blob'), /^[0-9a-f-]{36}\.sealed\.json$/);
  assert.equal(fs.statSync(path.join(outDir, value('blob'))).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
});

test('stdout, stderr and logger output contain no sourceKey, number or staff value', async (t) => {
  const said = [];
  for (const level of ['error', 'warn', 'info', 'debug']) t.mock.method(logger, level, (...args) => { said.push(JSON.stringify(args)); });
  const { lines } = await load(inputs().argv);
  said.push(...lines);
  const text = said.join('\n').replace(/[0-9a-f]{64}|[0-9a-f-]{36}/g, '');
  assert.ok(!text.includes(':amendment:'));
  assert.ok(!/\b101\b/.test(text));
  assert.ok(!text.includes('Sample Mine'));
});

test('dry run lists trackHidden with project id, work id, type, start date and matched sheet work, and prints the override counts', async () => {
  const { argv, outDir } = inputs();
  const { value, lines } = await load(argv);
  const report = reportOf(outDir, value('blob'));
  const [hidden] = report.lists.trackHidden;
  assert.deepEqual([hidden.projectId, hidden.workId, hidden.type, hidden.startDate, hidden.gap], [PROJECT, 'track-43', 'amendment', '2023-03-01', 0]);
  assert.match(hidden.sheetWorkId, /^sheet-/);
  assert.equal(hidden.sourceKey, `${NUMBER}:amendment:1`);
  assert.equal(value('sheetShown'), value('create'));
  assert.equal(report.lists.trackShownNoSheetMatch[0].workId, 'track-45');
  const printed = lines.map(line => line.split('=')[0]);
  const wanted = ['trackHidden', 'sheetShown', 'trackShownNoSheetMatch', 'trackAlive', 'trackCompletedNoDate', 'untilTrack', 'sameEventChoice'];
  assert.deepEqual(wanted.filter(key => !printed.includes(key)), []);
});

test('a Track amendment decided before B with no matching loaded sheet work is listed trackShownNoSheetMatch with its nearest sheet amendment and the gap', async () => {
  const { argv, outDir } = inputs();
  const { value } = await load(argv);
  const report = reportOf(outDir, value('blob'));
  const [shown] = report.lists.trackShownNoSheetMatch;
  assert.equal(shown.workId, 'track-45');
  assert.equal(shown.nearest.gap, 3014);
});

test('live refuses without --signoff-ref', async () => {
  await assert.rejects(load([...inputs().argv, ...liveArgs('0'.repeat(64), { signoff: null })]), /missing --signoff-ref/);
});

test('live exits before any write on any hash mismatch, and leaves no lock', async (t) => {
  const store = fakeLists(t);
  const demi = fakeDemi();
  await assert.rejects(load([...inputs().argv, ...liveArgs('0'.repeat(64))], demi), /planSha256 does not match/);
  assert.equal(demi.saves, 0);
  assert.deepEqual(store.all(), []);
});

test('live writes the marker with hidden equal to the signed trackHidden pairs, each sheetWorkId the id written for its sourceKey', async (t) => {
  const store = fakeLists(t);
  const { argv } = inputs();
  const demi = fakeDemi();
  const planSha256 = (await load(argv, demi)).value('planSha256');
  await load([...argv, ...liveArgs(planSha256)], demi);
  const sheet = [...demi.docs.values()].find(doc => doc.sourceKey === '101:amendment:1');
  assert.deepEqual(demi.docs.get(OVERRIDE_MARKER_ID).hidden, [{ trackWorkId: 'track-43', sheetWorkId: sheet.id }]);
  assert.equal(store.get(store.all().find(item => item.kind === KINDS.BATCH).id, KINDS.BATCH).status, 'complete');
  assert.deepEqual(demi.derived, [PROJECT]);
});

test('writtenEtag comes from the save response', async (t) => {
  const store = fakeLists(t);
  const { argv } = inputs();
  const demi = fakeDemi();
  await load([...argv, ...liveArgs((await load(argv, demi)).value('planSha256'))], demi);
  const entry = store.all().find(item => item.kind === KINDS.ENTRY && item.target.id === OVERRIDE_MARKER_ID);
  assert.equal(entry.writtenEtag, demi.docs.get(OVERRIDE_MARKER_ID)._etag);
});

test('second live after first prints a plan with written=0', async (t) => {
  fakeLists(t);
  const { argv } = inputs();
  const demi = fakeDemi();
  await load([...argv, ...liveArgs((await load(argv, demi)).value('planSha256'))], demi);
  const second = await load([...argv, ...liveArgs((await load(argv, demi)).value('planSha256'))], demi);
  assert.equal(second.value('written'), '0');
});

test('patchDerived uses WORKS_READ_SOURCES through deriveInputs', async (t) => {
  let inputsFor = null;
  t.mock.method(projects, 'patchDerived', async (_id, options) => { inputsFor = options.inputsFor; return { status: 'unchanged' }; });
  await liveDemi().patchDerived(PROJECT);
  assert.equal(inputsFor, deriveInputs);
});

test('truncated extract changes planSha256', async () => {
  const full = inputs({ records: { projects: [register], amendments: [amendment(1, '2023-06-01', '2023-11-07'), amendment(2, '2012-02-01', '2012-05-01')] } });
  const truncated = inputs();
  assert.notEqual((await load(full.argv)).value('planSha256'), (await load(truncated.argv)).value('planSha256'));
});

test('never writes projectLead, responsibleEPD, eaoMember, reviewExtensions, commentPeriods or legislation_* blocks', async (t) => {
  const demi = await liveLoad(t, staffed(), 'so-staff');
  assert.deepEqual([...new Set(demi.projectFields)].sort(), ['externalIds', 'staffAssignments', 'staffNotes']);
});

/** A work as a reader gets it: listForRead drops PRIVATE_KEYS at every depth. */
const publicOf = value => (Array.isArray(value) ? value.map(publicOf) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_KEYS.has(key)).map(([key, inner]) => [key, publicOf(inner)])) : value);

test('no anonymous field contains the project number', async (t) => {
  const demi = await liveLoad(t, inputs({ records: { projects: [register], amendments: [amendment(1, '2023-06-01', '2023-11-07'), amendment(2, '2012-02-01', '2012-05-01')] } }));
  const written = [...demi.docs.values()].filter(doc => doc.source === 'sheet' && doc.id !== OVERRIDE_MARKER_ID);
  const kinds = [...new Set(written.map(doc => doc.sourceKey.split(':')[1]))];
  const slots = [...Array.from({ length: 15 }, (_, i) => String(i + 1)), ...written.map(doc => doc.sourceKey.split(':')[2])];
  const keys = Array.from({ length: NUMBER }, (_, i) => i + 1).flatMap(n => kinds.flatMap(kind => slots.map(slot => `${n}:${kind}:${slot}`)));
  const text = JSON.stringify(written.map(publicOf));
  assert.ok(written.length >= 3);
  assert.deepEqual(keys.filter(key => text.includes(key)), []);
});
