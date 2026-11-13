'use strict';

// The nightly's investment step: Track's `capital_investment` and the row's `intake.investment` become dated
// `capitalInvestments` entries.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const config = require('../../src/config');
const { run, syncProjects } = require('../../src/scripts/sync-track-run');
const { currentInvestment } = require('../../src/domain/project-staff-fields');
const { NOW, API_PROJECT, storedProject, eagleOnlyProject, fakeLinks, fakeProjects } = require('../helpers/track-sync-fakes');
const { logger } = require('../../src/utils/logger');

// NOW is midnight UTC, so the run's Pacific day is the day before.
const RUN_DATE = '2026-09-01';
const INVESTED = { ...API_PROJECT, capital_investment: 12000000 };
const CLEARED = { ...API_PROJECT, capital_investment: null };
const amount = (id, source, amountCad) => ({ id, amountCad, effectiveFrom: null, effectiveTo: null, source });

/** {rows} in the projects fake, with the history repository's reads and patches routed to it. */
function store(t, rows, midRun) {
  const projects = fakeProjects(rows, { midRun });
  const find = (id) => projects.items.find(row => String(row.id) === String(id)) || null;
  t.mock.method(cosmos, 'readItem', async (_container, id) => structuredClone(find(id)));
  t.mock.method(cosmos, 'patch', async (_container, id, _key, operations, _condition, etag) => {
    if (find(id)._etag !== etag) throw Object.assign(new Error('Precondition failed'), { code: 412 });
    return projects.store(operations.reduce((row, { path, value }) => ({ ...row, [path.slice(1)]: value }), find(id)));
  });
  t.mock.method(logger, 'warn', () => {});
  return projects;
}

const nightly = (projects, rows = [INVESTED], opts = {}) =>
  syncProjects(rows, { live: true, deps: { projects, links: fakeLinks() }, now: NOW, ...opts });
const entriesOf = (projects, id = '207') => projects.items.find(row => row.id === id).capitalInvestments;

test('nightly appends one track entry for a new capital_investment and none on the next run', async (t) => {
  const projects = store(t, [storedProject()]);
  const info = t.mock.method(logger, 'info', () => {});

  const first = await nightly(projects);
  const second = await nightly(projects);

  assert.deepStrictEqual(entriesOf(projects).map(e => [e.source, e.amountCad, e.effectiveFrom, e.effectiveTo, e.observedAt]),
    [['track', 12000000, null, null, RUN_DATE]]);
  assert.deepStrictEqual([first.investment.appended, first.investment.closed, second.investment.appended], [1, 0, 0]);
  const lines = info.mock.calls.map(call => call.arguments[0]).filter(line => line.startsWith('[investment]'));
  assert.deepStrictEqual(lines.at(-1), '[investment] appended=0 closed=0 unreadable=0 full=0');
});

test("nightly closes the open track entry and appends one when Track's value changes, leaving sheet and demi entries alone", async (t) => {
  const kept = [amount('s1', 'sheet', 5), amount('d1', 'demi', 7)];
  const projects = store(t, [storedProject({ capitalInvestments: [...kept, amount('t1', 'track', 10)] })]);

  const summary = await nightly(projects);

  const [sheet, demi, closed, added] = entriesOf(projects);
  assert.deepStrictEqual([sheet, demi], kept);
  assert.deepStrictEqual([closed.id, closed.effectiveTo], ['t1', RUN_DATE]);
  assert.deepStrictEqual([added.source, added.amountCad, added.effectiveFrom, added.effectiveTo], ['track', 12000000, RUN_DATE, null]);
  assert.deepStrictEqual([summary.investment.appended, summary.investment.closed], [1, 1]);
});

test('a project with both sources gets a track and an eagle entry', async (t) => {
  const projects = store(t, [storedProject({ intake: { investment: 5000 } })]);

  const summary = await nightly(projects);

  assert.deepStrictEqual(entriesOf(projects).map(e => [e.source, e.amountCad]), [['track', 12000000], ['eagle', 5000]]);
  assert.deepStrictEqual([summary.investment.appended, summary.failures], [2, 0]);
});

test('a cleared Track value closes its open entry with a closed 0 so the Eagle figure is current', async (t) => {
  const row = storedProject({ capitalInvestments: [amount('t1', 'track', 12000000)], intake: { investment: 5000 } });
  const cleared = store(t, [row]);

  const summary = await nightly(cleared, [CLEARED]);

  const [closed, zero] = entriesOf(cleared);
  const current = currentInvestment(entriesOf(cleared));
  assert.strictEqual(closed.effectiveTo, RUN_DATE);
  assert.deepStrictEqual([zero.source, zero.amountCad, zero.effectiveFrom, zero.effectiveTo], ['track', 0, RUN_DATE, RUN_DATE]);
  assert.deepStrictEqual([current.source, current.amountCad], ['eagle', 5000]);
  assert.deepStrictEqual([summary.investment.closed, summary.investment.appended], [1, 1]);

  const dry = store(t, [row]);
  const dryRun = await nightly(dry, [CLEARED], { live: false });
  assert.deepStrictEqual([dryRun.investment.closed, entriesOf(dry).length], [1, 1]);
});

test('a Track row without capital_investment is unreadable and leaves the open entry', async (t) => {
  const projects = store(t, [storedProject({ capitalInvestments: [amount('t1', 'track', 12000000)] })]);

  const summary = await nightly(projects, [API_PROJECT]);

  assert.deepStrictEqual(entriesOf(projects), [amount('t1', 'track', 12000000)]);
  assert.strictEqual(summary.investment.unreadable, 1);
});

test('Track A, cleared, then A again makes A current', async (t) => {
  const projects = store(t, [storedProject()]);

  for (const row of [INVESTED, CLEARED, INVESTED]) await nightly(projects, [row]);

  const current = currentInvestment(entriesOf(projects));
  assert.deepStrictEqual([current.source, current.amountCad], ['track', 12000000]);
});

test("Eagle intake.investment '$85,000,000' becomes an eagle entry of 85000000", async (t) => {
  const projects = store(t, [storedProject({ intake: { investment: '$85,000,000' } })]);

  await nightly(projects, [CLEARED]);

  assert.deepStrictEqual(entriesOf(projects).map(e => [e.source, e.amountCad]), [['eagle', 85000000]]);
});

test("Eagle intake.investment 'TBD' writes nothing and counts unreadable=1", async (t) => {
  const projects = store(t, [storedProject({ intake: { investment: 'TBD' } })]);

  const summary = await nightly(projects, [CLEARED]);

  assert.strictEqual(entriesOf(projects), undefined);
  assert.strictEqual(summary.investment.unreadable, 1);
});

test('a project with 200 entries gets no write and counts full=1', async (t) => {
  const full = Array.from({ length: 200 }, (_, n) => amount(`s${n}`, 'sheet', n + 1));
  const projects = store(t, [storedProject({ capitalInvestments: full, intake: { investment: 5000 } })]);

  const summary = await nightly(projects);

  assert.strictEqual(entriesOf(projects).length, 200);
  assert.strictEqual(summary.investment.full, 1, 'one project, though both its sources had a value');
});

test('the stored sources.track carries no capital_investment', async (t) => {
  const projects = store(t, []);

  await nightly(projects);

  assert.ok(!('capital_investment' in projects.items[0].sources.track), 'copy-to-env would carry it to test');
});

test('a patch that fails leaves the entries as they were and counts a failure', async (t) => {
  const projects = store(t, [storedProject({ capitalInvestments: [amount('t1', 'track', 10)] })]);
  t.mock.method(cosmos, 'patch', async () => { throw Object.assign(new Error('Precondition failed'), { code: 412 }); });
  t.mock.method(logger, 'error', () => {});

  const summary = await nightly(projects);

  assert.deepStrictEqual(entriesOf(projects), [amount('t1', 'track', 10)]);
  assert.deepStrictEqual([summary.failures, summary.investment.appended], [1, 0]);
});

test('an overlapping run that already appended the move leaves one entry', async (t) => {
  const projects = store(t, [storedProject()], (save, find) =>
    save({ ...find('207'), capitalInvestments: [{ ...amount('other', 'track', 12000000), observedAt: RUN_DATE }] }));

  const summary = await nightly(projects);

  assert.deepStrictEqual(entriesOf(projects).map(e => e.id), ['other']);
  assert.deepStrictEqual([summary.investment.appended, summary.failures], [0, 0]);
});

test('a close target closed since the run-start read drops the append and keeps the entries', async (t) => {
  const closed = { ...amount('t1', 'track', 10), effectiveTo: '2026-08-01' };
  const projects = store(t, [storedProject({ capitalInvestments: [amount('t1', 'track', 10)] })], (save, find) =>
    save({ ...find('207'), capitalInvestments: [closed] }));

  const summary = await nightly(projects);

  assert.deepStrictEqual(entriesOf(projects), [closed]);
  assert.deepStrictEqual([summary.failures, summary.investment.appended], [0, 0]);
});

test("a close dated before its target's effectiveFrom fails and keeps the entries", async (t) => {
  const later = { ...amount('t1', 'track', 10), effectiveFrom: '2026-09-05' };
  const projects = store(t, [storedProject({ capitalInvestments: [later] })]);
  t.mock.method(logger, 'error', () => {});

  const summary = await nightly(projects);

  assert.deepStrictEqual(entriesOf(projects), [later]);
  assert.deepStrictEqual([summary.failures, summary.investment.appended], [1, 0]);
});

test("a relinked row's Eagle intake becomes an eagle entry", async (t) => {
  const projects = store(t, [eagleOnlyProject({ intake: { investment: 5000 } })]);

  const summary = await nightly(projects, [CLEARED]);

  assert.strictEqual(summary.relinked, 1, 'the premise');
  assert.deepStrictEqual(entriesOf(projects).map(e => [e.source, e.amountCad]), [['eagle', 5000]]);
});

test('a dry run counts the entries a live run would append and writes none', async (t) => {
  const projects = store(t, [storedProject()]);

  const summary = await nightly(projects, [INVESTED], { live: false });

  assert.strictEqual(summary.investment.appended, 1);
  assert.strictEqual(entriesOf(projects), undefined);
});

test("a dry run counts a relinked row's entries from the run-start twin", async (t) => {
  const projects = store(t, [eagleOnlyProject({ intake: { investment: 5000 } })]);

  const summary = await nightly(projects, [CLEARED], { live: false });

  assert.deepStrictEqual([summary.relinked, summary.investment.appended], [1, 1]);
});

test('a row the write skipped gets no entry', async (t) => {
  const apiRow = { id: '207', trackProjectId: 207, eagleId: null, sourceSystem: 'track', name: 'Hand-created', sources: {} };
  const projects = store(t, [apiRow]);

  const summary = await nightly(projects);

  assert.strictEqual(summary.skippedApiRows, 1, 'the premise');
  assert.strictEqual(entriesOf(projects), undefined);
});

test('the projects poll leaves investment entries to the nightly', async (t) => {
  const projects = store(t, [storedProject()]);
  t.mock.method(logger, 'info', () => {});
  const fetchJson = async (url) => {
    if (url === `${config.trackApiBase}/api/v1/projects`) return [INVESTED];
    throw new Error(`unexpected Track call ${url}`);
  };

  await run({ live: true, deps: { kc: { clientToken: async () => 'track-token' }, fetchJson, projects, links: fakeLinks() } });

  assert.strictEqual(entriesOf(projects), undefined);
});
