'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../src/config');
const monitor = require('../../src/azure/monitor');
const controller = require('../../src/controllers/admin-reads');

function mockRes() {
  const res = {
    body: null,
    statusCode: 200,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; }
  };
  return res;
}

/**
 * The settings that decide whether a route answers at all. Restored after each test so an
 * unconfigured case cannot leak into a configured one — nothing else in the suite sets them.
 */
function configure(t, values) {
  const keys = ['auditWorkspaceCustomerId', 'appLogsWorkspaceCustomerId', 'costScope', 'budgetName'];
  const saved = Object.fromEntries(keys.map((k) => [k, config[k]]));
  Object.assign(config, {
    auditWorkspaceCustomerId: '', appLogsWorkspaceCustomerId: '', costScope: '', budgetName: '',
    ...values
  });
  t.after(() => Object.assign(config, saved));
}

/** Records every KQL string the controller sends, so a test can assert nothing was sent at all. */
function spyLogs(t, answer) {
  const sent = [];
  t.mock.method(monitor, 'queryLogs', async (customerId, query, timespan) => {
    sent.push({ customerId, query, timespan });
    return answer(query);
  });
  return sent;
}

test('GET /admin/audit', async (t) => {
  await t.test('rejects an action that is not a bare action name, and queries nothing', async () => {
    // The whole reason the pattern exists: `action` is interpolated into KQL. A rejected value
    // must not reach Log Analytics even in a query that would return nothing.
    configure(t, { auditWorkspaceCustomerId: 'ws-audit' });
    const sent = spyLogs(t, () => []);

    const res = mockRes();
    await controller.getAudit({ query: { action: "x' | union DemiEvents_CL //" } }, res);

    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(sent, [], 'no query may be sent for a rejected input');
  });

  await t.test('rejects an actor outside the pattern, an unlisted window and an over-large limit', async () => {
    configure(t, { auditWorkspaceCustomerId: 'ws-audit' });
    const sent = spyLogs(t, () => []);

    for (const query of [{ actor: "a' or '1'=='1" }, { hours: '25' }, { hours: '0' }, { limit: '501' }, { limit: '0' }]) {
      const res = mockRes();
      await controller.getAudit({ query }, res);
      assert.strictEqual(res.statusCode, 400, `${JSON.stringify(query)} must be a 400`);
    }
    assert.deepStrictEqual(sent, []);
  });

  await t.test('maps rows to objects and totals the window, not the page', async () => {
    // `limit` caps the rows; the total has to come off the summary or a filtered page understates
    // the window. Distinct numbers, so a total read from rows.length fails here.
    configure(t, { auditWorkspaceCustomerId: 'ws-audit' });
    const sent = spyLogs(t, (query) => (query.includes('summarize')
      ? [{ Action: 'key.mint', c: 7 }, { Action: 'project.update', c: 2 }]
      : [{ TimeGenerated: '2026-09-02T00:00:00Z', Action: 'key.mint', ActorName: 'daniel' }]));

    const res = mockRes();
    await controller.getAudit({ query: { hours: '168', limit: '1', action: 'key.mint', actor: 'daniel' } }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.hours, 168);
    assert.strictEqual(res.body.total, 9);
    assert.deepStrictEqual(res.body.byAction, [
      { action: 'key.mint', count: 7 },
      { action: 'project.update', count: 2 }
    ]);
    assert.deepStrictEqual(res.body.rows, [
      { TimeGenerated: '2026-09-02T00:00:00Z', Action: 'key.mint', ActorName: 'daniel' }
    ]);

    // The window is a service-side parameter, and the validated filters are the only interpolation.
    assert.ok(sent.every((call) => call.timespan === 'P7D'), '168 hours is P7D, sent as timespan');
    assert.ok(sent.every((call) => call.customerId === 'ws-audit'));
    assert.ok(sent[0].query.includes("where Action == 'key.mint'"));
    assert.ok(sent[0].query.includes("ActorId == 'daniel' or ActorName == 'daniel'"));
    assert.ok(sent[0].query.includes('top 1 by TimeGenerated desc'), 'limit caps the rows');
  });

  await t.test('answers 503 when no audit workspace is configured', async () => {
    configure(t, {});
    const sent = spyLogs(t, () => []);

    const res = mockRes();
    await controller.getAudit({ query: {} }, res);

    assert.strictEqual(res.statusCode, 503);
    assert.deepStrictEqual(res.body, { error: 'not configured' });
    assert.deepStrictEqual(sent, []);
  });
});

test('GET /admin/analytics', async (t) => {
  await t.test('rejects a window that is not 7 or 30 days, and queries nothing', async () => {
    configure(t, { auditWorkspaceCustomerId: 'ws-audit', appLogsWorkspaceCustomerId: 'ws-logs' });
    const sent = spyLogs(t, () => []);

    const res = mockRes();
    await controller.getAnalytics({ query: { days: '365' } }, res);

    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(sent, []);
  });

  await t.test('reads usage from the audit workspace and requests from the app one', async () => {
    // Two workspaces, and swapping them is silent — each answers the other's query with nothing.
    configure(t, { auditWorkspaceCustomerId: 'ws-audit', appLogsWorkspaceCustomerId: 'ws-logs' });
    const sent = spyLogs(t, (query) => {
      if (query.startsWith('AppRequests')) return [{ requests: 40, failed: 1, p95DurationMs: 250 }];
      if (query.includes('bin(TimeGenerated')) return [{ day: '2026-09-01T00:00:00Z', events: 5, visitors: 3 }];
      if (query.includes('EventName')) return [{ EventName: 'search', c: 12 }];
      if (query.includes('SearchTerm')) return [{ SearchTerm: 'lng', c: 4 }];
      return [{ events: 9, visitors: 4 }];
    });

    const res = mockRes();
    await controller.getAnalytics({ query: { days: '30' } }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.days, 30);
    assert.deepStrictEqual(res.body.totals, { events: 9, visitors: 4 });
    assert.deepStrictEqual(res.body.perDay, [{ day: '2026-09-01T00:00:00Z', events: 5, visitors: 3 }]);
    assert.deepStrictEqual(res.body.topEvents, [{ name: 'search', count: 12 }]);
    assert.deepStrictEqual(res.body.topSearches, [{ term: 'lng', count: 4 }]);
    assert.deepStrictEqual(res.body.requests.window, { requests: 40, failed: 1, p95DurationMs: 250 });

    const events = sent.filter((call) => call.query.includes('DemiEvents_CL'));
    const requests = sent.filter((call) => call.query.startsWith('AppRequests'));
    assert.ok(events.length && events.every((call) => call.customerId === 'ws-audit'));
    assert.ok(requests.length && requests.every((call) => call.customerId === 'ws-logs'));
    // The last 24 hours is reported beside the window, so one of the two must not be P30D.
    assert.deepStrictEqual(requests.map((call) => call.timespan).sort(), ['P30D', 'PT24H']);
  });

  await t.test('answers 503 when only one of the two workspaces is configured', async () => {
    configure(t, { auditWorkspaceCustomerId: 'ws-audit' });
    const sent = spyLogs(t, () => []);

    const res = mockRes();
    await controller.getAnalytics({ query: {} }, res);

    assert.strictEqual(res.statusCode, 503);
    assert.deepStrictEqual(res.body, { error: 'not configured' });
    assert.deepStrictEqual(sent, []);
  });
});

test('GET /admin/cost', async (t) => {
  t.beforeEach(() => controller._resetCostCache());
  t.after(() => controller._resetCostCache());

  await t.test('sums the month to date by resource and by service', async () => {
    configure(t, { costScope: '/subscriptions/s/resourceGroups/rg', budgetName: 'demi-budget-test' });
    t.mock.method(monitor, 'queryCost', async () => [
      { Cost: 100, ResourceId: '/rg/search', ServiceName: 'Azure AI Search', Currency: 'CAD' },
      { Cost: 25, ResourceId: '/rg/cosmos', ServiceName: 'Azure Cosmos DB', Currency: 'CAD' },
      // Same resource, second service: both breakdowns must fold rather than overwrite.
      { Cost: 5, ResourceId: '/rg/search', ServiceName: 'Bandwidth', Currency: 'CAD' }
    ]);
    t.mock.method(monitor, 'getBudget', async () => ({ name: 'demi-budget-test', amount: 400, spend: 0, currency: 'CAD' }));

    const res = mockRes();
    await controller.getCost({}, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.total, 130);
    assert.strictEqual(res.body.currency, 'CAD');
    assert.deepStrictEqual(res.body.byResource, [
      { resourceId: '/rg/search', cost: 105 },
      { resourceId: '/rg/cosmos', cost: 25 }
    ]);
    assert.deepStrictEqual(res.body.byService[0], { service: 'Azure AI Search', cost: 100 });
    assert.strictEqual(res.body.budget.amount, 400);
  });

  await t.test('a second call inside the hour is served from the cache', async () => {
    // Cost Management rate-limits, and this figure moves once a day at most.
    configure(t, { costScope: '/subscriptions/s/resourceGroups/rg' });
    let calls = 0;
    t.mock.method(monitor, 'queryCost', async () => {
      calls += 1;
      return [{ Cost: 1, ResourceId: '/rg/a', ServiceName: 'A', Currency: 'CAD' }];
    });

    const first = mockRes();
    await controller.getCost({}, first);
    const second = mockRes();
    await controller.getCost({}, second);

    assert.strictEqual(calls, 1, 'the second call must not reach Cost Management');
    assert.strictEqual(second.body, first.body, 'and must answer with the cached body');
  });

  await t.test('omits the budget rather than the spend when no budget is named', async () => {
    configure(t, { costScope: '/subscriptions/s/resourceGroups/rg' });
    t.mock.method(monitor, 'queryCost', async () => [{ Cost: 3, ResourceId: '/rg/a', ServiceName: 'A', Currency: 'CAD' }]);
    t.mock.method(monitor, 'getBudget', async () => { throw new Error('must not be called'); });

    const res = mockRes();
    await controller.getCost({}, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.budget, null);
    assert.strictEqual(res.body.total, 3);
  });

  await t.test('answers 503 when no cost scope is configured', async () => {
    configure(t, {});
    t.mock.method(monitor, 'queryCost', async () => { throw new Error('must not be called'); });

    const res = mockRes();
    await controller.getCost({}, res);

    assert.strictEqual(res.statusCode, 503);
    assert.deepStrictEqual(res.body, { error: 'not configured' });
  });
});
