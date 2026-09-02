'use strict';

/**
 * The three read calls behind /admin/audit, /admin/analytics and /admin/cost, checked at the wire:
 * which URL, which verb, which body. A wrong api-version or a swapped scope fails in Azure with a
 * 400 nobody sees until the panel is open, so it is asserted here instead.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const azureCredential = require('../../src/utils/azure-credential');
const monitor = require('../../src/azure/monitor');

/** Stubs the token and `fetch`, and hands back every request the module made. */
function stubFetch(t, payload, { ok = true, status = 200, text = '' } = {}) {
  const calls = [];
  t.mock.method(azureCredential, 'getToken', async (scope) => `token-for-${scope}`);
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, ...init });
    return { ok, status, json: async () => payload, text: async () => text };
  });
  return calls;
}

test('azure/monitor', async (t) => {
  await t.test('queryLogs posts KQL and the window to the workspace query endpoint', async () => {
    const calls = stubFetch(t, { tables: [{ columns: [{ name: 'Action' }], rows: [['key.mint']] }] });

    await monitor.queryLogs('ws-guid', 'DemiAudit_CL', 'P7D');

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://api.loganalytics.io/v1/workspaces/ws-guid/query');
    assert.strictEqual(calls[0].method, 'POST');
    // The window is a service-side parameter; it must not have been folded into the KQL.
    assert.deepStrictEqual(JSON.parse(calls[0].body), { query: 'DemiAudit_CL', timespan: 'P7D' });
    assert.strictEqual(
      calls[0].headers.Authorization,
      'Bearer token-for-https://api.loganalytics.io/.default'
    );
  });

  await t.test('column names line up with their own values, not the next ones', async () => {
    // zip() is positional: an off-by-one relabels every field rather than failing, so the columns
    // here carry values that would still look plausible shifted by one.
    const calls = stubFetch(t, {
      tables: [{
        columns: [{ name: 'ActorId' }, { name: 'ActorName' }, { name: 'SourceIp' }],
        rows: [['u-1', 'daniel', '10.0.0.1'], ['u-2', 'sam', '10.0.0.2']]
      }]
    });

    const rows = await monitor.queryLogs('ws-guid', 'DemiAudit_CL', 'PT24H');

    assert.deepStrictEqual(rows, [
      { ActorId: 'u-1', ActorName: 'daniel', SourceIp: '10.0.0.1' },
      { ActorId: 'u-2', ActorName: 'sam', SourceIp: '10.0.0.2' }
    ]);
    assert.strictEqual(calls[0].url.endsWith('/query'), true);
  });

  await t.test('queryLogs answers with no rows when the response carries no table', async () => {
    stubFetch(t, {});
    assert.deepStrictEqual(await monitor.queryLogs('ws-guid', 'DemiAudit_CL', 'PT24H'), []);
  });

  await t.test('queryCost posts month-to-date to Cost Management on the pinned api-version', async () => {
    const calls = stubFetch(t, {
      properties: {
        columns: [{ name: 'Cost' }, { name: 'ResourceId' }],
        rows: [[12.5, '/rg/search']]
      }
    });

    const rows = await monitor.queryCost('/subscriptions/s/resourceGroups/rg');

    assert.strictEqual(
      calls[0].url,
      'https://management.azure.com/subscriptions/s/resourceGroups/rg' +
      '/providers/Microsoft.CostManagement/query?api-version=2023-11-01'
    );
    assert.strictEqual(calls[0].method, 'POST');
    assert.strictEqual(
      calls[0].headers.Authorization,
      'Bearer token-for-https://management.azure.com/.default'
    );
    const body = JSON.parse(calls[0].body);
    assert.strictEqual(body.type, 'ActualCost');
    assert.strictEqual(body.timeframe, 'MonthToDate');
    assert.deepStrictEqual(rows, [{ Cost: 12.5, ResourceId: '/rg/search' }]);
  });

  await t.test('getBudget gets the named budget and flattens its current spend', async () => {
    const calls = stubFetch(t, {
      properties: { amount: 400, currentSpend: { amount: 0, unit: 'CAD' } }
    });

    const budget = await monitor.getBudget('/subscriptions/s/resourceGroups/rg', 'demi-budget-test');

    assert.strictEqual(
      calls[0].url,
      'https://management.azure.com/subscriptions/s/resourceGroups/rg' +
      '/providers/Microsoft.Consumption/budgets/demi-budget-test?api-version=2021-10-01'
    );
    assert.strictEqual(calls[0].method, 'GET');
    assert.strictEqual(calls[0].body, undefined, 'a GET must carry no body');
    assert.deepStrictEqual(budget, { name: 'demi-budget-test', amount: 400, spend: 0, currency: 'CAD' });
  });

  await t.test('a refused call throws with the status in the message', async () => {
    // The status is what tells a 403 (missing role assignment) apart from a 404 (wrong scope).
    stubFetch(t, {}, { ok: false, status: 403, text: 'AuthorizationFailed' });

    await assert.rejects(
      () => monitor.getBudget('/subscriptions/s/resourceGroups/rg', 'demi-budget-test'),
      /403/
    );
  });
});
