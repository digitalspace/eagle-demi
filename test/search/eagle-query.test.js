'use strict';

/**
 * Query translation for eagle-public; assertions use wire strings it sends, since the bug class is
 * a request that succeeds and answers the wrong rows.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const eagleQuery = require('../../src/search/eagle-query');
const { filterFor } = require('../../src/helpers/access-odata');
const { resolveAccess, systemAccess } = require('../../src/helpers/access-sql');
const chunksRepo = require('../../src/repositories/chunks');
const { catalogFor } = require('../../src/vis/catalog');

const anonymous = () => resolveAccess({ header: () => null });
const anonAcl = (field) => filterFor(anonymous(), field);
/** What an anonymous caller's ACL clause is on its own: the public roles, minus the sealed rows. */
const ANON_FILTER =
  "read/any(r: search.in(r, 'public', ',')) and not read/any(r: r eq 'compliance')";
// Every Document read carries the Update-image exclusion ahead of the ACL clause.
const DOC_ANON_FILTER = `documentSource ne 'UPDATE' and ${ANON_FILTER}`;

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

  // Fail closed: no OData filter means "nothing" and an empty $filter is unrestricted, so
  // `empty` must refuse to build a request.
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

  // Express 5 parses `and[type]=x` as a literal key, `qs`/extended as a nested object; reading
  // only one shape drops every filter and returns the whole corpus.
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

  // An unknown field is an OData 400 that eagle-public shows as an empty table. The example must
  // be a name the index lacks; change it if the index gains `documentAuthor`.
  await t.test('a filter key the index does not carry is dropped and reported', () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[documentAuthor]': 'Ministry of Mines' }, 'Document', anonAcl());

    assert.deepStrictEqual(dropped, ['documentAuthor']);
    assert.ok(!filter.includes('documentAuthor'), 'a name the index lacks must never reach OData');
    assert.strictEqual(filter, DOC_ANON_FILTER);
  });

  // eagle-public sends these as List ObjectIds; on the label columns they match nothing and
  // the empty table reads as "no documents", not as a broken filter.
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

  // End is `lt <next day>`, not `le <that day>`: the wire sends a day and the field is an
  // instant, so `le` would drop everything after midnight on the included day.
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

  // `read` is filterable, so without the visibility gate (`defaultVis: 0`) a caller could add a
  // clause about their own ACL.
  await t.test('a caller cannot filter their way past the ACL clause', () => {
    const { filter, dropped } = eagleQuery.buildFilter({ 'and[read]': 'staff' }, 'Document',
      anonAcl(), anonymous());

    assert.deepStrictEqual(dropped, ['read']);
    assert.strictEqual(filter, DOC_ANON_FILTER);
  });

  // `searchVis` is filterable for the native list's own level clause; a caller-built count over it
  // would say which documents carry a narrower dial.
  await t.test('and[searchVis] is dropped for staff', () => {
    const staff = resolveAccess({ header: () => null, user: { realm_access: { roles: ['staff'] } } });
    const { filter, dropped } = eagleQuery.buildFilter({ 'and[searchVis]': '1' }, 'Document',
      filterFor(staff, 'projectId'), staff);

    assert.strictEqual(staff.level, 2);
    assert.deepStrictEqual(dropped, ['searchVis']);
    assert.ok(!filter.includes('searchVis'), filter);
  });

  // The contrast that makes the drop above the visibility gate, not an unknown or unfilterable field.
  await t.test('and[searchVis] reaches the filter for the system caller', () => {
    const system = systemAccess();
    const { filter, dropped } = eagleQuery.buildFilter({ 'and[searchVis]': '1' }, 'Document',
      filterFor(system, 'projectId'), system);

    assert.deepStrictEqual(dropped, []);
    assert.ok(filter.includes('searchVis eq 1'), filter);
  });

  // `_id` on the wire is the Eagle ObjectId, held in `legacyEagleId` on a project. Cosmos half of
  // this table: search.id-filter.test.js.
  await t.test('and[_id] lands on each index dataset\'s Eagle id field, never dropped', () => {
    for (const [dataset, field, scope] of [
      ['Project', 'legacyEagleId', 'id'],
      ['Document', 'id', 'projectId'],
      ['DocumentChunk', 'chunkId', 'projectId']
    ]) {
      const { filter, dropped } = eagleQuery.buildFilter(
        { 'and[_id]': '588511c4aaecd9001b826192' }, dataset, anonAcl(scope));
      assert.ok(filter.includes(`${field} eq '588511c4aaecd9001b826192'`), `${dataset}: ${filter}`);
      assert.deepStrictEqual(dropped, [], dataset);
    }
  });

  await t.test('a project filter on an index with no project axis is dropped, not ignored', () => {
    const { dropped } = eagleQuery.buildFilter({ project: '207' }, 'Project', anonAcl('id'));
    assert.deepStrictEqual(dropped, ['project']);
  });

  // eagle-public sends ids for these three; the index has them only on the `*Id` columns, so
  // without the redirect each is dropped and the whole corpus comes back.
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

  // DEMI stores Track's spelling or Eagle's by origin, so both must match. Literals written out,
  // not read from VALUE_ALIASES, so the test cannot pass by construction.
  await t.test('a project type matches both the wire spelling and the stored one', () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[type]': 'Energy-Electricity,Tourist Destination Resorts' }, 'Project', anonAcl('id'));

    assert.deepStrictEqual(dropped, []);
    assert.ok(filter.includes("type eq 'Energy - Electricity'"),
      "Track's spelling holds 95 of the rows");
    assert.ok(filter.includes("type eq 'Energy-Electricity'"),
      "Eagle-only projects keep Eagle's spelling verbatim");
    assert.ok(filter.includes("type eq 'Tourist Destination Resort'"));
    assert.ok(filter.includes("type eq 'Tourist Destination Resorts'"));
  });

  await t.test("a project type sent in Track's spelling also matches Eagle's", () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[type]': 'Energy - Electricity' }, 'Project', anonAcl('id'));

    assert.deepStrictEqual(dropped, []);
    assert.ok(filter.includes("(type eq 'Energy - Electricity' or type eq 'Energy-Electricity')"), filter);
  });

  // The lost-value report counts wire values, not spellings; one value can expand to two terms.
  await t.test('expanding a type into two spellings is not reported as a lost value', () => {
    const { dropped } = eagleQuery.buildFilter(
      { 'and[type]': 'Energy-Electricity,Mines' }, 'Project', anonAcl('id'));
    assert.deepStrictEqual(dropped, []);
  });

  // Six of the ten options already agree, and an unlisted value must survive rather than be
  // dropped — Track can add a type without this table hearing about it.
  await t.test('a project type the map does not list passes through unchanged', () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[type]': 'Mines' }, 'Project', anonAcl('id'));

    assert.deepStrictEqual(dropped, []);
    assert.ok(filter.includes("type eq 'Mines'"));
  });

  // A row with no sector shows Track's sub-type as its sector, so the filter has to reach it too.
  await t.test('and[sector] also matches a row with no sector whose sub-type shows as the value', () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[sector]': 'Oil Refineries' }, 'Project', anonAcl('id'));

    assert.deepStrictEqual(dropped, []);
    assert.strictEqual(filter,
      "(sector eq 'Oil Refineries' or ((sector eq null or sector eq '') and projectSubType eq 'Oil Refineries'))" +
      ` and ${ANON_FILTER}`);
  });

  await t.test('and[sector] maps a renamed sub-type back to the name Track stores', () => {
    const { filter } = eagleQuery.buildFilter(
      { 'and[sector]': 'Electric Transmission Lines' }, 'Project', anonAcl('id'));
    assert.ok(filter.includes(
      "((sector eq null or sector eq '') and (projectSubType eq 'Electric Transmission Lines' or " +
      "projectSubType eq 'Transmission Lines'))"), filter);
  });

  // Marine ports were renamed between the Acts, so the stored name shows one way per Act.
  await t.test('and[sector] reads a renamed sub-type under the Act it shows for', () => {
    const old = eagleQuery.buildFilter({ 'and[sector]': 'Marine Port Facilities' }, 'Project', anonAcl('id'));
    assert.ok(old.filter.includes(
      "(projectSubType eq 'Marine Port Projects' and legislationYear le 2002)"), old.filter);

    const current = eagleQuery.buildFilter({ 'and[sector]': 'Marine Port Projects' }, 'Project', anonAcl('id'));
    assert.ok(current.filter.includes(
      "((sector eq null or sector eq '') and (projectSubType eq 'Marine Port Projects' and " +
      '(legislationYear eq null or legislationYear gt 2002)))'), current.filter);
  });

  await t.test('a multi-select and[sector] carries the fallback per value, and quotes it', () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[sector]': "Mines,O'Brien" }, 'Project', anonAcl('id'));
    assert.deepStrictEqual(dropped, []);
    assert.ok(filter.includes("projectSubType eq 'Mines'"), filter);
    assert.ok(filter.includes("projectSubType eq 'O''Brien'"), filter);
  });

  // Empty `and[type]=` means no filter, the same reading `typeCriteria` gives it in
  // `src/repositories/updates.js`.
  await t.test('an empty and[type]= adds no clause and is not reported dropped', () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[type]': '' }, 'Project', anonAcl('id'));

    assert.deepStrictEqual(dropped, []);
    assert.strictEqual(filter, ANON_FILTER);
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

  // Cosmos keeps no comment-period status at all, so there is no column for PCP to point at.
  // Dropped and reported, never emitted and hoped for.
  await t.test('project facets DEMI holds no data for are dropped, not emitted', () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[pcp]': 'open' }, 'Project', anonAcl('id'));

    assert.deepStrictEqual(dropped, ['pcp']);
    assert.strictEqual(filter, ANON_FILTER);
  });

  // The facet sends an Organization ObjectId; `proponent` holds the name, `proponentId` the id.
  await t.test('the proponent facet filters on proponentId, not on the name column', () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[proponent]': '58850f69aaecd9001b8085cc' }, 'Project', anonAcl('id'));

    assert.deepStrictEqual(dropped, []);
    assert.ok(filter.includes("proponentId eq '58850f69aaecd9001b8085cc'"), filter);
    assert.ok(!/proponent eq /.test(filter),
      'an ObjectId compared against the name column matches nothing under a 200');
  });

  await t.test('two proponents are an OR, not two ANDs that match nothing', () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[proponent]': '58850f69aaecd9001b8085cc,58850f69aaecd9001b8085cd' },
      'Project', anonAcl('id'));

    assert.deepStrictEqual(dropped, []);
    assert.ok(filter.includes(
      "(proponentId eq '58850f69aaecd9001b8085cc' or proponentId eq '58850f69aaecd9001b8085cd')"),
    filter);
  });

  // The alias table redirects filters only; `proponentId` and `currentPhaseNameId` are
  // `sortable: false` so sorting stays on the name, not hex ObjectIds.
  await t.test('sorting by proponent orders on the name, not on the id it filters by', () => {
    const { orderby, dropped } = eagleQuery.buildOrderBy('-proponent', 'Project', false);

    assert.deepStrictEqual(dropped, []);
    assert.ok(orderby.startsWith('proponent desc'), orderby);
    assert.ok(!orderby.includes('proponentId'));
  });

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

  // The gate is the field's type, not `filterable`: `centroid` is a filterable GeographyPoint,
  // and `centroid eq 'x'` is an OData 400.
  await t.test('a filterable field whose TYPE has no term is dropped, not quoted', () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[centroid]': 'x' }, 'Project', anonAcl('id'));

    assert.deepStrictEqual(dropped, ['centroid']);
    assert.ok(!filter.includes('centroid'), 'a geography field must never reach OData as `eq`');
    assert.strictEqual(filter, ANON_FILTER);
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

/**
 * The name cell of the unified search grid. Typing "sediment" has to find "Sediment Sampling Plan",
 * which `and[displayName]` cannot do — it renders `eq`, so it answers the whole name or nothing.
 */
test('eagle-query nameContains', async (t) => {
  await t.test('Project matches on name, Document on displayName', () => {
    const project = eagleQuery.buildFilter(
      { 'and[nameContains]': 'sediment' }, 'Project', anonAcl());
    const document = eagleQuery.buildFilter(
      { 'and[nameContains]': 'sediment' }, 'Document', anonAcl());

    assert.deepStrictEqual(project.dropped, []);
    assert.deepStrictEqual(document.dropped, []);
    assert.ok(
      project.filter.includes("search.ismatch('sediment*', 'name,nameTokens', 'full', 'any')"),
      project.filter);
    assert.ok(
      document.filter.includes("search.ismatch('sediment*', " +
        "'displayName,documentFileName,fileNameTokens', 'full', 'any')"),
      document.filter);
    // The ACL clause is still ANDed on, exactly as it is for a term filter.
    assert.ok(project.filter.includes("read/any(r: search.in(r, 'public', ','))"));
  });

  // en.microsoft drops "mine" as a stopword from `name` and `displayName`; `nameTokens` and
  // `fileNameTokens` hold the same text under the `filename` analyzer, which keeps it.
  await t.test('a name made only of stopwords still names a field that holds the word', () => {
    const project = eagleQuery.buildFilter(
      { 'and[nameContains]': 'mine' }, 'Project', anonAcl());
    const document = eagleQuery.buildFilter(
      { 'and[nameContains]': 'mine' }, 'Document', anonAcl());

    assert.deepStrictEqual(project.dropped, []);
    assert.deepStrictEqual(document.dropped, []);
    // No `*`: a stopword carries no prefix, so the term is the literal the `filename` analyzer
    // holds. The field list is what makes it reachable.
    assert.ok(project.filter.includes("search.ismatch('mine', 'name,nameTokens', 'full', 'any')"),
      project.filter);
    assert.ok(
      document.filter.includes("search.ismatch('mine', " +
        "'displayName,documentFileName,fileNameTokens', 'full', 'any')"),
      document.filter);
  });

  // "mine report" must not answer the same rows as "report" alone: both words are required.
  await t.test('a stopword beside a real word is still required, not ignored', () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[nameContains]': 'mine report' }, 'Document', anonAcl());

    assert.deepStrictEqual(dropped, []);
    assert.ok(
      filter.includes("search.ismatch('mine AND report*', " +
        "'displayName,documentFileName,fileNameTokens', 'full', 'any')"),
      filter);
  });

  // A row count over a hidden field leaks its value, so every field in the clause must be
  // readable. `nameTokens` is public in the catalog, so it is hidden here and put back.
  await t.test('one field hidden from this caller drops the whole key', () => {
    const catalog = catalogFor('index-projects');
    const restore = catalog.nameTokens.defaultVis;
    catalog.nameTokens.defaultVis = 0;
    try {
      const { filter, dropped } = eagleQuery.buildFilter(
        { 'and[nameContains]': 'sediment' }, 'Project', anonAcl(), anonymous());

      assert.deepStrictEqual(dropped, ['nameContains']);
      assert.ok(!filter.includes('search.ismatch'), filter);
    } finally {
      catalog.nameTokens.defaultVis = restore;
    }
  });

  // Every field named has to be one the index can actually search — a stray name is a 400 on every
  // request carrying the key, which is the one failure the unit test above cannot see.
  await t.test('every field in the list is searchable in the committed index', () => {
    const indexes = { Project: 'projects.json', Document: 'documents.json' };
    for (const [dataset, fields] of Object.entries(eagleQuery.NAME_CONTAINS_FIELDS)) {
      const definition = JSON.parse(fs.readFileSync(
        path.join(__dirname, '../../azure/search/indexes', indexes[dataset]), 'utf8'));
      for (const name of fields) {
        const field = definition.fields.find(f => f.name === name);
        assert.ok(field, `${dataset}: ${name} is not a field of ${indexes[dataset]}`);
        assert.strictEqual(field.searchable, true, `${dataset}: ${name} is not searchable`);
      }
    }
  });

  // A one-character word gets no `*`: the service truncates a one-letter expansion instead of
  // erroring, which answers from an arbitrary slice of the vocabulary.
  await t.test('words are ANDed and words of two or more characters match as a prefix', () => {
    const { filter } = eagleQuery.buildFilter(
      { 'and[nameContains]': 'Site C dam' }, 'Project', anonAcl());
    assert.ok(filter.startsWith("search.ismatch('Site* AND C AND dam*', 'name,nameTokens', 'full', 'any')"),
      filter);

    // Two characters is the shortest word that prefixes, as the swagger says; 'Site C dam' alone
    // cannot tell a floor of 2 from 3.
    const { filter: twoChar } = eagleQuery.buildFilter(
      { 'and[nameContains]': 'BC Hydro' }, 'Project', anonAcl());
    assert.ok(twoChar.startsWith("search.ismatch('BC* AND Hydro*', 'name,nameTokens', 'full', 'any')"),
      twoChar);
  });

  // A word the query analyzer removes must not carry the `*`: `of*` is a literal the index does not
  // hold, and one unsatisfiable term under the AND join answers 0 rows for a document that exists.
  await t.test('a stopword in the typed name keeps the word but not the prefix', () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[nameContains]': 'Notice of Commencement' }, 'Document', anonAcl());

    assert.deepStrictEqual(dropped, []);
    assert.ok(
      filter.startsWith(
        "search.ismatch('Notice* AND of AND Commencement*', " +
        "'displayName,documentFileName,fileNameTokens', 'full', 'any')"),
      filter);
  });

  // The whole reason the key is separate: these characters are Lucene syntax, and an unescaped one
  // is a 400 from the search service rather than a search for that character.
  await t.test("a typed ', ( and * cannot reach the query as syntax", () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[nameContains]': "O'Brien (2019) *" }, 'Document', anonAcl());

    assert.deepStrictEqual(dropped, []);
    // One single quote doubled for the OData literal; the brackets and the typed star separate
    // words rather than survive as text. The `*` on each word is the one this file appends.
    assert.ok(
      filter.startsWith("search.ismatch('O''Brien* AND 2019*', " +
      "'displayName,documentFileName,fileNameTokens', 'full', 'any')"),
      filter);

    // A hyphen breaks the word: the analyzer holds `site` and `c` as separate index tokens, so the
    // hyphenated prefix would match nothing.
    const { filter: hyphen } = eagleQuery.buildFilter(
      { 'and[nameContains]': 'Site-C' }, 'Project', anonAcl());
    assert.ok(hyphen.startsWith("search.ismatch('Site* AND C', 'name,nameTokens', 'full', 'any')"), hyphen);
  });

  // A comma is a word break, not a multi-select: `valuesOf` would split the name in two, and
  // `LNG,*` skips the analyzer so no index token matches.
  await t.test('a comma breaks words and is not a multi-select', () => {
    const { filter } = eagleQuery.buildFilter(
      { 'and[nameContains]': 'Kitimat LNG, Phase 2' }, 'Project', anonAcl());

    assert.ok(filter.includes("'Kitimat* AND LNG* AND Phase* AND 2'"), filter);
    assert.ok(!/ or /.test(filter), 'a comma must not become an OR');

    const { filter: brackets } = eagleQuery.buildFilter(
      { 'and[nameContains]': 'Site C (Phase 2)' }, 'Project', anonAcl());
    assert.ok(brackets.includes("'Site* AND C AND Phase* AND 2'"), brackets);
  });

  // Punctuation alone leaves no word to require, so it has to land where the empty value lands
  // rather than build a clause over nothing.
  await t.test('an empty, blank or punctuation-only value adds no clause and is not reported dropped', () => {
    for (const value of ['', '   ', ', ()']) {
      const { filter, dropped } = eagleQuery.buildFilter(
        { 'and[nameContains]': value }, 'Project', anonAcl());

      assert.deepStrictEqual(dropped, [], `${JSON.stringify(value)} is not a dropped filter`);
      assert.ok(!filter.includes('search.ismatch'), `${JSON.stringify(value)} adds no clause`);
    }
  });

  // No name column on these indexes. The endpoint answers 400; `buildFilter` alone reports the
  // key dropped rather than widening to the whole corpus.
  await t.test('a dataset with no name cell drops the key and renders no clause', () => {
    for (const dataset of ['DocumentChunk', 'RecentActivity']) {
      const { filter, dropped } = eagleQuery.buildFilter(
        { 'and[nameContains]': 'sediment' }, dataset, anonAcl());

      assert.deepStrictEqual(dropped, ['nameContains'], dataset);
      assert.ok(!filter.includes('search.ismatch'), dataset);
    }
  });

  // THE compatibility assertion. eagle-public has saved URLs carrying these two keys; a substring
  // match hiding behind either of them would change what those URLs mean.
  await t.test('and[name] and and[displayName] still render an exact match', () => {
    const project = eagleQuery.buildFilter({ 'and[name]': 'Site C' }, 'Project', anonAcl());
    const document = eagleQuery.buildFilter(
      { 'and[displayName]': 'Site C' }, 'Document', anonAcl());

    assert.ok(project.filter.includes("name eq 'Site C'"), project.filter);
    assert.ok(document.filter.includes("displayName eq 'Site C'"), document.filter);
    assert.ok(!project.filter.includes('search.ismatch'));
    assert.ok(!document.filter.includes('search.ismatch'));
  });

  await t.test('the value is length-capped, and the cap is what the endpoint refuses on', () => {
    const long = 'a'.repeat(eagleQuery.MAX_NAME_CONTAINS + 1);
    const atCap = 'a'.repeat(eagleQuery.MAX_NAME_CONTAINS);

    assert.match(eagleQuery.nameContainsError({ 'and[nameContains]': long }, 'Project'),
      /limited to 200 characters/);
    assert.strictEqual(eagleQuery.nameContainsError({ 'and[nameContains]': atCap }, 'Project'),
      null);
    assert.match(eagleQuery.nameContainsError({ 'and[nameContains]': 'x' }, 'DocumentChunk'),
      /dataset=Project and dataset=Document only/);
    assert.strictEqual(eagleQuery.nameContainsError({ 'and[name]': long }, 'Project'), null,
      'the cap belongs to nameContains, not to every filter key');

    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[nameContains]': long }, 'Project', anonAcl());
    assert.deepStrictEqual(dropped, ['nameContains']);
    assert.ok(!filter.includes('search.ismatch'));
  });

  // Both wire shapes the query parser produces, the same pair `andParams` already handles.
  await t.test('the nested and={} shape is read too', () => {
    const { filter } = eagleQuery.buildFilter(
      { and: { nameContains: 'sediment' } }, 'Project', anonAcl());
    assert.ok(filter.includes("search.ismatch('sediment*', 'name,nameTokens', 'full', 'any')"), filter);
  });
});

test('eagle-query sort', async (t) => {
  // eagle-public sends sortBy TWICE and the second is frequently empty (api.ts:176-177).
  await t.test('the empty second sortBy is ignored, not treated as a field', () => {
    const { orderby } = eagleQuery.buildOrderBy(['-displayName', ''], 'Document');
    assert.strictEqual(orderby, 'displayNameSort desc, id asc');
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

  // `-datePosted` is eagle-public's default document sort (documents-tab.component.ts).
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

  // eagle-public's secondary sort can repeat the primary. No clause cap: unknown names are dropped,
  // and no demi index reaches Azure's 32-clause $orderby limit.
  await t.test('a repeated sort field is emitted once', () => {
    const { orderby } = eagleQuery.buildOrderBy(
      ['-displayName', '+displayName'], 'Document', false);
    assert.strictEqual(orderby, 'displayNameSort desc, id asc', 'the second mention adds no clause');

    const many = Array.from({ length: 60 }, (_, i) => `field${i}`).concat('displayName');
    const { orderby: capped, dropped } = eagleQuery.buildOrderBy(many, 'Document', false);
    assert.strictEqual(capped, 'displayNameSort asc, id asc');
    assert.strictEqual(dropped.length, 60, 'a name the index lacks is dropped, never emitted');
  });

  // The tiebreak goes through the dedupe; `_id` arrives as `id` via the alias table.
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

  // Aliases redirect filters onto `typeId`, which is `sortable: false`; the sort stays on the
  // `type` label, or the type column would drop its sort silently.
  await t.test('a sort on an aliased key falls back to the caller name the index CAN sort', () => {
    const { orderby, dropped } = eagleQuery.buildOrderBy('+type', 'Document', false);
    assert.deepStrictEqual(dropped, []);
    assert.strictEqual(orderby, 'type asc, id asc');
  });

  // The gate is the field's type, not `sortable`: a GeographyPoint orders only through
  // `geo.distance(...)`, so `centroid asc` is a 400 and the controller answers 502.
  await t.test('a sortable field whose TYPE cannot be ordered is dropped, not emitted', () => {
    const { orderby, dropped } = eagleQuery.buildOrderBy('centroid', 'Project', false);

    assert.deepStrictEqual(dropped, ['centroid']);
    assert.ok(!orderby.includes('centroid'), 'a geography name must never reach $orderby');
    assert.strictEqual(orderby, 'name asc, id asc', 'the sort falls back to the stable default');
  });

  // Control for the drop above. `region`, not `proponent`, which has an alias and would test the
  // alias path instead.
  await t.test('an ordinary sortable string field still orders', () => {
    const { orderby, dropped } = eagleQuery.buildOrderBy('-region', 'Project', false);
    assert.deepStrictEqual(dropped, []);
    assert.strictEqual(orderby, 'region desc, id asc');
  });

  // Row order over a hidden field leaks its value. `sector` is public in the catalog, so it is
  // hidden here and put back.
  await t.test('a sort key hidden from this caller is dropped, not emitted', () => {
    const catalog = catalogFor('index-projects');
    const restore = catalog.sector.defaultVis;
    catalog.sector.defaultVis = 0;
    try {
      const { orderby, dropped } = eagleQuery.buildOrderBy(
        '-sector', 'Project', false, anonymous());

      assert.deepStrictEqual(dropped, ['sector']);
      assert.strictEqual(orderby, 'name asc, id asc', 'the sort falls back to the stable default');
    } finally {
      catalog.sector.defaultVis = restore;
    }
  });

  // The DEFAULT order is nobody's request, and it goes through the same gate: hiding `name` leaves
  // the tiebreak alone, not a page ordered on a field this caller may not read.
  await t.test('a hidden default sort field falls back to the tiebreak alone', () => {
    const catalog = catalogFor('index-projects');
    const restore = catalog.name.defaultVis;
    catalog.name.defaultVis = 0;
    try {
      const { orderby, dropped } = eagleQuery.buildOrderBy(null, 'Project', false, anonymous());

      assert.strictEqual(orderby, 'id asc');
      assert.deepStrictEqual(dropped, [], 'the caller asked for nothing, so nothing was dropped');
    } finally {
      catalog.name.defaultVis = restore;
    }
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

  // The bare keys the Cosmos-backed datasets accept. A 400 here empties the news strip, the
  // proponent picker and the comment table at once.
  await t.test('the Cosmos datasets\' own bare parameters are accepted', () => {
    assert.deepStrictEqual(eagleQuery.unknownParams({
      dataset: 'RecentActivity', top: 'true', docIds: 'a|b', period: '5b8',
      companyType: 'Proponent/Certificate Holder', _id: '5b8'
    }), []);
  });

  // `commentPeriods` and `updates` have a project axis but no index, so the answer cannot come
  // from the index definitions.
  await t.test('the Cosmos datasets keyed by project can be scoped to one', () => {
    assert.strictEqual(eagleQuery.canScopeToProject('CommentPeriod'), true);
    assert.strictEqual(eagleQuery.canScopeToProject('RecentActivity'), true);
    assert.strictEqual(eagleQuery.canScopeToProject('Document'), true);
    assert.strictEqual(eagleQuery.canScopeToProject('Project'), false);
    assert.strictEqual(eagleQuery.canScopeToProject('List'), false);
    assert.strictEqual(eagleQuery.canScopeToProject('Comment'), false);
    assert.strictEqual(eagleQuery.canScopeToProject('ProjectNotification'), false);
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
  // Coercing would turn `True` into `eq false`. The empty string is not here: `valuesOf` drops
  // blanks, so `and[isPublished]=` carries no value and reports nothing.
  for (const v of ['1', 'True', 'TRUE', 'yes', 'banana']) {
    const out = eagleQuery.buildFilter({ 'and[isPublished]': v }, 'Document', { filter: null, empty: false });
    assert.strictEqual(out.filter, "documentSource ne 'UPDATE'", `${v} builds only the Update-image default`);
    assert.deepStrictEqual(out.dropped, ['isPublished'], `${v} must be reported dropped`);
  }
  // The control: the two literals OData does define must still filter, or the assertion above is
  // satisfied by dropping everything.
  for (const [v, expected] of [['true', true], ['false', false]]) {
    const out = eagleQuery.buildFilter({ 'and[isPublished]': v }, 'Document', { filter: null, empty: false });
    assert.strictEqual(out.filter, `isPublished eq ${expected} and documentSource ne 'UPDATE'`);
    assert.deepStrictEqual(out.dropped, []);
  }
});

test('every semantic configuration is named for its own index', () => {
  // The app derives `<index>-semantic` at request time; a definition that differs is a 400 on every
  // semantic query. Only this test reads the definition files.
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
  // DATASET_INDEX picks the schema file, SEARCH_INDEX* the live index. A wrong name gives an empty
  // field map, so every filter and sort drops and the whole corpus comes back under a 200.
  const dir = path.join(__dirname, '..', '..', 'azure', 'search', 'indexes');
  const onDisk = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).name);

  for (const [dataset, index] of Object.entries(eagleQuery.DATASET_INDEX)) {
    assert.ok(onDisk.includes(index), `${dataset} -> '${index}' has no definition; on disk: ${onDisk}`);
  }
});

// The catalog gates query keys as well as response fields: a caller who cannot READ a field
// cannot FILTER or SORT on it either, because a narrowed row count answers what the value is.
const INDEX_CATALOG = eagleQuery.DATASET_CATALOG;

test('every ALIASES target is a defaultVis 4 index field', () => {
  for (const [dataset, aliases] of Object.entries(eagleQuery.ALIASES)) {
    const entity = INDEX_CATALOG[dataset];
    if (!entity) continue;
    for (const [wireKey, field] of Object.entries(aliases)) {
      const entry = catalogFor(entity)[field];
      assert.ok(entry, `${dataset}.${wireKey} -> '${field}' is not in ${entity}`);
      // `defaultVis` is what the gate in `fieldVisible` reads; `maxVis` only caps a dial. A
      // `defaultVis: 0, maxVis: 4` entry is hidden from public callers and must fail here.
      assert.strictEqual(entry.defaultVis, 4,
        `${dataset}.${wireKey} -> '${field}' is restricted; filtering on it would answer its value`);
      assert.strictEqual(entry.maxVis, 4,
        `${dataset}.${wireKey} -> '${field}' cannot be dialled up to public`);
    }
  }

  // DocumentChunk is a deliberate exception: the chunks catalog covers the stored chunk, not the
  // index, so DATASET_CATALOG has no entry for it and its aliases still resolve.
  assert.ok(catalogFor('chunks').extractedAt, 'the chunks catalog is over the stored chunk');
  const { filter } = eagleQuery.buildFilter(
    { 'and[document]': 'abc' }, 'DocumentChunk', anonAcl(), anonymous());
  assert.match(filter, /documentId eq 'abc'/);
});

test('DEFAULT_ORDER fields are defaultVis 4', () => {
  for (const [dataset, clause] of Object.entries(eagleQuery.DEFAULT_ORDER)) {
    const field = clause.split(' ')[0];
    const entry = catalogFor(INDEX_CATALOG[dataset])[field];
    assert.ok(entry, `DEFAULT_ORDER.${dataset} sorts on '${field}', which is not catalogued`);
    assert.strictEqual(entry.defaultVis, 4,
      `DEFAULT_ORDER.${dataset} sorts every page on restricted field '${field}'`);
    assert.strictEqual(entry.maxVis, 4,
      `DEFAULT_ORDER.${dataset} sorts on '${field}', which cannot be dialled up to public`);
  }
});

/**
 * `displayNameSort` is the zero-padded `displayName`, so "Item 2" sorts before "Item 10".
 * Sort only: a filter on the padded key matches nothing.
 */
test('eagle-query natural-sort key', async (t) => {
  await t.test('sortBy=displayName orders on the padded key', () => {
    const { orderby, dropped } = eagleQuery.buildOrderBy('displayName', 'Document', false);
    assert.deepStrictEqual(dropped, []);
    assert.strictEqual(orderby, 'displayNameSort asc, id asc');
  });

  await t.test('the keywordless default document order goes through the same mapping', () => {
    const { orderby } = eagleQuery.buildOrderBy(null, 'Document', false, anonymous());
    assert.strictEqual(orderby, 'displayNameSort asc, id asc');
  });

  await t.test('an and[displayName] FILTER is not redirected onto the sort key', () => {
    // The stored key is lowercased and padded, so `displayNameSort eq 'Item 2'` matches zero rows
    // — a silent empty table rather than an error.
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[displayName]': 'Item 2' }, 'Document', anonAcl());
    assert.deepStrictEqual(dropped, []);
    assert.ok(filter.includes("displayName eq 'Item 2'"));
    assert.ok(!filter.includes('displayNameSort'), 'the filter must name the readable column');
  });

  // Field metadata comes from the committed index JSON, so the guard covers a SORT_KEYS target
  // that JSON lacks, not a live index mismatch.
  await t.test('falls back to displayName when the committed index JSON lacks the target field', (t) => {
    const eagleQueryWithout = reloadWithoutField(t, 'documents', 'displayNameSort');

    assert.strictEqual(eagleQueryWithout.buildOrderBy('displayName', 'Document', false).orderby,
      'displayName asc, id asc');
    assert.strictEqual(eagleQueryWithout.buildOrderBy(null, 'Document', false).orderby,
      'displayName asc, id asc', 'the default order falls back too');
  });

  await t.test('every SORT_KEYS target is a defaultVis 4 index field', () => {
    for (const [dataset, keys] of Object.entries(eagleQuery.SORT_KEYS)) {
      for (const [wireKey, field] of Object.entries(keys)) {
        const entry = catalogFor(INDEX_CATALOG[dataset])[field];
        assert.ok(entry, `${dataset}.${wireKey} -> '${field}' is not catalogued`);
        assert.strictEqual(entry.defaultVis, 4,
          `${dataset}.${wireKey} -> '${field}' is restricted, so every sort on it would be dropped`);
      }
    }
  });
});

/** eagle-query reads index metadata once at require time, so reload it against a narrower file. */
function reloadWithoutField(t, index, field) {
  const MODULE = require.resolve('../../src/search/eagle-query');
  const cached = require.cache[MODULE];
  const readFileSync = fs.readFileSync;

  t.mock.method(fs, 'readFileSync', (file, ...rest) => {
    const raw = readFileSync(file, ...rest);
    if (path.basename(String(file)) !== `${index}.json`) return raw;
    const def = JSON.parse(raw);
    def.fields = def.fields.filter(f => f.name !== field);
    return JSON.stringify(def);
  });

  delete require.cache[MODULE];
  t.after(() => { require.cache[MODULE] = cached; });
  return require(MODULE);
}

/**
 * The document facets are ONE table shared by `Document` and `DocumentChunk`, because a chunk
 * carries a copy of its parent document's four ids under the same field names.
 */
test('the document facets cannot drift between the two datasets or the write side', () => {
  const { DOCUMENT_FACETS, ALIASES } = eagleQuery;

  for (const [wireKey, field] of Object.entries(DOCUMENT_FACETS)) {
    assert.strictEqual(ALIASES.Document[wireKey], field,
      `Document.${wireKey} must resolve to '${field}'`);
    assert.strictEqual(ALIASES.DocumentChunk[wireKey], field,
      `DocumentChunk.${wireKey} must resolve to the same field as Document, or a saved filter URL ` +
      'means one thing on documents and another on passages');
  }

  // A facet with no chunk stamp would filter a field nothing fills. List refs, not
  // CHUNK_PARENT_FIELDS: `projectId` is scoped through `projectIdsFrom`, not faceted.
  assert.deepStrictEqual(
    Object.values(DOCUMENT_FACETS).slice().sort(),
    chunksRepo.CHUNK_PARENT_LIST_REFS.slice().sort(),
    'every facet must be a List ref the chunk build stamps onto each chunk');

  // And the index really declares them filterable — the gate `buildFilter` reads.
  const chunkFields = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'azure', 'search', 'indexes', 'chunks.json'), 'utf8')).fields;
  for (const field of Object.values(DOCUMENT_FACETS)) {
    const def = chunkFields.find(f => f.name === field);
    assert.ok(def, `chunks.json declares no '${field}'`);
    assert.strictEqual(def.filterable, true, `chunks.json '${field}' is not filterable`);
  }
});

// "Documents attached" on the activities list. The key asks whether the field is FILLED, and an
// `eq` against the value the caller sent would answer zero rows under a 200.
test('and[documentUrl] filters on presence, not on the URL', async (t) => {
  const acl = anonAcl('projectId');

  await t.test('true keeps the updates that carry a link', () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[documentUrl]': 'true' }, 'RecentActivity', acl, anonymous());

    assert.deepStrictEqual(dropped, []);
    assert.ok(filter.includes("(documentUrl ne null and documentUrl ne '')"), filter);
  });

  // The updates container writes `documentUrl: ''` on some rows and omits it on others, so both
  // spellings of "no attachment" have to be in the clause.
  await t.test('false keeps the ones without, empty string included', () => {
    const { filter } = eagleQuery.buildFilter(
      { 'and[documentUrl]': 'false' }, 'RecentActivity', acl, anonymous());

    assert.ok(filter.includes("(documentUrl eq null or documentUrl eq '')"), filter);
  });

  await t.test('any other value is dropped rather than matched as a URL', () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[documentUrl]': 'https://example.test/a.pdf' }, 'RecentActivity', acl, anonymous());

    assert.deepStrictEqual(dropped, ['documentUrl']);
    assert.ok(!filter.includes('documentUrl'), filter);
  });

  // Every presence key still has to name a real, filterable, catalogued field of its index.
  await t.test('the presence keys name fields their index can answer', () => {
    for (const [dataset, keys] of Object.entries(eagleQuery.PRESENCE_KEYS)) {
      const indexName = eagleQuery.DATASET_INDEX[dataset];
      const fields = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', '..', 'azure', 'search', 'indexes', `${indexName}.json`),
        'utf8')).fields;
      for (const key of keys) {
        const def = fields.find(f => f.name === key);
        assert.ok(def, `${indexName}.json declares no '${key}'`);
        assert.strictEqual(def.filterable, true, `${indexName}.json '${key}' is not filterable`);
        assert.ok(catalogFor(eagleQuery.DATASET_CATALOG[dataset])[key],
          `'${key}' is uncatalogued, so fieldVisible would drop it`);
      }
    }
  });
});

// The projects index gained `dateUpdated` so the search page can sort by most recently changed.
// Nothing maps the name — it is the field's TYPE and flags that decide, so this is the whole gate.
test('Project accepts sortBy=-dateUpdated', () => {
  const { orderby, dropped } = eagleQuery.buildOrderBy('-dateUpdated', 'Project', false, anonymous());

  assert.deepStrictEqual(dropped, []);
  assert.ok(orderby.startsWith('dateUpdated desc'), orderby);
});

test('Update-form images stay out of Document reads', async (t) => {
  // No ACL clause at all, the privileged shape: without the default this read is unfiltered.
  const noAcl = { filter: null, empty: false };

  await t.test('an unfiltered read still leaves them out', () => {
    const { filter } = eagleQuery.buildFilter({}, 'Document', noAcl, anonymous());

    assert.strictEqual(filter, "documentSource ne 'UPDATE'");
  });

  await t.test('a caller filtering on documentSource gets their own clause instead', () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[documentSource]': 'UPDATE' }, 'Document', noAcl, anonymous());

    assert.deepStrictEqual(dropped, []);
    assert.strictEqual(filter, "documentSource eq 'UPDATE'");
  });

  // A key that never became a clause has not chosen a source, so the default stays.
  await t.test('a documentSource filter that expresses nothing keeps the default', () => {
    const { filter, dropped } = eagleQuery.buildFilter(
      { 'and[documentSource]': 'UPDATE' }, 'Document', noAcl, anonymous(),
      { unexpressible: ['documentSource'] });

    assert.deepStrictEqual(dropped, ['documentSource']);
    assert.strictEqual(filter, "documentSource ne 'UPDATE'");
  });

  await t.test('other datasets carry no documentSource clause', () => {
    const { filter } = eagleQuery.buildFilter({}, 'Project', anonAcl('id'), anonymous());

    assert.strictEqual(filter, ANON_FILTER);
  });
});
