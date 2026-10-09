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

/** Column names a `... | summarize A = f(), B = g() by X, Y` query writes, TimeGenerated aside. */
function queryColumns(query) {
  const [aggregates, by = ''] = query.split('| summarize ')[1].split(' by ');
  const names = aggregates.split(/,\s*(?=\w+ = )/).map(part => part.split(' = ')[0].trim());
  return [...names, ...by.split(',').map(s => s.trim()).filter(Boolean)].sort();
}

function tableColumns(tableName) {
  const block = blocks.find(b => b.includes('tables@') && vars[(/name: (\w+)/.exec(b) || [])[1]] === tableName);
  assert.ok(block, `no declared table ${tableName}`);
  return [...block.matchAll(/\{ name: '(\w+)', type: '\w+' \}/g)]
    .map(m => m[1]).filter(name => name !== 'TimeGenerated').sort();
}

const rules = blocks.filter(b => b.includes('summaryLogs@')).map(b => ({
  name: /name: '([^']+)'/.exec(b)[1],
  query: /query: '([^']+)'/.exec(b)[1],
  table: vars[/destinationTable: (\w+)/.exec(b)[1]]
}));

test('summary rules write the columns their tables declare', async (t) => {
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
