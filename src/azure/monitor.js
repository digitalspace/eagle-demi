'use strict';

const { getToken } = require('../utils/azure-credential');

const LOGS_SCOPE = 'https://api.loganalytics.io/.default';
const ARM_SCOPE = 'https://management.azure.com/.default';

/**
 * One authenticated JSON call. GET when there is no body, POST when there is.
 *
 * Plain fetch: three read endpoints do not justify three Azure SDK packages in a Flex Consumption
 * cold start, and the identity is already here.
 */
async function call(url, scope, body) {
  const token = await getToken(scope);
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

/**
 * Run KQL against a workspace and return its first table as row objects.
 *
 * `customerId` is the workspace GUID, `timespan` an ISO 8601 duration (`PT24H`, `P30D`) which
 * bounds the query on the service side — a caller's window never reaches the KQL text.
 */
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

/**
 * The monthly anomaly guard: what it is set to, and what Azure thinks has been spent against it.
 *
 * `currentSpend` has been observed reporting 0.0 on live budgets here (azure/modules/cost-budget.bicep),
 * so it is reported beside the cost query rather than instead of it.
 */
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
