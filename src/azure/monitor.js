'use strict';

// Module object, not a destructured function, so a test can stub the token call (src/utils/audit.js does the same).
const azureCredential = require('../utils/azure-credential');

const LOGS_SCOPE = 'https://api.loganalytics.io/.default';
const { ARM_SCOPE } = azureCredential;

/** One authenticated JSON call, GET without a body, POST with one. Plain fetch: three read
 * endpoints do not justify three Azure SDK packages in a Flex cold start. */
async function call(url, scope, body) {
  const token = await azureCredential.getToken(scope);
  if (!token) throw new Error(`no token for ${scope}`);

  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: body
      ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      : { Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

/** Column names and positional rows, zipped into objects. */
function zip(columns, rows) {
  const names = (columns || []).map((c) => c.name);
  return (rows || []).map((row) => Object.fromEntries(names.map((name, i) => [name, row[i]])));
}

/** First table of a KQL query as row objects. `timespan` (ISO 8601, `PT24H`) bounds the query on the
 * service side, so a caller's window never reaches the KQL text. */
async function queryLogs(customerId, query, timespan) {
  const body = await call(
    `https://api.loganalytics.io/v1/workspaces/${customerId}/query`,
    LOGS_SCOPE,
    { query, timespan }
  );
  const table = (body.tables || [])[0];
  return table ? zip(table.columns, table.rows) : [];
}

/** Month-to-date actual cost at `scope`, one row per resource-and-service pair. */
async function queryCost(scope) {
  const body = await call(
    `https://management.azure.com${scope}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`,
    ARM_SCOPE,
    {
      type: 'ActualCost',
      timeframe: 'MonthToDate',
      dataset: {
        granularity: 'None',
        aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
        grouping: [
          { type: 'Dimension', name: 'ResourceId' },
          { type: 'Dimension', name: 'ServiceName' }
        ]
      }
    }
  );
  const props = body.properties || {};
  return zip(props.columns, props.rows);
}

/** The monthly budget and Azure's spend against it. `currentSpend` reads 0.0 on live budgets here,
 * so it is reported beside the cost query, not instead of it. */
async function getBudget(scope, name) {
  const body = await call(
    `https://management.azure.com${scope}/providers/Microsoft.Consumption/budgets/${name}?api-version=2021-10-01`,
    ARM_SCOPE
  );
  const props = body.properties || {};
  return {
    name,
    amount: props.amount,
    spend: props.currentSpend && props.currentSpend.amount,
    currency: props.currentSpend && props.currentSpend.unit
  };
}

module.exports = { queryLogs, queryCost, getBudget };
