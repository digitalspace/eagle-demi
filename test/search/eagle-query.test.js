'use strict';

/**
 * The query translation eagle-public depends on.
 *
 * Every assertion here is written against a WIRE STRING eagle-public actually sends — the worked
 * examples in the contract, not an invented shape — because the whole class of bug this file exists
 * to prevent is a request that succeeds and answers the wrong rows.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const eagleQuery = require('../../src/search/eagle-query');
const { filterFor } = require('../../src/helpers/access-odata');
const { resolveAccess } = require('../../src/helpers/access-sql');

const anonymous = () => resolveAccess({ header: () => null });
const anonAcl = (field) => filterFor(anonymous(), field);

test('eagle-query filters', async (t) => {
  // THE assertion that matters. The caller's filters are COMPOSED with the ACL clause; a filter
  // that replaces it is unrestricted, and OData answers that request with the whole corpus.
  await t.test('a caller filter is ANDed with the ACL clause, never substituted for it', () => {
    const { filter } = eagleQuery.buildFilter(
      { project: '207', 'and[isPublished]': 'true' }, 'Document', anonAcl());

    assert.ok(filter.includes("read/any(r: search.in(r, 'public', ','))"), 'ACL clause survives');
    assert.ok(filter.includes("projectId eq '207'"), 'the project filter is applied');
    assert.ok(filter.includes('isPublished eq true'), 'the and[] filter is applied');
    assert.ok(!/ or /.test(filter), 'different keys are ANDed, never ORed');
  });

  // The fail-closed path. `empty` means this caller may see NOTHING, and there is no OData filter
  // that expresses that — a null or empty $filter is UNRESTRICTED. So the only safe answer is to
  // refuse to build a request at all, loudly, rather than to emit one without the clause.
  await t.test('a caller scoped to nothing cannot produce a filter at all', () => {
    assert.throws(
      () => eagleQuery.buildFilter({}, 'Document', { filter: null, empty: true }),
      /scoped to nothing/
    );
  });

  await t.test('a missing ACL argument throws rather than defaulting to unrestricted', () => {
    assert.throws(() => eagleQuery.buildFilter({}, 'Document'), /requires the access filter/);
    assert.throws(() => eagleQuery.buildFilter({}, 'Document', "read/any(r: r eq 'public')"),
      /requires the access filter/);
  });

  // Express 5 parses `and[type]=x` as a literal key; `qs`/extended parses the same URL into a
  // nested object. eagle-search recorded what reading only one shape costs: every filter dropped
  // and 60,560 documents returned where a filtered handful was expected.
  await t.test('both and[] wire shapes reach the filter', () => {
    const literal = eagleQuery.buildFilter({ 'and[projectId]': '207' }, 'Document', anonAcl());
    const nested = eagleQuery.buildFilter({ and: { projectId: '207' } }, 'Document', anonAcl());

    assert.ok(literal.filter.includes("projectId eq '207'"));
    assert.ok(nested.filter.includes("projectId eq '207'"));
  });

  await t.test('repeats of one key OR together', () => {
    const { filter } = eagleQuery.buildFilter(
      { 'and[projectId]': ['207', '208'] }, 'Document', anonAcl());
    assert.ok(filter.includes("(projectId eq '207' or projectId eq '208')"));
  });

  // A key the index cannot express is DROPPED, not passed through: an unknown field name is an
  // OData 400, and eagle-public swallows a failed search into an empty table.
  await t.test('a filter key the index does not carry is dropped and reported', () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[milestone]': '5cf00c03a266b7e1877504ec' }, 'Document', anonAcl());

    assert.deepStrictEqual(dropped, ['milestone']);
    assert.ok(!filter.includes('milestone'), 'a name the index lacks must never reach OData');
    assert.strictEqual(filter, "read/any(r: search.in(r, 'public', ','))");
  });

  // `read` is filterable in the index, so a caller could otherwise widen their own ACL by asking
  // for a role they do not hold — the clause would be ORed into their own group and ANDed with the
  // real one, which still restricts. This pins that it composes rather than replaces.
  await t.test('a caller cannot filter their way past the ACL clause', () => {
    const { filter } = eagleQuery.buildFilter({ 'and[read]': 'staff' }, 'Document', anonAcl());
    assert.ok(filter.includes("read/any(r: search.in(r, 'public', ','))"),
      'the ACL clause is still ANDed on');
  });

  // `_id` is the Eagle ObjectId on the wire. On a project that lives in `legacyEagleId`; filtering
  // the DEMI key with it would match nothing and render as an empty list.
  await t.test('Project _id redirects to the Eagle id field', () => {
    const { filter } = eagleQuery.buildFilter(
      { 'and[_id]': '588511c4aaecd9001b826192' }, 'Project', anonAcl('id'));
    assert.ok(filter.includes("legacyEagleId eq '588511c4aaecd9001b826192'"));
  });

  await t.test('a project filter on an index with no project axis is dropped, not ignored', () => {
    const { dropped } = eagleQuery.buildFilter({ project: '207' }, 'Project', anonAcl('id'));
    assert.deepStrictEqual(dropped, ['project']);
  });

  await t.test('a quote in a value is escaped by doubling', () => {
    const { filter } = eagleQuery.buildFilter({ 'and[region]': "O'Brien" }, 'Project', anonAcl('id'));
    assert.ok(filter.includes("region eq 'O''Brien'"));
  });

  // THE GATE IS THE FIELD'S TYPE, NOT `filterable`. `demi-projects.centroid` is an
  // `Edm.GeographyPoint` and IS filterable — geography fields are — so a `filterable` gate let it
  // fall to the quoted-string default and emitted `centroid eq 'x'`, which is not an operator OData
  // defines on a geography field. The 400 that came back is not retried, and the controller used to
  // answer it with the keywordless corpus listing: one `and[centroid]=x` from any anonymous caller
  // turned every Project keyword search into an arbitrary page of the whole readable corpus.
  await t.test('a filterable field whose TYPE has no term is dropped, not quoted', () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[centroid]': 'x' }, 'Project', anonAcl('id'));

    assert.deepStrictEqual(dropped, ['centroid']);
    assert.ok(!filter.includes('centroid'), 'a geography field must never reach OData as `eq`');
    assert.strictEqual(filter, "read/any(r: search.in(r, 'public', ','))");
  });

  // The same defect, the numeric branch: the old test was "does Number() accept it", which is not
  // the same question as "can an Edm.Int32 hold it". Both of these parse and both are 400s.
  await t.test('a value an Edm.Int32 cannot hold is dropped, however well it parses', () => {
    for (const value of ['0.5', '1e21', '-3.2', 'NaN']) {
      const { filter, dropped } = eagleQuery.buildFilter(
        { 'and[pageNumber]': value }, 'DocumentChunk', anonAcl());

      assert.deepStrictEqual(dropped, ['pageNumber'], `${value} must be dropped`);
      assert.ok(!filter.includes('pageNumber'), `${value} must not reach OData`);
    }
  });

  // The control for both tests above: a value the field CAN hold still filters. Without this the
  // two drops could be satisfied by dropping every numeric filter, which would measure nothing.
  await t.test('an integer inside the Int32 range still filters', () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[pageNumber]': '3' }, 'DocumentChunk', anonAcl());

    assert.deepStrictEqual(dropped, []);
    assert.ok(filter.includes('pageNumber eq 3'));
  });

  // A multi-select where only some values are expressible narrows the filter silently otherwise —
  // the caller asked for two pages and got one, with nothing in the log to say so.
  await t.test('a partly-unusable multi-select is reported, not quietly narrowed', () => {
    const { dropped } = eagleQuery.buildFilter(
      { 'and[pageNumber]': '3,0.5' }, 'DocumentChunk', anonAcl());
    assert.deepStrictEqual(dropped, ['pageNumber']);
  });
});

test('eagle-query sort', async (t) => {
  // eagle-public sends sortBy TWICE and the second is frequently empty (api.ts:176-177).
  await t.test('the empty second sortBy is ignored, not treated as a field', () => {
    const { orderby } = eagleQuery.buildOrderBy(['-displayName', ''], 'Document');
    assert.strictEqual(orderby, 'displayName desc, id asc');
  });

  // Relevance is ORDERED, not left to the service. `$skip` paging over an unspecified tie order
  // repeats and loses rows between pages.
  await t.test('-score becomes an explicit score order with a deterministic tiebreak', () => {
    const { orderby } = eagleQuery.buildOrderBy('-score', 'Document');
    assert.strictEqual(orderby, 'search.score() desc, id asc');
  });

  await t.test('a keyword search with no sort keeps relevance, tiebroken', () => {
    const { orderby } = eagleQuery.buildOrderBy('', 'Project', true);
    assert.strictEqual(orderby, 'search.score() desc, id asc');
  });

  // Only a keywordless, sortless search gets the alphabetical default — it exists to make
  // `search: '*'` paginate stably, and applying it to a keyword search sorts the ranking away.
  await t.test('a keywordless search gets a stable default order', () => {
    const { orderby } = eagleQuery.buildOrderBy(null, 'Project', false);
    assert.strictEqual(orderby, 'name asc, id asc');
  });

  await t.test('a field the index cannot sort is dropped rather than sent', () => {
    const { orderby, dropped } = eagleQuery.buildOrderBy('-datePosted', 'Document', false);
    assert.deepStrictEqual(dropped, ['datePosted']);
    assert.ok(!orderby.includes('datePosted'), 'a non-sortable name is a 400 on every query');
  });

  // Every field in demi-chunks is sortable:false, the key included. There is nothing to name, so
  // no $orderby may be emitted at all.
  await t.test('DocumentChunk can express no order whatsoever', () => {
    assert.strictEqual(eagleQuery.buildOrderBy('-score', 'DocumentChunk', true).orderby, undefined);
    assert.strictEqual(eagleQuery.buildOrderBy(null, 'DocumentChunk', false).orderby, undefined);
  });
});

test('eagle-query parameters', async (t) => {
  await t.test('a parameter this endpoint does not read is named, not ignored', () => {
    assert.deepStrictEqual(eagleQuery.unknownParams({ dataset: 'Document', page: '2' }), ['page']);
  });

  // eagle-public sends all of these on every request; none may be refused.
  await t.test('eagle-public\'s own parameters are all accepted', () => {
    assert.deepStrictEqual(eagleQuery.unknownParams({
      dataset: 'Document', keywords: 'fish', pageNum: '1', pageSize: '10',
      projectLegislation: 'default', sortBy: ['-datePosted', ''], populate: 'true',
      'and[milestone]': '5cf', fields: '[object Object]', fuzzy: 'false', and: { project: '207' }
    }), []);
  });

  // Both project wire forms are live: flat from fields[], and[] from queryModifier. Reading one
  // means half the project tabs return the whole corpus.
  await t.test('project ids are read from both wire forms', () => {
    assert.deepStrictEqual(
      eagleQuery.projectIdsFrom({ project: '588511c4aaecd9001b826192' }),
      ['588511c4aaecd9001b826192']);
    assert.deepStrictEqual(
      eagleQuery.projectIdsFrom({ 'and[project]': '588511c4aaecd9001b826192' }),
      ['588511c4aaecd9001b826192']);
    assert.deepStrictEqual(
      eagleQuery.projectIdsFrom({ and: { project: '588511c4aaecd9001b826192' } }),
      ['588511c4aaecd9001b826192']);
  });

  await t.test('translation replaces every project key with the resolved ids', () => {
    const rewritten = eagleQuery.withProjectIds(
      { dataset: 'Document', 'and[project]': '588511c4aaecd9001b826192', 'and[read]': 'public' },
      ['207']);

    assert.strictEqual(rewritten.project, '207');
    assert.strictEqual(rewritten['and[project]'], undefined, 'the untranslated key must not survive');
    assert.strictEqual(rewritten['and[read]'], 'public', 'other filters are untouched');
    assert.ok(eagleQuery.buildFilter(rewritten, 'Document', anonAcl()).filter
      .includes("projectId eq '207'"));
  });
});
