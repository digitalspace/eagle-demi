'use strict';

/**
 * azure/modules/audit-logs.bicep — every summary rule's output columns match the destination
 * table it declares. A mismatch does not fail the deployment; it fails the rule's hourly write,
 * so the rollup goes quiet with nothing to say why.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../../azure/modules/audit-logs.bicep'), 'utf8');
const blocks = source.split(/^resource /m).slice(1);
const vars = Object.fromEntries([...source.matchAll(/^var (\w+) = '([^']+)'/gm)].map(m => [m[1], m[2]]));

// The type each aggregate writes. An aggregate not listed here fails the test until it is added.
const AGGREGATE_TYPES = [
  [/^count\(\)$/, 'long'],
  [/^dcount\(/, 'long'],
  [/^sum\(tolong\(/, 'long'],
  [/^avg\(/, 'real']
];

/**
 * `name:type` for each column a `... | summarize A = f(), B = g() by X, Y` query writes,
 * TimeGenerated aside. Group-by columns are the events table's string columns.
 */
function queryColumns(query) {
  const [aggregates, by = ''] = query.split('| summarize ')[1].split(' by ');
  const written = aggregates.split(/,\s*(?=\w+ = )/).map((part) => {
    const [name, expression] = part.split(' = ').map(s => s.trim());
    const match = AGGREGATE_TYPES.find(([pattern]) => pattern.test(expression));
    return `${name}:${match ? match[1] : `unknown aggregate ${expression}`}`;
  });
  const grouped = by.split(',').map(s => s.trim()).filter(Boolean).map(name => `${name}:string`);
  return [...written, ...grouped].sort();
}

function tableColumns(tableName) {
  const block = blocks.find(b => b.includes('tables@') && vars[(/name: (\w+)/.exec(b) || [])[1]] === tableName);
  assert.ok(block, `no declared table ${tableName}`);
  return [...block.matchAll(/\{ name: '(\w+)', type: '(\w+)' \}/g)]
    .filter(m => m[1] !== 'TimeGenerated').map(m => `${m[1]}:${m[2]}`).sort();
}

const rules = blocks.filter(b => b.includes('summaryLogs@')).map(b => ({
  name: /name: '([^']+)'/.exec(b)[1],
  query: /query: '([^']+)'/.exec(b)[1],
  table: vars[/destinationTable: (\w+)/.exec(b)[1]]
}));

test('summary rules write the columns and types their tables declare', async (t) => {
  await t.test('the module has both hourly rules', () => {
    assert.deepStrictEqual(rules.map(r => r.name).sort(), ['demi-downloads-hourly', 'demi-events-hourly']);
  });

  for (const rule of rules) {
    await t.test(rule.name, () => {
      assert.deepStrictEqual(queryColumns(rule.query), tableColumns(rule.table));
    });
  }

  await t.test('the downloads rule reads only download events and sums their bytes', () => {
    const { query } = rules.find(r => r.name === 'demi-downloads-hourly');
    assert.match(query, /where EventName == "document\.download"/);
    assert.match(query, /Bytes = sum\(tolong\(Detail\.bytes\)\)/);
  });
});
