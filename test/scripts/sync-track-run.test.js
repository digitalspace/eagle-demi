'use strict';

// The nightly's investment step: Track's `capital_investment` and the row's `intake.investment` become dated
// `capitalInvestments` entries. The history repository's Cosmos calls land on the same in-memory projects fake.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const config = require('../../src/config');
const { run, syncProjects } = require('../../src/scripts/sync-track-run');
const { NOW, API_PROJECT, storedProject, eagleOnlyProject, fakeLinks, fakeProjects } = require('../helpers/track-sync-fakes');
const { logger } = require('../../src/utils/logger');

const RUN_DATE = NOW.slice(0, 10);
const INVESTED = { ...API_PROJECT, capital_investment: 12000000 };
const amount = (id, source, amountCad) => ({ id, amountCad, effectiveFrom: null, effectiveTo: null, source });

/** {rows} in the projects fake, with the history repository's reads and patches routed to it. */
function store(t, rows) {
  const projects = fakeProjects(rows);
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

test("Eagle intake.investment '$85,000,000' becomes an eagle entry of 85000000", async (t) => {
  const projects = store(t, [storedProject({ intake: { investment: '$85,000,000' } })]);

  await nightly(projects, [API_PROJECT]);

  assert.deepStrictEqual(entriesOf(projects).map(e => [e.source, e.amountCad]), [['eagle', 85000000]]);
});

test("Eagle intake.investment 'TBD' writes nothing and counts unreadable=1", async (t) => {
  const projects = store(t, [storedProject({ intake: { investment: 'TBD' } })]);

  const summary = await nightly(projects, [API_PROJECT]);

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

test("a relinked row's Eagle intake becomes an eagle entry", async (t) => {
  const projects = store(t, [eagleOnlyProject({ intake: { investment: 5000 } })]);

  const summary = await nightly(projects, [API_PROJECT]);

  assert.strictEqual(summary.relinked, 1, 'the premise');
  assert.deepStrictEqual(entriesOf(projects).map(e => [e.source, e.amountCad]), [['eagle', 5000]]);
});

test('a dry run counts the entries a live run would append and writes none', async (t) => {
  const projects = store(t, [storedProject()]);

  const summary = await nightly(projects, [INVESTED], { live: false });

  assert.strictEqual(summary.investment.appended, 1);
  assert.strictEqual(entriesOf(projects), undefined);
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
