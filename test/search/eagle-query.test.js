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
const fs = require('node:fs');
const path = require('node:path');

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
  //
  // REPLACED 2026-08-22: this used `milestone` as the example, which is no longer a name the index
  // lacks — `documents` carries `milestoneId` and ALIASES.Document maps onto it. `documentSource`
  // is a key eagle-public's filter panel really does send and this index really does not carry, so
  // the test still pins the behaviour with an example that is still true.
  await t.test('a filter key the index does not carry is dropped and reported', () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[documentSource]': 'COMMENT' }, 'Document', anonAcl());

    assert.deepStrictEqual(dropped, ['documentSource']);
    assert.ok(!filter.includes('documentSource'), 'a name the index lacks must never reach OData');
    assert.strictEqual(filter, "read/any(r: search.in(r, 'public', ','))");
  });

  // The four document facets eagle-public sends, all as List ObjectIds, all onto the id columns.
  // Before the alias map they passed through onto the LABEL columns and matched nothing — a 200
  // with an empty table, which reads as "no documents" rather than as a broken filter.
  await t.test('the four document facets map onto the id columns', () => {
    const { filter, dropped } = eagleQuery.buildFilter({
      'and[type]': '5cf00c03a266b7e1877504d9',
      'and[milestone]': '5cf00c03a266b7e1877504ec',
      'and[projectPhase]': '5cf00c03a266b7e1877504f1',
      'and[documentAuthorType]': '5cf00c03a266b7e1877504f6'
    }, 'Document', anonAcl());

    assert.deepStrictEqual(dropped, []);
    assert.ok(filter.includes("typeId eq '5cf00c03a266b7e1877504d9'"));
    assert.ok(filter.includes("milestoneId eq '5cf00c03a266b7e1877504ec'"));
    assert.ok(filter.includes("projectPhaseId eq '5cf00c03a266b7e1877504f1'"));
    assert.ok(filter.includes("documentAuthorTypeId eq '5cf00c03a266b7e1877504f6'"));
  });

  // A date range is a RANGE on the base field, and the End edge is `lt <next day>` rather than
  // `le <that day>`: the wire carries a calendar day and the field is an instant, so `le` would
  // exclude everything posted after midnight on the day the user included.
  await t.test('datePostedStart/End become a half-open range on datePosted', () => {
    const { filter, dropped } = eagleQuery.buildFilter({
      'and[datePostedStart]': '2024-01-15',
      'and[datePostedEnd]': '2024-01-16'
    }, 'Document', anonAcl());

    assert.deepStrictEqual(dropped, []);
    assert.ok(filter.includes('datePosted ge 2024-01-15T00:00:00.000Z'), filter);
    assert.ok(filter.includes('datePosted lt 2024-01-17T00:00:00.000Z'), filter);
  });

  // An unparseable date is a dropped key, never an omitted clause: a range that silently does not
  // apply returns the whole corpus under a 200, which is the failure this whole module exists for.
  await t.test('an unusable date edge is dropped, not silently ignored', () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[datePostedStart]': 'last-tuesday' }, 'Document', anonAcl());

    assert.deepStrictEqual(dropped, ['datePostedStart']);
    assert.ok(!filter.includes('datePosted'), 'no clause may be built from an unusable date');
  });

  // The suffix is resolved against the index, not against a list of known date fields, so a
  // suffixed name with no base field behind it still drops instead of reaching OData.
  await t.test('a Start suffix on a field the index lacks is dropped', () => {
    const { dropped } = eagleQuery.buildFilter(
      { 'and[dateAddedStart]': '2024-01-15' }, 'Document', anonAcl());
    assert.deepStrictEqual(dropped, ['dateAddedStart']);
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

  // Every project-list filter except `region` used to answer with the WHOLE corpus. Measured
  // against the live test service before the fix: `and[eacDecision]=<id>` returned 393 of 393
  // projects under a 200, and `and[currentPhaseName]=<id>` and `and[CEAAInvolvement]=<id>` did the
  // same, because none of the three fields existed in the index and every one landed in `dropped`.
  await t.test('the three id-valued project facets redirect to their id columns', () => {
    const { filter, dropped } = eagleQuery.buildFilter({
      'and[eacDecision]': '5e27937a749c83437054f214',
      'and[currentPhaseName]': '5d3f6c7eda7a384218296037',
      'and[CEAAInvolvement]': '5e27937a749c83437054f1ff'
    }, 'Project', anonAcl('id'));

    assert.deepStrictEqual(dropped, []);
    assert.ok(filter.includes("eacDecisionId eq '5e27937a749c83437054f214'"));
    assert.ok(filter.includes("currentPhaseNameId eq '5d3f6c7eda7a384218296037'"));
    assert.ok(filter.includes("ceaaInvolvementId eq '5e27937a749c83437054f1ff'"));
  });

  // DEMI stores Track's spelling and eagle-public sends Eagle's. The literals on both sides are
  // written out rather than read from VALUE_ALIASES: a test that maps through the same table it is
  // checking passes whatever the table says, including nothing.
  await t.test('a project type is translated from the wire vocabulary to the stored one', () => {
    const { filter } = eagleQuery.buildFilter(
      { 'and[type]': 'Energy-Electricity,Tourist Destination Resorts' }, 'Project', anonAcl('id'));

    assert.ok(filter.includes("type eq 'Energy - Electricity'"));
    assert.ok(filter.includes("type eq 'Tourist Destination Resort'"));
    assert.ok(!filter.includes("type eq 'Energy-Electricity'"),
      'the wire spelling matches 0 of the 95 rows that hold this type');
  });

  // Six of the ten options already agree, and an unlisted value must survive rather than be
  // dropped — Track can add a type without this table hearing about it.
  await t.test('a project type the map does not list passes through unchanged', () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[type]': 'Mines' }, 'Project', anonAcl('id'));

    assert.deepStrictEqual(dropped, []);
    assert.ok(filter.includes("type eq 'Mines'"));
  });

  await t.test('the decision date range is half-open, on the project index too', () => {
    const { filter, dropped } = eagleQuery.buildFilter({
      'and[decisionDateStart]': '2010-01-01',
      'and[decisionDateEnd]': '2010-12-31'
    }, 'Project', anonAcl('id'));

    assert.deepStrictEqual(dropped, []);
    assert.ok(filter.includes('decisionDate ge 2010-01-01T00:00:00.000Z'));
    assert.ok(filter.includes('decisionDate lt 2011-01-01T00:00:00.000Z'),
      'a decision issued during 31 December is inside a range that names that day');
  });

  // Cosmos keeps `proponentName` and nothing at all for PCP, so there is no column for either to
  // point at. Dropped and reported, never emitted and hoped for.
  await t.test('project facets DEMI holds no data for are dropped, not emitted', () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[proponent]': '58850f69aaecd9001b8085cc', 'and[pcp]': 'open' },
      'Project', anonAcl('id'));

    assert.deepStrictEqual(dropped.sort(), ['pcp', 'proponent']);
    assert.strictEqual(filter, "read/any(r: search.in(r, 'public', ','))");
  });

  // The alias table is a FILTER redirect. Sorting the Phase column by an ObjectId would order the
  // list by hex; `currentPhaseNameId` is `sortable: false` precisely so this falls back.
  await t.test('sorting by phase orders on the label, not on the id it filters by', () => {
    const { orderby, dropped } = eagleQuery.buildOrderBy('-currentPhaseName', 'Project', false);

    assert.deepStrictEqual(dropped, []);
    assert.ok(orderby.startsWith('currentPhaseName desc'), orderby);
    assert.ok(!orderby.includes('currentPhaseNameId'));
  });

  await t.test('a quote in a value is escaped by doubling', () => {
    const { filter } = eagleQuery.buildFilter({ 'and[region]': "O'Brien" }, 'Project', anonAcl('id'));
    assert.ok(filter.includes("region eq 'O''Brien'"));
  });

  // THE GATE IS THE FIELD'S TYPE, NOT `filterable`. `projects.centroid` is an
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

  // INVERTED 2026-08-22, deliberately. This asserted that `-datePosted` was dropped, which was true
  // while `documents` had no date field at all. It now has one, `sortable: true`, and this is
  // eagle-public's DEFAULT document sort (documents-tab.component.ts:56) — so the old assertion
  // pinned the very gap the index change closed.
  await t.test('the default document sort the frontend sends is emitted, not dropped', () => {
    const { orderby, dropped } = eagleQuery.buildOrderBy('-datePosted', 'Document', false);
    assert.deepStrictEqual(dropped, []);
    assert.strictEqual(orderby, 'datePosted desc, id asc');
  });

  await t.test('a field that is genuinely not in the index is still dropped', () => {
    const { orderby, dropped } = eagleQuery.buildOrderBy('-popularity', 'Document', false);
    assert.deepStrictEqual(dropped, ['popularity']);
    assert.ok(!orderby.includes('popularity'), 'a name the index lacks is a 400 on every query');
  });

  // The alias table redirects a FILTER key onto its id column, and sorting has to go the other way:
  // `typeId` is `sortable: false` (an opaque ObjectId sorts to nothing a reader recognises), while
  // the `type` LABEL beside it sorts. Without the fallback, sorting the Document type column would
  // drop silently and the table would keep whatever order the service returned.
  // A repeated field cannot change the order — the first occurrence already decided it — so the
  // second is noise at best. eagle-public gets there on its own: it appends a secondary sort that
  // can repeat the primary one.
  //
  // The second case is the one a clause CAP would have had to catch, and it is why there is no cap:
  // 60 names the index does not carry are all dropped, so `parts` never grows. A cap could not fire
  // on any demi index (`documents` has 17 fields in total against Azure's limit of 32), and the
  // test that claimed to exercise one passed with the guard deleted.
  await t.test('a repeated sort field is emitted once', () => {
    const { orderby } = eagleQuery.buildOrderBy(
      ['-displayName', '+displayName'], 'Document', false);
    assert.strictEqual(orderby, 'displayName desc, id asc', 'the second mention adds no clause');

    const many = Array.from({ length: 60 }, (_, i) => `field${i}`).concat('displayName');
    const { orderby: capped, dropped } = eagleQuery.buildOrderBy(many, 'Document', false);
    assert.strictEqual(capped, 'displayName asc, id asc');
    assert.strictEqual(dropped.length, 60, 'a name the index lacks is dropped, never emitted');
  });

  // The tiebreak used to be appended after the dedupe rather than through it, so sorting by the
  // tiebreak field itself emitted it twice. `_id` arrives here as `id` via the alias table, and a
  // keywordless `?dataset=Document&sortBy=id` now reaches the index where it used to take the
  // Cosmos list path and be ignored.
  await t.test('sorting BY the tiebreak field does not emit it twice', () => {
    for (const sortBy of ['id', '_id']) {
      assert.strictEqual(eagleQuery.buildOrderBy(sortBy, 'Document', false).orderby, 'id asc',
        `${sortBy} must not produce "id asc, id asc"`);
    }
    assert.strictEqual(eagleQuery.buildOrderBy('-id', 'Document', false).orderby, 'id desc',
      'the caller\'s direction wins, and the tiebreak is already satisfied');
  });

  // `categorized` is not in any demi index, and it counts as criteria — so it routes the caller to
  // the index and would otherwise vanish with nothing said anywhere.
  await t.test('categorized on an index that lacks it is reported as dropped', () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { categorized: 'true' }, 'Document', anonAcl());
    assert.deepStrictEqual(dropped, ['categorized']);
    assert.ok(!filter.includes('categorized'));
  });

  await t.test('a sort on an aliased key falls back to the caller name the index CAN sort', () => {
    const { orderby, dropped } = eagleQuery.buildOrderBy('+type', 'Document', false);
    assert.deepStrictEqual(dropped, []);
    assert.strictEqual(orderby, 'type asc, id asc');
  });

  // THE GATE IS THE FIELD'S TYPE, NOT `sortable` — the same defect S1 fixed for filters.
  // `projects.centroid` is an `Edm.GeographyPoint` declared `sortable: true`, and AI Search orders a
  // geography only through `geo.distance(...)`, so `centroid asc` is a 400. 400 is not retried,
  // `request()` throws, and the controller answers 502 — to any anonymous `?dataset=Project&
  // keywords=x&sortBy=centroid`.
  await t.test('a sortable field whose TYPE cannot be ordered is dropped, not emitted', () => {
    const { orderby, dropped } = eagleQuery.buildOrderBy('centroid', 'Project', false);

    assert.deepStrictEqual(dropped, ['centroid']);
    assert.ok(!orderby.includes('centroid'), 'a geography name must never reach $orderby');
    assert.strictEqual(orderby, 'name asc, id asc', 'the sort falls back to the stable default');
  });

  // The control for the drop above: a scalar field the index CAN sort still sorts. Without this the
  // assertion is satisfied by dropping every sort, which would measure nothing.
  await t.test('an ordinary sortable string field still orders', () => {
    const { orderby, dropped } = eagleQuery.buildOrderBy('-proponent', 'Project', false);
    assert.deepStrictEqual(dropped, []);
    assert.strictEqual(orderby, 'proponent desc, id asc');
  });

  // Every field in chunks is sortable:false, the key included. There is nothing to name, so
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

test('a boolean value OData cannot express is dropped, not coerced to false', () => {
  // `v === 'true'` alone made every other value mean `eq false`, so `and[isPublished]=True`
  // applied the OPPOSITE filter under a 200 with nothing reported lost.
  // NOT the empty string: `valuesOf` filters blanks out, so `and[isPublished]=` carries no value
  // to express and reports nothing — a different case from a value that cannot be expressed.
  for (const v of ['1', 'True', 'TRUE', 'yes', 'banana']) {
    const out = eagleQuery.buildFilter({ 'and[isPublished]': v }, 'Document', { filter: null, empty: false });
    assert.strictEqual(out.filter, undefined, `${v} must not build a filter`);
    assert.deepStrictEqual(out.dropped, ['isPublished'], `${v} must be reported dropped`);
  }
  // The control: the two literals OData does define must still filter, or the assertion above is
  // satisfied by dropping everything.
  for (const [v, expected] of [['true', true], ['false', false]]) {
    const out = eagleQuery.buildFilter({ 'and[isPublished]': v }, 'Document', { filter: null, empty: false });
    assert.strictEqual(out.filter, `isPublished eq ${expected}`);
    assert.deepStrictEqual(out.dropped, []);
  }
});

test('every semantic configuration is named for its own index', () => {
  // `semanticConfigurationFor(index)` derives `<index>-semantic` at request time, so the DEFINITION
  // has to follow the same convention or the app asks a real index for a configuration it does not
  // have. That is a hard 400, not a degrade: semantic is on by default for chunk search and 400 is
  // not in RETRY_STATUSES. Nothing else couples the two — every other assertion pins the DERIVED
  // string, so the definition file could drift with the whole suite green.
  const dir = path.join(__dirname, '..', '..', 'azure', 'search', 'indexes');
  const defs = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));

  const withSemantic = defs.filter(d => d.semantic && d.semantic.configurations);
  assert.ok(withSemantic.length > 0, 'no index declares a semantic configuration — the convention is unguarded');

  for (const def of withSemantic) {
    for (const cfg of def.semantic.configurations) {
      assert.strictEqual(
        cfg.name, `${def.name}-semantic`,
        `${def.name}: semantic configuration is "${cfg.name}", but the app will ask for ` +
        `"${def.name}-semantic" and a mismatch is a 400 on every semantic query`
      );
    }
  }
});

test('every DATASET_INDEX value names an index definition that is actually on disk', () => {
  // The guard that makes the staged index rename safe. DATASET_INDEX is a SCHEMA lookup — it picks
  // which `azure/search/indexes/*.json` to read field metadata from — while SEARCH_INDEX* name the
  // live indexes. Getting this one wrong is invisible: `fieldsFor` falls back to an empty Map, so
  // every filter and every sort is silently dropped and the caller gets a 200 over the WHOLE
  // corpus, which is exactly what eagle-search measured (60,560 rows for a filtered question).
  const dir = path.join(__dirname, '..', '..', 'azure', 'search', 'indexes');
  const onDisk = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).name);

  for (const [dataset, index] of Object.entries(eagleQuery.DATASET_INDEX)) {
    assert.ok(onDisk.includes(index), `${dataset} -> '${index}' has no definition; on disk: ${onDisk}`);
  }
});
