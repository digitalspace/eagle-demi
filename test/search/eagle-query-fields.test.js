'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const eagleQuery = require('../../src/search/eagle-query');
const { filterFor } = require('../../src/helpers/access-odata');
const { resolveAccess } = require('../../src/helpers/access-sql');

const anonymous = () => resolveAccess({ header: () => null });
const projectAcl = () => filterFor(anonymous(), 'id');
const filterFields = query => eagleQuery.buildFilter(query, 'Project', projectAcl(), anonymous()).fields;

// `fields` is what a dial check reads: a column missing here is a column a hidden value can leak through.
test('eagle-query reports the index columns its clauses read', async (t) => {
  await t.test('an explicit sort reports its column and not the id tiebreak', () => {
    const { fields } = eagleQuery.buildOrderBy('+decisionDate', 'Project', true, anonymous());
    assert.deepStrictEqual(fields, ['decisionDate']);
  });

  await t.test('the default sort reports its column', () => {
    const { orderby, fields } = eagleQuery.buildOrderBy(undefined, 'Project', false, anonymous());
    assert.ok(orderby.startsWith('name asc'), orderby);
    assert.deepStrictEqual(fields, ['name']);
  });

  await t.test('and[sector] reports the columns its sub-type fallback reads', () => {
    const fields = filterFields({ 'and[sector]': 'Marine Port Facilities' });
    assert.deepStrictEqual(new Set(fields), new Set(['sector', 'projectSubType', 'legislationYear']));
  });

  await t.test('a range term reports its base column', () => {
    assert.deepStrictEqual(filterFields({ 'and[decisionDateEnd]': '2026-01-01T00:00:00Z' }), ['decisionDate']);
  });

  await t.test('and[nameContains] reports every column it searches', () => {
    assert.deepStrictEqual(filterFields({ 'and[nameContains]': 'mine' }), ['name', 'nameTokens']);
  });

  await t.test('a presence term reports its column', () => {
    const { fields } = eagleQuery.buildFilter(
      { 'and[documentUrl]': 'true' }, 'RecentActivity', filterFor(anonymous(), 'projectId'), anonymous());
    assert.deepStrictEqual(fields, ['documentUrl']);
  });
});
