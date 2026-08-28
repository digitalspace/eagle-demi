'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const searchController = require('../../src/controllers/search');
const aiSearch = require('../../src/search/ai-search');
const documentsRepo = require('../../src/repositories/documents');
const projectsRepo = require('../../src/repositories/projects');
const chunksRepo = require('../../src/repositories/chunks');
const summarizer = require('../../src/ai/summarize');
const { logger } = require('../../src/utils/logger');
const config = require('../../src/config');

// publicView allowlists by ENRICHMENT_SOURCES; test deploys name wildfire.
config.enrichmentSources = ['wildfire'];

test('Search Controller Tests', async (t) => {

  t.afterEach(() => {
    t.mock.restoreAll();
  });

  await t.test('search projects returns projects from Cosmos DB when no keywords are provided', async () => {
    const mockProjects = [
      {
        id: '12345',
        name: 'Ajax Mine',
        region: 'Thompson-Okanagan',
        sector: 'Mining',
        // `projectState`, because that is what a Cosmos project row holds. This fixture said
        // `status` — the INDEX name — which is how a branch reading index names off a Cosmos row
        // went unnoticed: the fixture agreed with the bug instead of with the database.
        projectState: 'Completed',
        centroid: { type: 'Point', coordinates: [-120.37, 50.62] },
        read: ['public'],
        isPublished: true,
        // The stored shape. Only the ENRICHMENT_SOURCES keys reach a caller; the raw upstream
        // payloads are traceability.
        sources: {
          track: { proponent_name: 'KGHM' },
          eagle: { projectLeadEmail: 'lead@gov.bc.ca' },
          wildfire: {
            activeCountWithin50km: 2,
            nearestDistanceKm: 12.4,
            firesOfNoteNearby: 1,
            lastCalculatedAt: '2026-08-23T00:00:00.000Z'
          }
        }
      }
    ];

    t.mock.method(projectsRepo, 'listVisible', async (access, opts) => {
      // The repository owns the SQL; what this path must not lose is the caller's access context.
      assert.ok(access, 'expected an access context');
      assert.ok(!('trackOnly' in opts), 'provenance must not scope a public project read');
      assert.strictEqual(opts.pageSize, 10);
      return { items: mockProjects };
    });

    const req = {
      query: { dataset: 'Project', keywords: '', pageSize: '10' },
      header: () => null
    };

    let jsonResponse;
    const res = {
      json: (data) => {
        jsonResponse = data;
        return res;
      },
      status: () => res
    };

    await searchController.search(req, res);

    assert.ok(Array.isArray(jsonResponse));
    assert.strictEqual(jsonResponse[0].searchResults.length, 1);
    assert.strictEqual(jsonResponse[0].searchResults[0].name, 'Ajax Mine');
    assert.strictEqual(jsonResponse[0].searchResults[0].sector, 'Mining');
    assert.strictEqual(jsonResponse[0].searchResults[0].isPublished, true);

    const { sources } = jsonResponse[0].searchResults[0];
    assert.strictEqual(sources.track, undefined, 'raw Track payload withheld');
    assert.strictEqual(sources.eagle, undefined, 'raw Eagle payload withheld');
    assert.strictEqual(sources.wildfire.activeCountWithin50km, 2,
      'wildfire aggregate survives for the map');
  });

  // Type, Phase and Decision are three of the six columns `project-list-table-rows.component.html`
  // renders, and every one of them printed '-' on every row of the DEFAULT view — the page a
  // visitor lands on before typing anything. Cosmos held the values all along; this branch was
  // reading index names off a Cosmos row, the same defect the `projectState` fixture note above
  // describes, one field group over.
  await t.test('the Cosmos project branch emits the type, phase and decision columns', async () => {
    t.mock.method(projectsRepo, 'listVisible', async () => ({
      items: [{
        id: '46',
        name: 'Caribou Gas Processing Plant',
        projectState: 'Care and Maintenance',
        // COSMOS NAMES. `projectType`, and the two List refs stored whole — not the flat
        // label/id pair the indexer projects.
        projectType: 'Energy - Electricity',
        currentPhaseName: { _id: '5d3f6c7eda7a384218296037', name: 'Post Decision - Care & Maintenance' },
        eacDecision: { _id: '5e27937a749c83437054f214', name: 'Certificate Issued' },
        decisionDate: '1996-11-13T08:00:00.000Z',
        read: ['public']
      }]
    }));

    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: '', pageSize: '10' }, header: () => null }, res);

    const row = jsonResponse[0].searchResults[0];
    assert.strictEqual(row.type, 'Energy - Electricity');
    assert.deepStrictEqual(row.currentPhaseName,
      { _id: '5d3f6c7eda7a384218296037', name: 'Post Decision - Care & Maintenance' });
    assert.deepStrictEqual(row.eacDecision,
      { _id: '5e27937a749c83437054f214', name: 'Certificate Issued' });
    assert.strictEqual(row.decisionDate, '1996-11-13T08:00:00.000Z');
  });

  // 34 of the 382 projects in test carry no phase and the same 34 carry no decision. The template
  // guards with `?.name || '-'`, so `{}` would print an empty cell where a dash is the answer.
  // `eagleQuery.ref` answers `undefined` for that case, which is the same dash and one helper
  // instead of two.
  await t.test('a project with no phase or decision yields no ref, not an empty object', async () => {
    t.mock.method(projectsRepo, 'listVisible', async () => ({
      items: [{ id: '1', name: 'Marshall Road', read: ['public'] }]
    }));

    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: '', pageSize: '10' }, header: () => null }, res);

    const row = jsonResponse[0].searchResults[0];
    assert.strictEqual(row.currentPhaseName, undefined);
    assert.strictEqual(row.eacDecision, undefined);
    assert.strictEqual(row.type, '');
  });

  // The index stores the label and the id in two flat columns; the response has to put them back
  // together, or the keyword-search view loses the same three columns the list view just gained.
  await t.test('the AI Search project branch rebuilds the List refs from the flat pair', async () => {
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 1,
      items: [{
        id: '46',
        name: 'Caribou Gas Processing Plant',
        type: 'Energy - Electricity',
        currentPhaseName: 'Post Decision - Care & Maintenance',
        currentPhaseNameId: '5d3f6c7eda7a384218296037',
        eacDecision: 'Certificate Issued',
        eacDecisionId: '5e27937a749c83437054f214',
        decisionDate: '1996-11-13T08:00:00Z',
        read: ['public']
      }]
    }));

    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'caribou' }, header: () => null }, res);

    const row = jsonResponse[0].searchResults[0];
    assert.strictEqual(row.type, 'Energy - Electricity');
    assert.deepStrictEqual(row.currentPhaseName,
      { _id: '5d3f6c7eda7a384218296037', name: 'Post Decision - Care & Maintenance' });
    assert.deepStrictEqual(row.eacDecision,
      { _id: '5e27937a749c83437054f214', name: 'Certificate Issued' });
  });

  // eagle-public hard-codes `fuzzy=false` and eagle-search has always fuzzed anyway. Honouring the
  // parameter made demi answer a strictly smaller set than the service it replaces: measured live,
  // `keywords=caribou` returned 1 project from demi and 3 from prod eagle-search, and `caribuu`
  // returned 0 against 1.
  await t.test('fuzzy stays on even when the caller explicitly asks for it off', async () => {
    let sent = null;
    t.mock.method(aiSearch, 'searchProjects', async (opts) => {
      sent = opts;
      return { count: 0, items: [] };
    });

    const res = { json: () => res, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'caribou', fuzzy: 'false' }, header: () => null },
      res);

    assert.strictEqual(sent.fuzzy, true);
  });

  await t.test('the Cosmos branch nulls a missing trackProjectId too', async () => {
    // Same rule, other branch. Cosmos STORES the field, so this side reads it rather than
    // sniffing the id prefix — and the two must agree, or the answer depends on which corpus
    // served it, which is the whole defect this change exists to close.
    t.mock.method(projectsRepo, 'listVisible', async () => ({
      items: [
        { id: 'eagle-6a59234357be6fca20a489dc', name: 'testtesttest', trackProjectId: null,
          eagleId: '6a59234357be6fca20a489dc', read: ['public'] },
        { id: '207', name: 'Nicomen Wind Energy', trackProjectId: 207,
          eagleId: '58851172aaecd9001b820335', read: ['public'] }
      ]
    }));
    t.mock.method(projectsRepo, 'countVisible', async () => 2);

    let body = null;
    const res = { json: (b) => { body = b; return res; }, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project' }, header: () => null }, res);

    const rows = body[0].searchResults;
    assert.strictEqual(rows[0].trackProjectId, null, 'no Track counterpart, no Track id');
    assert.strictEqual(rows[1].trackProjectId, '207', 'and a real one still crosses as a String');
  });

  // PROVENANCE. An Eagle project with no Track counterpart is retained and flagged, never hidden —
  // what a caller may see is the `read[]` ACL's decision, not the row's source system.
  await t.test('the AI Search branch carries the ACL clause and NO provenance clause', async () => {
    let sent = null;
    t.mock.method(aiSearch, 'searchProjects', async (opts) => {
      sent = opts;
      return { count: 0, items: [] };
    });

    const res = { json: () => res, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'mine' }, header: () => null }, res);

    assert.match(sent.filter, /read\/any/, 'the ACL clause is what scopes this read');
    assert.ok(!/sourceSystem/.test(sent.filter),
      'provenance must not decide which projects a caller can see');
  });

  await t.test('an unscoped PRIVILEGED caller sends no filter at all', async () => {
    // `filterFor` returns `{filter: null, empty: false}` for such a caller — an unfiltered read,
    // not an empty one. Interpolating that into a filter string emits `(undefined) and …`, which
    // Azure answers 400 and this route turns into 502.
    let sent = null;
    t.mock.method(aiSearch, 'searchProjects', async (opts) => {
      sent = opts;
      return { count: 0, items: [] };
    });

    const res = { json: () => res, status: () => res };
    await searchController.search({
      query: { dataset: 'Project', keywords: 'mine' },
      user: { realm_access: { roles: ['sysadmin'] } },
      header: () => null
    }, res);

    // `=== undefined`, not a regex on the coerced string, which passes on garbage as readily.
    assert.strictEqual(sent.filter, undefined, 'nothing to scope means no filter, not "(undefined)"');
  });

  await t.test('a keywordless SORT is not provenance-scoped either', async () => {
    // The shape eagle-public sends for the project list: `?dataset=Project&sortBy=-name`, no
    // keywords, which still goes to the index rather than Cosmos.
    let sent = null;
    t.mock.method(aiSearch, 'searchProjects', async (opts) => {
      sent = opts;
      return { count: 0, items: [] };
    });

    const res = { json: () => res, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', sortBy: '-name' }, header: () => null }, res);

    assert.ok(!/sourceSystem/.test(sent.filter));
    assert.strictEqual(sent.matchAll, true, 'and it is the keywordless index read, not Cosmos');
  });

  await t.test('a caller may still filter on sourceSystem themselves', async () => {
    // `sourceSystem` is filterable in the committed index schema, so `and[sourceSystem]=eagle`
    // composes with the ACL like any other caller term — the route adds nothing of its own.
    let sent = null;
    t.mock.method(aiSearch, 'searchProjects', async (opts) => {
      sent = opts;
      return { count: 0, items: [] };
    });

    const res = { json: () => res, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'test', 'and[sourceSystem]': 'eagle' },
        header: () => null },
      res);

    assert.match(sent.filter, /sourceSystem eq 'eagle'/, "the caller's own term is still built");
    assert.match(sent.filter, /read\/any/, 'and the ACL clause survives beside it');
  });

  await t.test('an Eagle-only row reports trackProjectId null, not its own id', async () => {
    // `id` on such a row is the literal `eagle-<ObjectId>`; returning it AS a trackProjectId
    // reported a value that is not a Track id and never will be.
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 1,
      items: [{
        id: 'eagle-6a59234357be6fca20a489dc',
        name: 'testtesttest',
        legacyEagleId: '6a59234357be6fca20a489dc',
        read: ['public']
      }]
    }));

    let body = null;
    const res = { json: (b) => { body = b; return res; }, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'test' }, header: () => null },
      res);

    assert.strictEqual(body[0].searchResults[0].trackProjectId, null);
    assert.strictEqual(body[0].searchResults[0].id, 'eagle-6a59234357be6fca20a489dc',
      'the DEMI id itself is unchanged — only the claim that it is a Track id is withdrawn');
  });

  await t.test('a Track row still reports its trackProjectId', async () => {
    // The other half: a fix that nulls everything would pass the test above and break the field.
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 1,
      items: [{ id: '207', name: 'Nicomen Wind Energy', legacyEagleId: '588511', read: ['public'] }]
    }));

    let body = null;
    const res = { json: (b) => { body = b; return res; }, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'nicomen' }, header: () => null }, res);

    assert.strictEqual(body[0].searchResults[0].trackProjectId, '207');
  });

  // The index hit is redacted BEFORE the mapper runs (docs/rbac-architecture.md §2 item 9), so a
  // mapper that started spreading the raw row would publish the ACL. `isPublished` is the derived
  // mirror, and an unpublished row proves it is derived rather than defaulted to true.
  await t.test('anonymous Project hit carries no read[]', async () => {
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 1,
      items: [{
        id: '207',
        name: 'Nicomen Wind Energy',
        read: ['sysadmin', 'staff'],
        isPublished: true,
        // Not an index field, so the redactor removes it: the catalog is an allowlist.
        complianceLead: 'A Person'
      }]
    }));

    let body = null;
    const res = { json: (b) => { body = b; return res; }, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'nicomen' }, header: () => null }, res);

    const [row] = body[0].searchResults;
    assert.strictEqual(row.read, undefined, 'the row ACL must not be published to callers');
    assert.strictEqual(row.complianceLead, undefined, 'an uncatalogued index field is dropped');
    assert.strictEqual(row.isPublished, false, 'derived from read[], not copied from the index');
  });

  // The catalog gates QUERY keys as well as response fields (P2-3). `read` is the only field the
  // index catalogs put below level 4, and it is filterable, so it is the one key that proves the
  // gate: without it `read/any(x: x eq 'sysadmin')` composes into the caller's own filter.
  await t.test('a filter on a hidden field is dropped, not applied', async () => {
    let sent = null;
    t.mock.method(aiSearch, 'searchProjects', async (opts) => {
      sent = opts;
      return { count: 0, items: [] };
    });

    let body = null;
    const res = { json: (b) => { body = b; return res; }, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'mine', 'and[read]': 'sysadmin' }, header: () => null },
      res);

    assert.deepStrictEqual(body[0].meta[0].dropped.filter, ['read']);
    assert.ok(!/sysadmin/.test(sent.filter),
      'a filter the caller cannot see must never reach the service');
    assert.strictEqual(sent.filter, "read/any(r: search.in(r, 'public', ','))",
      'and the ACL clause is still the only thing scoping the read');
  });

  await t.test('anonymous Document hit carries no read[]', async () => {
    t.mock.method(aiSearch, 'searchDocuments', async () => ({
      count: 1,
      items: [{
        id: 'doc1',
        displayName: 'Application',
        documentFileName: 'app.pdf',
        projectId: '207',
        read: ['sysadmin', 'staff'],
        isPublished: true,
        orcsClassification: '85100-20'
      }]
    }));
    t.mock.method(projectsRepo, 'listByIds', async () => [{ id: '207', name: 'Site C' }]);

    let body = null;
    const res = { json: (b) => { body = b; return res; }, status: () => res };
    await searchController.search(
      { query: { dataset: 'Document', keywords: 'application' }, header: () => null }, res);

    const [row] = body[0].searchResults;
    assert.strictEqual(row.read, undefined, 'the row ACL must not be published to callers');
    assert.strictEqual(row.orcsClassification, undefined, 'an uncatalogued index field is dropped');
    assert.strictEqual(row.isPublished, false, 'derived from read[], not copied from the index');
  });

  await t.test('search projects queries AI Search when keywords are provided', async () => {
    let sent = null;
    t.mock.method(aiSearch, 'searchProjects', async (opts) => {
      sent = opts;
      return {
        count: 1,
        items: [{
          id: '12345',
          name: 'Ajax Mine',
          displayName: 'AJAX',
          description: 'Proposed open-pit copper mine.',
          proponent: 'KGHM Ajax',
          sector: 'Mining',
          status: 'Completed',
          region: 'Thompson-Okanagan',
          legacyEagleId: '588511',
          // Stored and returned as GeoJSON [lng, lat] — the frontend's order, unchanged.
          centroid: { type: 'Point', coordinates: [-120.37, 50.62] },
          read: ['public']
        }]
      };
    });

    const req = {
      query: { dataset: 'Project', keywords: 'Ajax', pageSize: '5' },
      header: () => null
    };
    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };

    await searchController.search(req, res);

    // Projects scope on their own id — scoping them on projectId would match nothing while
    // looking exactly like an empty corpus.
    assert.ok(sent.filter, 'an anonymous caller must be filtered');
    assert.ok(!/projectId/.test(sent.filter), 'projects are scoped on id, never projectId');

    const [hit] = jsonResponse[0].searchResults;
    assert.strictEqual(hit.name, 'Ajax Mine');
    assert.strictEqual(hit.sector, 'Mining');
    assert.strictEqual(hit.isPublished, true);
    assert.strictEqual(hit.legacyEagleId, '588511');
    // The lat/lng swap Typesense needed is gone: Cosmos stores [lng, lat] and so does the index.
    assert.deepStrictEqual(hit.centroid, [-120.37, 50.62]);
  });

  // The fallback used to answer a keyword query with the keywordless Cosmos list. Measured on
  // dev: an anonymous search for a nonsense term returned 50 unrelated projects, and that same
  // fallback masked a 400 which had broken project search completely — a broken search and a
  // working one were indistinguishable from outside.
  await t.test('a keyword search that matches nothing says so, and does not list the corpus',
    async () => {
      let listed = false;
      t.mock.method(aiSearch, 'searchProjects', async () => ({ count: 0, items: [] }));
      t.mock.method(projectsRepo, 'listVisible', async () => {
        listed = true;
        return { items: [] };
      });

      const req = { query: { dataset: 'Project', keywords: 'zarquonflux' }, header: () => null };
      let jsonResponse;
      const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };

      await searchController.search(req, res);

      assert.deepStrictEqual(jsonResponse[0].searchResults, []);
      assert.strictEqual(listed, false, 'the unfiltered list must not answer a keyword query');
    });

  // A project with no centroid still has to render on a map rather than crash it.
  await t.test('a project without a centroid falls back to the middle of BC', async () => {
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 1,
      items: [{ id: '1', name: 'No Geo', read: ['public'] }]
    }));

    const req = { query: { dataset: 'Project', keywords: 'geo' }, header: () => null };
    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };

    await searchController.search(req, res);
    const [hit] = jsonResponse[0].searchResults;
    assert.deepStrictEqual(hit.centroid, [-125.0, 54.0]);
    assert.ok(hit.centroid[0] < 0, 'longitude must stay negative — BC is west of Greenwich');
  });

  // The second leg is not an optimisation. Measured against the live Typesense index, dropping
  // projectName from document search lost 77% of hits for "Ajax" and 66% for "pipeline".
  await t.test('document search passes a project filter so the name leg can run', async () => {
    let sent = null;
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => {
      sent = opts;
      return {
        count: 1,
        items: [{
          id: 'doc1',
          displayName: 'Application',
          documentFileName: 'app.pdf',
          type: 'Application',
          projectId: '207',
          read: ['public']
        }]
      };
    });
    t.mock.method(projectsRepo, 'listByIds', async (access) => {
      assert.strictEqual(access.tier, 'public', 'labels resolve under the CALLER, not systemAccess');
      return [{ id: '207', name: 'Site C' }];
    });

    const req = {
      query: { dataset: 'Document', keywords: 'Ajax', pageSize: '5' },
      header: () => null
    };
    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };

    await searchController.search(req, res);

    assert.ok(sent.filter, 'documents are filtered on their own ACL');
    assert.notStrictEqual(sent.projectFilter, undefined,
      'undefined would silently disable the project-name leg');

    const [hit] = jsonResponse[0].searchResults;
    // The index carries no projectName; the label is hydrated from the repository.
    assert.strictEqual(hit.projectName, 'Site C');
    assert.strictEqual(hit.documentType, 'Application');
  });

  // eagle-public's document table renders Date, Type and Milestone by resolving List ObjectIds
  // through `idToList()`. DEMI seeded only the resolved LABELS, so those columns rendered '-' on
  // every row; the index and the seed carry the ids now, and BOTH mappers must send them or the
  // same dataset renders different columns depending on whether the caller typed a keyword.
  await t.test('a document row carries the ids and the date the table renders', async () => {
    t.mock.method(aiSearch, 'searchDocuments', async () => ({
      count: 1,
      items: [{
        id: 'doc1',
        displayName: 'Application',
        documentFileName: 'app.pdf',
        type: 'Application',
        typeId: '5cf00c03a266b7e1877504da',
        milestoneId: '5cf00c03a266b7e1877504e9',
        projectPhaseId: '5d3f6c7eda7a38421829602f',
        documentAuthorTypeId: '5cf00c03a266b7e1877504dc',
        datePosted: '2020-03-11T00:00:00Z',
        projectId: '207',
        read: ['public']
      }]
    }));
    t.mock.method(projectsRepo, 'listByIds', async () => [{ id: '207', name: 'Site C' }]);

    const req = { query: { dataset: 'Document', keywords: 'Ajax' }, header: () => null };
    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };
    await searchController.search(req, res);

    const [hit] = jsonResponse[0].searchResults;
    assert.strictEqual(hit.type, '5cf00c03a266b7e1877504da', 'the ID, not the label beside it');
    assert.strictEqual(hit.milestone, '5cf00c03a266b7e1877504e9');
    assert.strictEqual(hit.projectPhase, '5d3f6c7eda7a38421829602f');
    assert.strictEqual(hit.documentAuthorType, '5cf00c03a266b7e1877504dc');
    assert.strictEqual(hit.datePosted, '2020-03-11T00:00:00Z');
    assert.strictEqual(hit.documentType, 'Application', 'the label stays, for DEMI\'s own frontend');
  });

  // search-diff compares DEMI's document rows against eagle-search's and no longer tolerates
  // `isFeatured` / `documentSource` as eagle-only columns, so dropping either mapping turns every
  // document row into a diff — silently, because the search itself still answers 200.
  await t.test('a document row carries isFeatured and documentSource', async () => {
    t.mock.method(aiSearch, 'searchDocuments', async () => ({
      count: 2,
      items: [
        {
          id: 'doc1', displayName: 'Featured', documentFileName: 'a.pdf',
          isFeatured: true, documentSource: 'PROJECT', projectId: '207', read: ['public']
        },
        // The row that pins the DEFAULTS: neither field is stored on every document, and both
        // have to be present in the response regardless, with the type eagle-search sends.
        { id: 'doc2', displayName: 'Plain', documentFileName: 'b.pdf', projectId: '207', read: ['public'] }
      ]
    }));
    t.mock.method(projectsRepo, 'listByIds', async () => [{ id: '207', name: 'Site C' }]);

    const req = { query: { dataset: 'Document', keywords: 'Ajax' }, header: () => null };
    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };
    await searchController.search(req, res);

    const [featured, plain] = jsonResponse[0].searchResults;
    assert.strictEqual(featured.isFeatured, true);
    assert.strictEqual(featured.documentSource, 'PROJECT');
    assert.strictEqual(plain.isFeatured, false, 'absent means false, not undefined');
    assert.strictEqual(plain.documentSource, '', 'absent means an empty string, not undefined');
  });

  await t.test('a bare document list is served by the index, not by Cosmos', async () => {
    // The request shape that used to take the deleted Cosmos read: no keywords, no sort, and a
    // `project` — which `hasCriteria` excludes on purpose. It paged by overfetch-and-slice against
    // a 1000-row clamp, so `pageNum=2` at `pageSize=500` returned zero rows beside a count of
    // 2,488. The index serves it, so the assertions here are the offset and the row shape.
    let sent = null;
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => {
      sent = opts;
      return {
        count: 2488,
        items: [{
          id: 'doc1',
          displayName: 'Test Doc',
          documentFileName: 'test_doc.pdf',
          type: 'Application',
          typeId: '5cf00c03a266b7e1877504da',
          milestoneId: '5cf00c03a266b7e1877504e9',
          projectPhaseId: '5d3f6c7eda7a38421829602f',
          documentAuthorTypeId: '5cf00c03a266b7e1877504dc',
          datePosted: '2020-03-11T00:00:00Z',
          projectId: '12345',
          read: ['public']
        }]
      };
    });

    // The regression guard. Re-adding the `keywords || criteria` gate would restore the truncation
    // silently — every assertion below still passes on Cosmos rows, because the two mappers agreed
    // about the fields. Only "which backend ran" tells them apart.
    t.mock.method(documentsRepo, 'listVisible', async () => {
      assert.fail('no document read may go to Cosmos — it cannot page past 1000 rows');
    });

    // The bare list labels its results too, exactly as a keyword search does.
    t.mock.method(projectsRepo, 'listByIds', async (access, ids) => {
      assert.deepStrictEqual(ids, ['12345']);
      return [{ id: '12345', name: 'Ajax Mine' }];
    });

    const req = {
      query: {
        dataset: 'Document', keywords: '', project: '12345',
        pageSize: '500', pageNum: '2'
      },
      header: () => null
    };

    let jsonResponse;
    const res = {
      json: (data) => {
        jsonResponse = data;
        return res;
      },
      status: () => res
    };

    await searchController.search(req, res);

    // The page that answered zero rows before. `skip` is in the caller's own `pageSize`.
    assert.strictEqual(sent.skip, 1000, 'the third page of 500 starts at row 1000');
    assert.strictEqual(sent.top, 500);
    assert.strictEqual(sent.matchAll, true, 'no keywords means every row the filter admits');

    assert.ok(Array.isArray(jsonResponse));
    assert.strictEqual(jsonResponse[0].count, 2488, 'the real total, not the page length');
    assert.strictEqual(jsonResponse[0].searchResults.length, 1);
    const row = jsonResponse[0].searchResults[0];
    assert.strictEqual(row.displayName, 'Test Doc');
    assert.strictEqual(row.documentFileName, 'test_doc.pdf');
    assert.strictEqual(row.isPublished, true);
    assert.strictEqual(row.projectName, 'Ajax Mine');
    // The same five the keyword branch sends. One mapper answers this dataset now, and these are
    // what eagle-public's Type / Milestone / Date columns resolve.
    assert.strictEqual(row.type, '5cf00c03a266b7e1877504da');
    assert.strictEqual(row.milestone, '5cf00c03a266b7e1877504e9');
    assert.strictEqual(row.projectPhase, '5d3f6c7eda7a38421829602f');
    assert.strictEqual(row.documentAuthorType, '5cf00c03a266b7e1877504dc');
    assert.strictEqual(row.datePosted, '2020-03-11T00:00:00Z');
  });

  await t.test('a bare document list above the page cap is refused, not truncated', async () => {
    // The ceiling used to be Cosmos's 1000, applied silently. It is the index's now, so the
    // refusal has to reach the bare list too: `runSearch` clamps `top` to MAX_PAGE_ROWS, and a
    // 500-row answer under a 60,560 count is the same lie in a smaller size.
    t.mock.method(aiSearch, 'searchDocuments', async () => {
      assert.fail('a page above the cap must be refused before any search runs');
    });

    let status = null;
    let body = null;
    const res = {
      status: (code) => { status = code; return res; },
      json: (data) => { body = data; return res; }
    };

    await searchController.search(
      { query: { dataset: 'Document', keywords: '', pageSize: '501' }, header: () => null }, res);

    assert.strictEqual(status, 400);
    assert.match(body.error, /pageSize above 500/);
  });

  await t.test('DocumentChunk search hydrates names and passes the ACL filter to the service',
    async () => {
      let sent = null;
      t.mock.method(aiSearch, 'searchChunks', async (opts) => {
        sent = opts;
        return {
          count: 1,
          items: [{
            chunkId: 'd1::p2::c0',
            documentId: 'd1',
            projectId: '207',
            pageNumber: 2,
            read: ['public'],
            snippet: 'the &lt;script&gt; <mark>river</mark> flows north'
          }]
        };
      });
      // The caller's own access, not a system one — a name must not out-rank the row it labels.
      t.mock.method(documentsRepo, 'listByIds', async (access) => {
        assert.strictEqual(access.tier, 'public');
        return [{
          id: 'd1', displayName: 'Application', documentFileName: 'app.pdf', type: 'Application',
          // The two chip columns. Present here because the mapper below must be shown to READ
          // them: it builds its row field by field and does not spread the parent, so widening
          // the repository projection alone is a change nothing on the wire can see.
          milestone: 'Other', milestoneId: '5d0d212c7d50161b92a80eed',
          datePosted: '2018-07-31T06:40:37.626Z'
        }];
      });
      t.mock.method(projectsRepo, 'listByIds', async () => ([{ id: '207', name: 'Site C' }]));

      const req = {
        query: { dataset: 'DocumentChunk', keywords: 'river', pageSize: '50', fuzzy: 'true' },
        header: () => null
      };
      let jsonResponse;
      const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };

      await searchController.search(req, res);

      // THE thing that must never regress: an anonymous caller's request carries a filter. A
      // request without one is unrestricted, and the whole corpus comes back.
      assert.ok(sent.filter, 'an anonymous caller must be filtered');
      assert.ok(sent.filter.includes("'public'"));
      assert.strictEqual(sent.fuzzy, true);

      const [hit] = jsonResponse[0].searchResults;
      // THE CHIPS, and specifically that `milestone` is the LABEL. The chunk card renders it raw
      // (`content-result.component.html:13`) and has no `idToList`, so shipping the ObjectId here
      // puts `5d0d212c7d50161b92a80eed` on screen. Prod emits both, and so do we.
      assert.strictEqual(hit.milestone, 'Other', 'the chip renders this string directly');
      assert.strictEqual(hit.milestoneId, '5d0d212c7d50161b92a80eed');
      assert.strictEqual(hit.datePosted, '2018-07-31T06:40:37.626Z');
      // GROUPED BY DOCUMENT since 2026-08-23, so `_id` is the DOCUMENT id — eagle-public's content
      // card builds its download URL from it (`content-result.component.ts:36-39`) and a chunk id
      // there is a link that 404s. The chunk's own id is kept beside it rather than dropped.
      assert.strictEqual(hit._id, 'd1');
      assert.strictEqual(hit.chunkId, 'd1::p2::c0');
      assert.strictEqual(hit.matchCount, 1);
      assert.deepStrictEqual(hit.snippets, [hit.snippet], 'the card reads snippets[], DEMI reads snippet');
      assert.strictEqual(hit.projectName, 'Site C');
      assert.strictEqual(hit.documentName, 'Application');
      assert.strictEqual(hit.pageNumber, 2);
      // read[] is the caller's own ACL restated and is deliberately NOT emitted.
      assert.strictEqual(hit.read, undefined, 'the row ACL must not be published to callers');
      // content is not retrievable from the index, so the API never ships chunk text.
      assert.strictEqual(hit.content, '');
      assert.ok(hit.snippet.includes('<mark>river</mark>'));
      assert.ok(!hit.snippet.includes('<script>'), 'document text must not reach the DOM as markup');
    });

  // The defect this fixes, stated as a test: eagle-public's content card iterates `snippets` and
  // reads `matchCount`, and against per-passage rows every card rendered "0 matches" with no
  // snippet body. Three passages of one document are ONE row with a count of 3.
  await t.test('chunk hits collapse to one row per document, with the match count', async () => {
    let sent = null;
    t.mock.method(aiSearch, 'searchChunks', async (opts) => {
      sent = opts;
      return {
        count: 42,
        items: [
          { chunkId: 'd1::p1', documentId: 'd1', projectId: '207', pageNumber: 1, read: ['public'], snippet: 'one' },
          { chunkId: 'd1::p2', documentId: 'd1', projectId: '207', pageNumber: 2, read: ['public'], snippet: 'two' },
          { chunkId: 'd1::p3', documentId: 'd1', projectId: '207', pageNumber: 3, read: ['public'], snippet: 'three' },
          { chunkId: 'd2::p1', documentId: 'd2', projectId: '207', pageNumber: 1, read: ['public'], snippet: 'four' }
        ]
      };
    });
    t.mock.method(documentsRepo, 'listByIds', async () => ([
      { id: 'd1', displayName: 'First' }, { id: 'd2', displayName: 'Second' }
    ]));
    t.mock.method(projectsRepo, 'listByIds', async () => ([{ id: '207', name: 'Site C' }]));

    const req = { query: { dataset: 'DocumentChunk', keywords: 'river', pageSize: '10' }, header: () => null };
    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };
    await searchController.search(req, res);

    const rows = jsonResponse[0].searchResults;
    assert.strictEqual(rows.length, 2, 'four passages, two documents');
    assert.deepStrictEqual(rows.map(r => r._id), ['d1', 'd2']);
    assert.strictEqual(rows[0].matchCount, 3);
    assert.deepStrictEqual(rows[0].snippets, ['one', 'two'], 'capped at MAX_SNIPPETS');
    // A page of documents costs a WINDOW of chunks, and the window is the paging unit.
    assert.strictEqual(sent.top, 100, 'pageSize 10 x FANOUT 10');
    assert.strictEqual(sent.skip, 0);
    // The total still counts passages; meta.countsPassages is what says so.
    assert.strictEqual(jsonResponse[0].count, 42);
    assert.strictEqual(jsonResponse[0].meta[0].countsPassages, true);
    assert.strictEqual(jsonResponse[0].meta[0].documentsOnPage, 2, 'documents, not passages');
  });

  // The gate withholds chunks whose parent document the caller may not read, and the total is
  // reported net of them. The floor is the surviving CHUNK count, not the row count: one row can
  // carry a dozen matches, so flooring at rows would report fewer matches than the page shows.
  await t.test('a withheld chunk is subtracted from the total, floored at surviving chunks', async () => {
    t.mock.method(aiSearch, 'searchChunks', async () => ({
      count: 4,
      items: [
        { chunkId: 'd1::p1', documentId: 'd1', projectId: '207', pageNumber: 1, snippet: 'a' },
        { chunkId: 'd1::p2', documentId: 'd1', projectId: '207', pageNumber: 2, snippet: 'b' },
        { chunkId: 'd1::p3', documentId: 'd1', projectId: '207', pageNumber: 3, snippet: 'c' },
        { chunkId: 'hidden::p1', documentId: 'hidden', projectId: '999', pageNumber: 1, snippet: 'd' }
      ]
    }));
    // The parent of the fourth chunk is not readable, so listByIds does not return it.
    t.mock.method(documentsRepo, 'listByIds', async () => ([{ id: 'd1', displayName: 'First' }]));
    t.mock.method(projectsRepo, 'listByIds', async () => ([{ id: '207', name: 'Site C' }]));

    const req = { query: { dataset: 'DocumentChunk', keywords: 'river', pageSize: '10' }, header: () => null };
    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };
    await searchController.search(req, res);

    assert.strictEqual(jsonResponse[0].searchResults.length, 1, 'the withheld chunk is gone');
    assert.strictEqual(jsonResponse[0].count, 3,
      '4 matches minus 1 withheld — and floored at 3 surviving chunks, not at the 1 row');
  });

  // The floor only shows itself when the subtraction would take the total BELOW what this page
  // holds. Flooring at the row count instead of the surviving chunk count is invisible in the case
  // above — both give 3 — so this is the shape that separates them.
  await t.test('the floor is surviving chunks, not rows, when the subtraction goes low', async () => {
    t.mock.method(aiSearch, 'searchChunks', async () => ({
      count: 1,
      items: [
        { chunkId: 'd1::p1', documentId: 'd1', projectId: '207', pageNumber: 1, snippet: 'a' },
        { chunkId: 'd1::p2', documentId: 'd1', projectId: '207', pageNumber: 2, snippet: 'b' },
        { chunkId: 'd1::p3', documentId: 'd1', projectId: '207', pageNumber: 3, snippet: 'c' },
        { chunkId: 'hidden::p1', documentId: 'hidden', projectId: '999', pageNumber: 1, snippet: 'd' }
      ]
    }));
    t.mock.method(documentsRepo, 'listByIds', async () => ([{ id: 'd1', displayName: 'First' }]));
    t.mock.method(projectsRepo, 'listByIds', async () => ([{ id: '207', name: 'Site C' }]));

    const req = { query: { dataset: 'DocumentChunk', keywords: 'river', pageSize: '10' }, header: () => null };
    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };
    await searchController.search(req, res);

    assert.strictEqual(jsonResponse[0].count, 3,
      'three surviving chunks, not the one row that carries them');
  });

  // `skip` AND `top` MUST BE THE SAME UNIT. Reverting `skip` to `pageNum * pageSize` while `top`
  // stays a window left the whole suite green, and the consequence is silent: consecutive pages
  // then re-read chunks they already served, or skip past chunks nobody ever sees. Nothing in a
  // response makes that visible — the rows look plausible on every page.
  await t.test('chunk pages advance by a whole window, so ranges neither gap nor overlap', async () => {
    const seen = [];
    t.mock.method(aiSearch, 'searchChunks', async (opts) => {
      seen.push({ skip: opts.skip, top: opts.top });
      return { count: 300, items: [] };
    });

    for (const pageNum of ['0', '1', '2']) {
      const req = {
        query: { dataset: 'DocumentChunk', keywords: 'river', pageSize: '10', pageNum },
        header: () => null
      };
      await searchController.search(req, { json: () => ({}), status: () => ({ json: () => ({}) }) });
    }

    assert.deepStrictEqual(seen, [
      { skip: 0, top: 100 }, { skip: 100, top: 100 }, { skip: 200, top: 100 }
    ], 'each page starts exactly where the previous one ended');
  });

  // The window is capped at what ONE service request returns. A window past that leaves the tail of
  // every window unrequested while `skip` still advances by the full window — and it turns each
  // debounced keystroke into two requests against a Basic 1-SU service.
  await t.test('a large page never costs more than one service request', async () => {
    let sent = null;
    t.mock.method(aiSearch, 'searchChunks', async (opts) => { sent = opts; return { count: 0, items: [] }; });

    const req = {
      query: { dataset: 'DocumentChunk', keywords: 'river', pageSize: '100', pageNum: '1' },
      header: () => null
    };
    await searchController.search(req, { json: () => ({}), status: () => ({ json: () => ({}) }) });

    assert.strictEqual(sent.top, aiSearch.SERVICE_MAX_TOP, 'one request, not two');
    assert.strictEqual(sent.skip, aiSearch.SERVICE_MAX_TOP, 'and skip advances by the same amount');
    assert.ok(sent.top <= aiSearch.SERVICE_MAX_TOP,
      'above this, runSearch fills the page with a second request per keystroke');
  });

  // The AI Search data plane is private-endpoint-only, so this is the ONLY way to observe how many
  // chunks the index holds. The count deliberately differs from items.length here: a passthrough
  // that returned the page size would satisfy a same-number assertion and measure nothing.
  await t.test('DocumentChunk search returns the index-wide match count, not the page size',
    async () => {
      t.mock.method(aiSearch, 'searchChunks', async () => ({
        count: 995316,
        items: [{ chunkId: 'c1', documentId: 'd1', projectId: '207', pageNumber: 1, read: ['public'], snippet: 'x' }]
      }));
      t.mock.method(documentsRepo, 'listByIds', async () => ([{ id: 'd1', displayName: 'Doc' }]));
      t.mock.method(projectsRepo, 'listByIds', async () => ([{ id: '207', name: 'Site C' }]));

      const req = { query: { dataset: 'DocumentChunk', keywords: 'river' }, header: () => null };
      let jsonResponse;
      const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };

      await searchController.search(req, res);

      assert.strictEqual(jsonResponse[0].count, 995316);
      assert.strictEqual(jsonResponse[0].searchResults.length, 1);
    });

  // The fail-closed branch. OData has no `false` literal, so a caller scoped to nothing cannot be
  // expressed as a filter — the request must simply not be issued.
  await t.test('a caller scoped to nothing is answered empty without a request', async () => {
    let called = false;
    t.mock.method(aiSearch, 'searchChunks', async () => { called = true; return { items: [] }; });

    const req = {
      query: { dataset: 'DocumentChunk', keywords: 'river' },
      // A verified token scoped to zero projects.
      user: { realm_access: { roles: ['public'] }, projectScope: [] },
      header: () => null
    };
    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };

    await searchController.search(req, res);

    assert.deepStrictEqual(jsonResponse[0].searchResults, []);
    assert.strictEqual(called, false, 'no filter can express "nothing", so issue no request');
  });

  // A FAILED search is not an empty one. This used to answer 200 with `[]` to save the frontend's
  // two 5xx retries — but the response envelope then stamped `searchResultsTotal: 0` on it, which
  // is a claim about the index that nothing measured. The status code is the only place the
  // difference between "found nothing" and "could not look" can be stated, so it is stated there,
  // and no result set is published at all.
  await t.test('a search backend failure is reported, not answered as an empty result', async () => {
    t.mock.method(aiSearch, 'searchChunks', async () => { throw new Error('HTTP 403 forbidden'); });

    const req = { query: { dataset: 'DocumentChunk', keywords: 'river' }, header: () => null };
    let jsonResponse;
    let statusCode = 200;
    const res = {
      json: (data) => { jsonResponse = data; return res; },
      status: (code) => { statusCode = code; return res; }
    };

    await searchController.search(req, res);

    assert.strictEqual(statusCode, 502);
    assert.ok(!Array.isArray(jsonResponse), 'a failure carries no searchResults array');
    assert.ok(jsonResponse.error, 'and says what went wrong');
  });

  await t.test('DocumentChunk search with no keywords never queries', async () => {
    let called = false;
    t.mock.method(aiSearch, 'searchChunks', async () => { called = true; return { items: [] }; });

    const req = { query: { dataset: 'DocumentChunk', keywords: '' }, header: () => null };
    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };

    await searchController.search(req, res);

    assert.strictEqual(called, false);
    assert.deepStrictEqual(jsonResponse[0].searchResults, []);
  });

  await t.test('search returns 400 for unsupported dataset', async () => {
    const req = {
      query: { dataset: 'UnsupportedDataset' },
      header: () => null
    };

    let statusCode;
    let jsonResponse;
    const res = {
      status: (code) => {
        statusCode = code;
        return res;
      },
      json: (data) => {
        jsonResponse = data;
        return res;
      }
    };

    await searchController.search(req, res);

    assert.strictEqual(statusCode, 400);
    assert.ok(jsonResponse.error.includes('Invalid or unsupported dataset'));
  });
});

// The fail-open shape, dataset by dataset. `DocumentChunk` has been covered since the flag was
// added; Project and Document had not, and they are the two that fall through to Cosmos rather
// than short-circuiting — so "no AI Search request" is only half the assertion, the answer has to
// be empty too.
test('every dataset is fail-closed for a caller scoped to nothing', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const scopedToNothing = () => ({
    user: { realm_access: { roles: ['public'] }, projectScope: [] },
    header: () => null
  });

  await t.test('Project issues no AI Search request and lists nothing', async () => {
    let searched = false;
    t.mock.method(aiSearch, 'searchProjects', async () => { searched = true; return { items: [] }; });
    // The Cosmos fallback must be ACL-gated too — scoped-to-nothing is SQL `false` there.
    let seenAccess;
    t.mock.method(projectsRepo, 'listVisible', async (access) => {
      seenAccess = access;
      return { items: [], continuationToken: undefined };
    });

    let body;
    const res = { json: (d) => { body = d; return res; }, status: () => res };
    await searchController.search(
      { ...scopedToNothing(), query: { dataset: 'Project', keywords: 'river' } }, res);

    assert.strictEqual(searched, false, 'a null filter is UNRESTRICTED — issue no request');
    assert.deepStrictEqual(body[0].searchResults, []);
    if (seenAccess) assert.deepStrictEqual(seenAccess.projectScope, []);
  });

  await t.test('Document issues no AI Search request and lists nothing', async () => {
    let searched = false;
    t.mock.method(aiSearch, 'searchDocuments', async () => { searched = true; return { items: [] }; });
    t.mock.method(documentsRepo, 'listVisible', async () => ({ items: [], continuationToken: undefined }));

    let body;
    const res = { json: (d) => { body = d; return res; }, status: () => res };
    await searchController.search(
      { ...scopedToNothing(), query: { dataset: 'Document', keywords: 'river' } }, res);

    assert.strictEqual(searched, false, 'a null filter is UNRESTRICTED — issue no request');
    assert.deepStrictEqual(body[0].searchResults, []);
  });
});

// A privileged credential carrying a project scope used to search the WHOLE index: filterFor
// short-circuited on privilege before it read the scope. The filter it sends is the evidence.
test('a scoped privileged caller searches only its own projects', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('the chunk filter carries the scope and drops the role clause', async () => {
    let sent;
    t.mock.method(aiSearch, 'searchChunks', async (opts) => { sent = opts; return { items: [], count: 0 }; });

    const res = { json: () => res, status: () => res };
    await searchController.search({
      query: { dataset: 'DocumentChunk', keywords: 'river' },
      user: { realm_access: { roles: ['staff'] }, projectScope: ['207'] },
      header: () => null
    }, res);

    assert.ok(sent, 'the request must still be issued — this caller can see something');
    assert.match(sent.filter, /search\.in\(projectId, '207'/, 'the scope survives privilege');
    assert.ok(!/read\/any/.test(sent.filter), 'privilege lifts the ROLE clause, not the scope');
  });
});

// A chunk carries a SNAPSHOT of its document's ACL, taken at ingest. Two independent defects made
// that snapshot leak extracted text: nothing refreshed it when the document was restricted, and the
// search controller returned a chunk whose parent it had just been denied.
test('restricted document text does not leak through Deep Search', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a chunk whose parent is not visible is withheld, snippet and all', async () => {
    // Two hits. The caller may see one parent; the other document has been restricted, but its
    // chunks still carry the stale `read: ['public']` they were ingested with.
    t.mock.method(aiSearch, 'searchChunks', async () => ({
      items: [
        { chunkId: 'ok::p0::c0', documentId: 'visible-doc', projectId: 'p1', pageNumber: 0,
          snippet: 'public text', read: ['public'] },
        { chunkId: 'leak::p3::c1', documentId: 'restricted-doc', projectId: 'p1', pageNumber: 3,
          snippet: 'SECRET-CANARY from a restricted document', read: ['public'] }
      ],
      count: 2
    }));
    // Only the visible document comes back — listByIds applies the ACL.
    t.mock.method(documentsRepo, 'listByIds', async () => [
      { id: 'visible-doc', displayName: 'Public Doc', type: 'PDF' }
    ]);
    t.mock.method(projectsRepo, 'listByIds', async () => [{ id: 'p1', name: 'Project One' }]);

    let body;
    const res = { json: (d) => { body = d; return res; }, status: () => res };
    await searchController.search({
      query: { dataset: 'DocumentChunk', keywords: 'canary' },
      header: () => null
    }, res);

    const results = body[0].searchResults;
    assert.strictEqual(results.length, 1, 'the chunk of an invisible document must be dropped');
    assert.strictEqual(results[0].documentId, 'visible-doc');

    // The real assertion: the text must not appear ANYWHERE in the payload.
    assert.ok(
      !JSON.stringify(body).includes('SECRET-CANARY'),
      'the withheld chunk\'s extracted text must not reach the caller in any field'
    );
    assert.strictEqual(body[0].count, 1, 'the count is reported net of what was withheld');
  });

  await t.test('the count is the index total MINUS what was withheld, not the page size', async () => {
    // The distinguishing case: a large corpus, one withheld hit on this page. Reporting the page
    // length here would tell the frontend the whole corpus holds 1 match and collapse its paging.
    t.mock.method(aiSearch, 'searchChunks', async () => ({
      items: [
        { chunkId: 'a::p0::c0', documentId: 'visible-doc', projectId: 'p1', snippet: 'text', read: ['public'] },
        { chunkId: 'b::p0::c0', documentId: 'restricted-doc', projectId: 'p1', snippet: 'nope', read: ['public'] }
      ],
      count: 500
    }));
    t.mock.method(documentsRepo, 'listByIds', async () => [{ id: 'visible-doc', displayName: 'Doc' }]);
    t.mock.method(projectsRepo, 'listByIds', async () => [{ id: 'p1', name: 'P' }]);

    let body;
    const res = { json: (d) => { body = d; return res; }, status: () => res };
    await searchController.search({
      query: { dataset: 'DocumentChunk', keywords: 'x' }, header: () => null
    }, res);

    assert.strictEqual(body[0].searchResults.length, 1);
    assert.strictEqual(body[0].count, 499);
  });

  await t.test('nothing is dropped when every parent is visible', async () => {
    t.mock.method(aiSearch, 'searchChunks', async () => ({
      items: [{ chunkId: 'a::p0::c0', documentId: 'd1', projectId: 'p1', snippet: 'text', read: ['public'] }],
      count: 42
    }));
    t.mock.method(documentsRepo, 'listByIds', async () => [{ id: 'd1', displayName: 'Doc' }]);
    t.mock.method(projectsRepo, 'listByIds', async () => [{ id: 'p1', name: 'P' }]);

    let body;
    const res = { json: (d) => { body = d; return res; }, status: () => res };
    await searchController.search({
      query: { dataset: 'DocumentChunk', keywords: 'x' }, header: () => null
    }, res);

    assert.strictEqual(body[0].searchResults.length, 1);
    assert.strictEqual(body[0].count, 42, 'the index-wide total survives when nothing is withheld');
  });
});

// eagle-public speaks eagle-api's search contract and is not changing, so this endpoint has to.
// Every assertion below is a line in one of its templates or services, cited where it is not
// obvious: a shape that "looks right" but misses one of them renders an empty table with a 200.
test('the eagle-public response contract', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const capture = () => {
    const out = { body: undefined, status: 200 };
    const res = {
      json: (d) => { out.body = d; return res; },
      status: (code) => { out.status = code; return res; }
    };
    return { out, res };
  };

  // `search.service.ts:164` reads res[0].data.meta[0].searchResultsTotal, and
  // `project.service.ts:49` dereferences meta[0] with NO guard — a missing meta on dataset=Project
  // throws a TypeError that is re-thrown through two catchErrors and navigates the user off
  // /projects to the home page. The total is the index-wide count, not the page length.
  await t.test('every answer carries meta[0].searchResultsTotal', async () => {
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 995316,
      items: [{ id: '207', name: 'Site C', read: ['public'] }]
    }));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'site c' }, header: () => null }, res);

    assert.strictEqual(out.body[0].meta[0].searchResultsTotal, 995316);
    assert.strictEqual(out.body[0].searchResults.length, 1, 'one row, and a corpus-wide total');
  });

  // The empty branches are exactly the ones that used to omit `count`, and they are also the ones
  // /projects hits when a search matches nothing. meta must survive there or the page redirects.
  await t.test('an empty answer still carries meta', async () => {
    t.mock.method(aiSearch, 'searchProjects', async () => ({ count: 0, items: [] }));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'zarquonflux' }, header: () => null }, res);

    assert.deepStrictEqual(out.body[0].searchResults, []);
    assert.strictEqual(out.body[0].meta[0].searchResultsTotal, 0);
  });

  // A chunk total counts PASSAGES, and several can come from one document. eagle-search flags it
  // the same way so a caller cannot read the number as a document count.
  await t.test('chunk meta says the total counts passages', async () => {
    t.mock.method(aiSearch, 'searchChunks', async () => ({
      count: 4210,
      items: [{ chunkId: 'd1::p2::c0', documentId: 'd1', projectId: '207', pageNumber: 2, read: ['public'] }]
    }));
    t.mock.method(documentsRepo, 'listByIds', async () => ([{ id: 'd1', displayName: 'Application' }]));
    t.mock.method(projectsRepo, 'listByIds', async () => ([{ id: '207', name: 'Site C', eagleId: '588511c4aaecd9001b826192' }]));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'DocumentChunk', keywords: 'river' }, header: () => null }, res);

    const [meta] = out.body[0].meta;
    assert.strictEqual(meta.searchResultsTotal, 4210);
    assert.strictEqual(meta.countsPassages, true);
    assert.strictEqual(meta.documentsOnPage, 1);
  });

  // A parameter nobody reads is the dangerous class: `page=2` for `pageNum=1` answers page one
  // with a 200, and nothing anywhere says so.
  await t.test('an unknown parameter is refused, not ignored', async () => {
    let searched = false;
    t.mock.method(aiSearch, 'searchProjects', async () => { searched = true; return { count: 0, items: [] }; });

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'site c', page: '2' }, header: () => null }, res);

    assert.strictEqual(out.status, 400);
    assert.match(out.body.error, /page/);
    assert.strictEqual(searched, false, 'a refused request must not reach the service');
  });

  // 0-BASED on the wire: eagle-public's currentPage is 1-based and api.ts:173 sends `pageNum - 1`.
  await t.test('pageNum is turned into a skip', async () => {
    let sent;
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => { sent = opts; return { count: 0, items: [] }; });

    const { res } = capture();
    await searchController.search({
      query: { dataset: 'Document', keywords: 'fish', pageNum: '2', pageSize: '10' },
      header: () => null
    }, res);

    assert.strictEqual(sent.skip, 20, 'page 3 of 10 starts at row 20');
  });

  // `ProjectService.getAll()` defaults its page to 0 and api.ts subtracts one, so -1 is reachable
  // from the live frontend. A negative skip is a 400 from the service.
  await t.test('a negative pageNum floors at the first page', async () => {
    let sent;
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => { sent = opts; return { count: 0, items: [] }; });

    const { res } = capture();
    await searchController.search({
      query: { dataset: 'Document', keywords: 'fish', pageNum: '-1', pageSize: '10' },
      header: () => null
    }, res);

    assert.strictEqual(sent.skip, 0);
  });

  await t.test('sortBy reaches the service as an orderby', async () => {
    let sent;
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => { sent = opts; return { count: 0, items: [] }; });

    const { res } = capture();
    await searchController.search({
      query: { dataset: 'Document', keywords: 'fish', sortBy: ['-displayName', ''] },
      header: () => null
    }, res);

    assert.strictEqual(sent.orderby, 'displayName desc, id asc');
  });

  // eagle-public holds Eagle ObjectIds; the indexes hold DEMI project ids. Comparing one with the
  // other matches nothing, which renders as an empty project tab rather than as an error.
  await t.test('an Eagle project id is translated before the filter is built', async () => {
    let sent;
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => { sent = opts; return { count: 0, items: [] }; });
    t.mock.method(projectsRepo, 'getByEagleId', async (access, eagleId) => {
      assert.ok(access, 'the lookup runs under the caller, not a system context');
      assert.strictEqual(eagleId, '588511c4aaecd9001b826192');
      return { id: '207', name: 'Site C' };
    });

    const { res } = capture();
    await searchController.search({
      query: { dataset: 'Document', keywords: 'fish', project: '588511c4aaecd9001b826192' },
      header: () => null
    }, res);

    assert.ok(sent.filter.includes("projectId eq '207'"), 'the DEMI id reaches OData');
    assert.ok(!sent.filter.includes('588511c4aaecd9001b826192'), 'the Eagle id must not');
    assert.ok(sent.filter.includes("read/any(r: search.in(r, 'public', ','))"), 'ACL clause intact');
  });

  // Dropping an unresolvable project filter would answer the WHOLE corpus to a request that asked
  // for one project's documents — the same failure as forgetting the filter entirely.
  await t.test('an unresolved project filter is QUERIED as a literal, never dropped', async () => {
    // The requirement is unchanged — a project filter naming something unknown must not answer the
    // whole corpus — but the mechanism is. This used to short-circuit to `count: 0` without
    // querying, which was right while every ObjectId-shaped id in DEMI belonged to a project. It
    // stopped being right when the seed began admitting documents parented by a ProjectNotification:
    // that `_id` is ObjectId-shaped, has no project row, and IS the partition its documents live
    // under, so refusing to query it emptied the Project Notifications tab by construction.
    //
    // What actually prevents the widening is the id reaching the filter. Assert THAT, not the
    // absence of a request — an unmatched literal answers nothing on its own.
    let sent = null;
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => { sent = opts; return { count: 0, items: [] }; });
    t.mock.method(projectsRepo, 'getByEagleId', async () => null);

    const { out, res } = capture();
    await searchController.search({
      query: { dataset: 'Document', keywords: 'fish', project: '588511c4aaecd9001b826192' },
      header: () => null
    }, res);

    assert.deepStrictEqual(out.body[0].searchResults, []);
    assert.ok(sent, 'the request is now issued: an unresolved id may still name a real partition');
    // `sent.filter`, NOT `JSON.stringify(sent)`. The stringified form passes as long as the id
    // appears anywhere in the options — including in a field that does not restrict anything — and
    // that looseness is exactly why the same defect on `dataset=Project` went unnoticed here: there
    // the key is dropped and the corpus comes back, while the id still shows up in the object.
    assert.ok(sent.filter.includes("projectId eq '588511c4aaecd9001b826192'"),
      `the id must be in the FILTER, or the request widens to the corpus: ${sent.filter}`);
  });

  await t.test('an unresolved project filter on a dataset that cannot scope answers nothing', async () => {
    // The half this file's sibling missed. `projects` has no `projectId`, so the same wire shape
    // there is not a narrower filter — it is no filter at all, and answering the corpus to a
    // request naming one project is the widest reading of the narrowest ask.
    let searched = false;
    t.mock.method(aiSearch, 'searchProjects', async () => { searched = true; return { count: 348, items: [] }; });
    t.mock.method(projectsRepo, 'getByEagleId', async () => null);

    const { out, res } = capture();
    await searchController.search({
      query: { dataset: 'Project', keywords: 'coal', project: '588511c4aaecd9001b826192' },
      header: () => null
    }, res);

    assert.strictEqual(out.body[0].count, 0);
    assert.strictEqual(searched, false, 'and nothing is queried for a scope that cannot be expressed');
  });

  // `search-document-table-rows.component.html:8-10` binds rowData.project.name and
  // rowData.project._id with NO optional chaining — the only unguarded object deref in any of
  // eagle-public's row templates. A string here throws on every render of the row.
  await t.test('a document row carries the {_id, name} project pair, keyed on the Eagle id', async () => {
    t.mock.method(aiSearch, 'searchDocuments', async () => ({
      count: 1,
      items: [{ id: '58869abba4acd4014b81f55c', displayName: 'Application', projectId: '207', read: ['public'] }]
    }));
    t.mock.method(projectsRepo, 'listByIds', async () => ([
      { id: '207', name: 'Site C', eagleId: '588511c4aaecd9001b826192' }
    ]));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'Document', keywords: 'application' }, header: () => null }, res);

    const [row] = out.body[0].searchResults;
    assert.deepStrictEqual(row.project, { _id: '588511c4aaecd9001b826192', name: 'Site C' });
    assert.strictEqual(row.projectName, 'Site C', 'DEMI\'s own frontend still reads the flat name');
    assert.strictEqual(row.read, undefined, 'the row ACL is not published');
  });

  // A project this caller cannot read still labels its documents — the miss is a label, not a
  // gate — but the link then points at an id eagle-api will not resolve, so it must be visible
  // in the payload rather than silently absent.
  await t.test('an unreadable parent project leaves the DEMI id in the pair', async () => {
    t.mock.method(aiSearch, 'searchDocuments', async () => ({
      count: 1,
      items: [{ id: 'doc1', displayName: 'Application', projectId: '207', read: ['public'] }]
    }));
    t.mock.method(projectsRepo, 'listByIds', async () => ([]));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'Document', keywords: 'application' }, header: () => null }, res);

    assert.deepStrictEqual(out.body[0].searchResults[0].project,
      { _id: '207', name: 'Associated Project' });
  });

  // eagle-public routes p/${_id}/project-details and then re-fetches that project FROM EAGLE-API
  // by the same id. A DEMI Track id here is a link that 404s.
  await t.test('a project row is keyed on the Eagle id, falling back to the DEMI id', async () => {
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 2,
      items: [
        { id: '207', name: 'Site C', legacyEagleId: '588511c4aaecd9001b826192', read: ['public'] },
        { id: '999', name: 'Track Only', read: ['public'] }
      ]
    }));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'site' }, header: () => null }, res);

    const [eagleBacked, trackOnly] = out.body[0].searchResults;
    assert.strictEqual(eagleBacked._id, '588511c4aaecd9001b826192');
    assert.strictEqual(eagleBacked.id, '207', 'the DEMI id stays available to DEMI\'s frontend');
    assert.strictEqual(trackOnly._id, '999', 'no Eagle counterpart: the DEMI id, never undefined');
    assert.strictEqual(eagleBacked.read, undefined, 'the row ACL is not published');
  });

  // ONE STORED ROW, both branches, one answer. The indexer's SELECT renames two of its columns
  // (`azure/search/datasources/demi-projects-ds.json`: `c.projectState AS status`, `c.eagleId AS
  // legacyEagleId`), so an AI Search hit and the Cosmos row it was built from spell the same two
  // fields differently — and the keywordless branch was reading the INDEX names off a COSMOS row.
  // `p.status` is never defined on a stored project, so `|| 'Active'` fired unconditionally and
  // this branch reported a completed project as Active: not a gap, a wrong value asserted as fact.
  //
  // Written as a parity assertion rather than two literal expectations on purpose. A test that
  // hardcodes 'Completed' twice still passes if someone later changes ONE branch; comparing the two
  // payloads field by field is what actually holds the contract eagle-public depends on, which is
  // that a project reads the same whether or not the caller typed a keyword.
  await t.test('the same project reads the same on the Cosmos and AI Search branches', async () => {
    // The STORED shape, as merge/project.js writes it (`projectState` at :38, `eagleId` at :171).
    const stored = {
      id: '207',
      // A NUMBER, as merge/project.js:170 writes it (`Number(track.track_project_id)`). The index
      // has no such field at all — the datasource SELECT does not list it — so the AI branch falls
      // back to the index key, which is a String. That mismatch is why both branches coerce.
      trackProjectId: 207,
      name: 'Site C',
      sector: 'Energy-Electricity',
      region: 'Peace River',
      projectState: 'Completed',
      eagleId: '588511c4aaecd9001b826192',
      read: ['public'],
      isPublished: true
    };
    // The same row after the indexer's SELECT — the aliases applied, nothing else changed.
    const indexed = {
      id: stored.id,
      name: stored.name,
      sector: stored.sector,
      region: stored.region,
      status: stored.projectState,
      legacyEagleId: stored.eagleId,
      read: stored.read
    };

    t.mock.method(projectsRepo, 'listVisible', async () => ({ items: [stored] }));
    t.mock.method(projectsRepo, 'countVisible', async () => 1);
    t.mock.method(aiSearch, 'searchProjects', async () => ({ count: 1, items: [indexed] }));

    const fallback = capture();
    await searchController.search(
      { query: { dataset: 'Project', keywords: '', pageSize: '10' }, header: () => null },
      fallback.res);
    const [viaCosmos] = fallback.out.body[0].searchResults;

    const keyword = capture();
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'site c', pageSize: '10' }, header: () => null },
      keyword.res);
    const [viaIndex] = keyword.out.body[0].searchResults;

    // EVERY field both branches emit, derived from the payloads rather than listed by hand — a
    // hand-written list is how `trackProjectId` stayed out of the comparison while it was the one
    // field still disagreeing (Cosmos stores a Number, the index returns a String).
    const common = Object.keys(viaCosmos).filter(k => k in viaIndex);
    assert.ok(common.length >= 10, `expected both branches to emit ~12 fields, saw ${common.length}`);
    for (const field of common) {
      assert.deepStrictEqual(viaCosmos[field], viaIndex[field],
        `${field} disagrees between the Cosmos and AI Search branches`);
    }
    assert.ok(common.includes('trackProjectId'), 'trackProjectId must be in the comparison');
    // Pinned as well as compared: parity alone would also be satisfied by both branches being
    // wrong in the same direction, which is the failure mode this route already shipped once.
    assert.strictEqual(viaCosmos.status, 'Completed', 'the real project state, not the default');
    assert.strictEqual(viaCosmos.legacyEagleId, '588511c4aaecd9001b826192');
    assert.strictEqual(viaCosmos._id, '588511c4aaecd9001b826192', 'keyed on the Eagle ObjectId');
    assert.strictEqual(viaCosmos.trackProjectId, '207', 'a String on both branches, not a Number');
  });

  await t.test('an API-created project now reads the SAME state on both branches', async (t2) => {
    // THE ROW COMES FROM THE REAL WRITER, not a literal. The two writers used to disagree —
    // `merge/project.js:38` stored `projectState`, `createProject` stored `status` — and the
    // earlier version of this test pinned that gap with a hand-made row. A literal cannot notice
    // the day the writer changes, which is the whole failure this file exists to catch, so this
    // drives createProject and reads back whatever it actually stored.
    const projectController = require('../../src/controllers/nosql/project');
    let saved;
    t2.mock.method(projectsRepo, 'upsert', async (doc) => { saved = doc; return doc; });
    const noop = () => noop;
    await projectController.createProject(
      { body: { trackProjectId: 9001, name: 'Hand Made', status: 'Withdrawn',
        centroid: { coordinates: [0, 0] }, isPublished: true } },
      { json: noop, status: () => ({ json: noop }) });
    t2.mock.restoreAll();

    assert.strictEqual(saved.projectState, 'Withdrawn', 'stored under the name the sync uses');
    assert.ok(!('status' in saved), 'the wire name must not reach the container');

    // Cosmos branch: reads the stored row.
    t.mock.method(projectsRepo, 'listVisible', async () => ({ items: [saved] }));
    t.mock.method(projectsRepo, 'countVisible', async () => 1);
    const c = capture();
    await searchController.search(
      { query: { dataset: 'Project', keywords: '', pageSize: '10' }, header: () => null }, c.res);
    assert.strictEqual(c.out.body[0].searchResults[0].status, 'Withdrawn',
      'a row written by createProject must not read back as the Active default');

    // Index branch: the data source aliases `c.projectState AS status`
    // (`azure/search/datasources/demi-projects-ds.json`), so project the stored row through that
    // same alias rather than inventing an index shape by hand.
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 1,
      items: [{ id: saved.id, name: saved.name, status: saved.projectState, read: ['public'] }]
    }));
    const k = capture();
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'hand made', pageSize: '10' }, header: () => null }, k.res);

    assert.strictEqual(k.out.body[0].searchResults[0].status, 'Withdrawn',
      'the index now carries the real state — the writers agree, so the branches must too');
  });
});

// Four defects with one shape: the server read the input and then answered something else. A
// status-code assertion cannot see any of them, so every test below asserts on the request that
// went out or the total that came back.
test('the answer matches the request that was made', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const capture = () => {
    const out = { body: undefined, status: 200 };
    const res = {
      json: (d) => { out.body = d; return res; },
      status: (code) => { out.status = code; return res; }
    };
    return { out, res };
  };

  // A `sortBy` on a keywordless list USED TO BE INERT: the repositories hardcode their order, so
  // the sort was dropped, logged, and answered 200 with the repository's own order — the exact case
  // this endpoint's contract singles out ("a sort doing nothing ... all under a 200"). eagle-public
  // reaches it on every documents-tab render, which sends `keywords: ''` with `sortBy=-datePosted`.
  // A search that carries a sort now goes to the INDEX, which can express one. Asserted on the
  // `$orderby` that went out AND on the list read never being issued — a route that quietly served
  // the fixed-order list beside a correct-looking log line is the whole defect.
  for (const [dataset, repo, service, sortBy, expected] of [
    ['Project', projectsRepo, 'searchProjects', '-name', 'name desc'],
    ['Document', documentsRepo, 'searchDocuments', '-datePosted', 'datePosted desc']
  ]) {
    await t.test(`a sort on the keywordless ${dataset} list reaches the index, not the fixed order`,
      async () => {
        let listed = false;
        t.mock.method(repo, 'listVisible', async () => { listed = true; return { items: [] }; });
        t.mock.method(repo, 'countVisible', async () => 0);
        let sent;
        t.mock.method(aiSearch, service, async (opts) => {
          sent = opts;
          return { count: 0, items: [] };
        });

        const { out, res } = capture();
        await searchController.search(
          { query: { dataset, keywords: '', sortBy, pageSize: '10' }, header: () => null }, res);

        assert.strictEqual(out.status, 200);
        assert.ok(sent, `${dataset}: a sorted search must reach the index`);
        assert.ok(sent.orderby.startsWith(expected),
          `${dataset}: expected an $orderby of ${expected}, got ${sent.orderby}`);
        assert.strictEqual(sent.matchAll, true, 'no keywords means match-all, not zero rows');
        assert.strictEqual(listed, false,
          `${dataset}: the fixed-order list read must not answer a sorted search`);
      });
  }

  // THE DEFECT, measured live: `and[milestone]=x` on `dataset=Document` with no keywords returned
  // 60,578 rows from demi and 0 from eagle-search for the same URL. The filter reached a Cosmos
  // list read whose criteria are fixed, so it was dropped-and-logged and the caller got the whole
  // corpus under a 200 — a silently-ignored parameter, which is the failure class this endpoint's
  // own contract calls out.
  await t.test('a keywordless filter is applied by the index, not dropped for the whole corpus',
    async () => {
      let listed = false;
      t.mock.method(documentsRepo, 'listVisible', async () => { listed = true; return { items: [] }; });
      t.mock.method(documentsRepo, 'countVisible', async () => 60578);
      let sent;
      t.mock.method(aiSearch, 'searchDocuments', async (opts) => {
        sent = opts;
        return { count: 2, items: [] };
      });

      const { out, res } = capture();
      await searchController.search({
        query: { dataset: 'Document', keywords: '', 'and[milestone]': '5cf00c03a266b7e1877504ca',
          pageSize: '10' },
        header: () => null
      }, res);

      assert.strictEqual(listed, false, 'the unfiltered list read must not answer a filtered search');
      // `milestoneId`, not `milestone`: eagle-public's four document facets send List ObjectIds and
      // the index carries the id column beside the label (ALIASES, eagle-query.js).
      assert.match(sent.filter, /milestoneId eq '5cf00c03a266b7e1877504ca'/);
      // DEFAULT_ORDER, not `search.score() desc`. `search: '*'` scores every row the same, so a
      // relevance order leaves ties wherever the service computed them and `$skip` paging then
      // repeats and omits rows across pages — data loss, as far as the reader is concerned.
      assert.match(sent.orderby, /^displayName asc/,
        `a keywordless page needs a stable order, got ${sent.orderby}`);
      assert.strictEqual(out.body[0].meta[0].searchResultsTotal, 2,
        'the total is the filtered one, never the corpus');
    });

  // [R2] A criteria search that matches nothing must answer NOTHING. Falling through to the
  // keywordless list — which is what a `if (items.length === 0)` fallback would do — turns a filter
  // with no matches into the entire readable corpus, which is the bug being fixed, not a fallback.
  await t.test('a keywordless filter that matches nothing answers empty, never the corpus',
    async () => {
      let listed = false;
      t.mock.method(documentsRepo, 'listVisible', async () => { listed = true; return { items: [] }; });
      t.mock.method(documentsRepo, 'countVisible', async () => 60578);
      t.mock.method(aiSearch, 'searchDocuments', async () => ({ count: 0, items: [] }));

      const { out, res } = capture();
      await searchController.search({
        query: { dataset: 'Document', keywords: '', 'and[type]': 'nothing-matches-this',
          pageSize: '10' },
        header: () => null
      }, res);

      assert.strictEqual(out.status, 200);
      assert.strictEqual(listed, false, 'no fall-through to the unfiltered list');
      assert.deepStrictEqual(out.body[0].searchResults, []);
      assert.strictEqual(out.body[0].count, 0);
    });

  // [R1] `project` ALONE is deliberately NOT criteria, and it used to keep this request on the
  // Cosmos read for that reason. It does not any more: that read pages by overfetch-and-slice
  // against a 1000-row clamp, so `&project=<id>&pageSize=500` — the shape DEMI's own frontend and
  // eagle-public's project tabs send — served two pages of a 2,488-document project and answered
  // every later page with zero rows beside the full count. The routing test still excludes
  // `project` for the PROJECT dataset's sake; this dataset no longer asks it.
  await t.test('a project filter alone is served by the index, not the Cosmos read', async () => {
    t.mock.method(projectsRepo, 'getByEagleId', async () => ({ id: '207', name: 'Site C' }));
    t.mock.method(documentsRepo, 'listVisible', async () => {
      assert.fail('no document read may go to Cosmos — it cannot page past 1000 rows');
    });
    let sent = null;
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => {
      sent = opts;
      return { count: 4, items: [] };
    });

    const { out, res } = capture();
    await searchController.search({
      query: { dataset: 'Document', keywords: '', project: '588511c4aaecd9001b826192',
        pageSize: '500' },
      header: () => null
    }, res);

    // The Eagle ObjectId still resolves to the DEMI id before it reaches the filter — that
    // translation was the Cosmos path's job to prove, and it is still the thing that decides
    // whether one project's tab shows one project's documents or the whole corpus.
    assert.ok(sent, 'the index answered');
    assert.match(sent.filter, /207/, 'the resolved project id reaches the index filter');
    assert.strictEqual(out.body[0].meta[0].searchResultsTotal, 4);
  });

  // THE TRAP UNDER THE ROUTING TEST. eagle-public appends `sortBy` twice and the second is
  // routinely empty (`api.ts:176-177`), so `project.service.getAll` sends `sortBy=&sortBy=` on
  // every call — including the two `getAllFull(1, 1000000)` callers that draw the projects map. A
  // truthiness test on `sortBy` reads that as a sort and moves a million-row read onto the index,
  // where MAX_PAGE_ROWS would either refuse it or truncate it to 500 without saying so.
  await t.test('eagle-public\'s empty double sortBy is not a sort', async () => {
    let listOpts;
    t.mock.method(projectsRepo, 'listVisible', async (access, opts) => {
      listOpts = opts;
      return { items: [] };
    });
    t.mock.method(projectsRepo, 'countVisible', async () => 382);
    let searched = false;
    t.mock.method(aiSearch, 'searchProjects', async () => { searched = true; return { count: 0, items: [] }; });

    const { out, res } = capture();
    await searchController.search({
      query: { dataset: 'Project', keywords: '', sortBy: ['', ''], pageSize: '1000000' },
      header: () => null
    }, res);

    assert.strictEqual(out.status, 200, 'the projects map is not refused for a page ceiling');
    assert.strictEqual(searched, false, 'and it is not moved onto the index page ceiling either');
    // 5000, not 1000000: the route's own hard cap on `pageSize`, applied before either backend.
    // What matters here is that the Cosmos read is the one that got it.
    assert.strictEqual(listOpts.pageSize, 5000);
  });

  // [R6] A FAILED criteria search is not an empty one and is not the unfiltered list. This is the
  // fall-through this file already closed once for keyword searches; widening the route must not
  // reopen it for filters.
  await t.test('a keywordless filtered search that faults is a 502, never the unfiltered list',
    async () => {
      let listed = false;
      t.mock.method(documentsRepo, 'listVisible', async () => { listed = true; return { items: [] }; });
      t.mock.method(documentsRepo, 'countVisible', async () => 60578);
      t.mock.method(aiSearch, 'searchDocuments', async () => { throw new Error('index 400'); });

      const { out, res } = capture();
      await searchController.search({
        query: { dataset: 'Document', keywords: '', 'and[type]': 'x', pageSize: '10' },
        header: () => null
      }, res);

      assert.strictEqual(out.status, 502);
      assert.strictEqual(listed, false, 'a failed search must never be answered by the list read');
    });

  // [R7] A key the index genuinely cannot express is still dropped-and-logged, and that is correct
  // — `documentAuthor` is in neither the index nor the Cosmos predicate. It replaced `isFeatured`,
  // which TODO 3.3 made expressible. What had to stop is dropping keys the index CAN express. The row still comes back filtered by everything
  // else, which is the same answer as before; the difference is that the rest of the filter applies.
  await t.test('a key the index cannot express is still named in the log', async () => {
    t.mock.method(aiSearch, 'searchDocuments', async () => ({ count: 0, items: [] }));
    const warned = [];
    t.mock.method(logger, 'warn', (msg) => warned.push(String(msg)));

    const { res } = capture();
    await searchController.search({
      query: { dataset: 'Document', keywords: '', 'and[documentAuthor]': 'x', pageSize: '5' },
      header: () => null
    }, res);

    assert.ok(warned.some(m => /dropped filter/.test(m) && /documentAuthor/.test(m)),
      `an inexpressible key must be named, got: ${JSON.stringify(warned)}`);
  });

  // [C2] The keywordless Document path resolved the Eagle ObjectId to a DEMI project id and then
  // dropped it: a request for ONE project's documents was answered with the whole corpus, under a
  // corpus-wide total. That is the failure `resolveProjectFilter`'s docstring warns about, landing
  // on the branch where the project WAS resolvable. The read moved to the index; the way it fails
  // did not, so this still asserts the scope reaches BOTH the rows and the total — the index
  // returns one `count` computed under the filter it was given, so a filter that lost the project
  // reports the corpus exactly as before.
  await t.test('a project-scoped list is scoped, and so is its total', async () => {
    let sent = null;
    t.mock.method(projectsRepo, 'getByEagleId', async (access, eagleId) => {
      assert.strictEqual(eagleId, '588511c4aaecd9001b826192');
      return { id: '207', name: 'Site C' };
    });
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => {
      sent = opts;
      return { count: 4, items: [] };
    });

    const { out, res } = capture();
    await searchController.search({
      query: {
        dataset: 'Document',
        keywords: '',
        project: '588511c4aaecd9001b826192',
        pageNum: '0',
        pageSize: '10'
      },
      header: () => null
    }, res);

    assert.match(sent.filter, /projectId/, 'the scope is applied as a filter, not dropped');
    assert.match(sent.filter, /207/, 'and it is the resolved DEMI id, not the Eagle ObjectId');
    assert.strictEqual(out.body[0].meta[0].searchResultsTotal, 4);
  });

  // [C3] The client pages in units of `pageSize`; the server used to skip in units of
  // `min(pageSize, 250)`. Reachable from eagle-public's "Show All", which offers 500.
  await t.test('the offset is in the page size the caller asked for', async () => {
    let sent;
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => {
      sent = opts;
      return { count: 3000, items: [] };
    });

    const { res } = capture();
    await searchController.search({
      query: { dataset: 'Document', keywords: 'fish', pageNum: '2', pageSize: '500' },
      header: () => null
    }, res);

    assert.strictEqual(sent.skip, 1000, 'page 3 of 500 starts at row 1000, not row 500');
    assert.strictEqual(sent.top, 500, 'and asks for the page the caller asked for');
  });

  // The KEYWORDLESS branches page differently and had no coverage at all. Cosmos has no offset —
  // it pages with continuation tokens (`_sql.js:89-92`) — so both list paths overfetch
  // `skip + pageSize` rows and drop the first `skip` by hand. Deleting that slice left the whole
  // suite green while every page served page one: the request that goes out is IDENTICAL on both
  // pages by construction (same predicate, only a larger pageSize), so a test that inspects the
  // outgoing options or the status code cannot see the defect. These assert the rows that come
  // back, and assert page 2 against page 1 — the shape a client actually experiences.
  //
  // The stub returns the first N rows for a pageSize of N, which is what the overfetch depends on.
  const listStub = prefix => async (_access, opts) =>
    ({ items: Array.from({ length: opts.pageSize }, (_, i) => ({
      id: `${prefix}${i}`, projectId: '207', read: ['public']
    })) });
  const expectedIds = (prefix, from) => Array.from({ length: 10 }, (_, i) => `${prefix}${from + i}`);

  await t.test('the keywordless project list serves page 2 from row 10, not row 0', async () => {
    t.mock.method(projectsRepo, 'listVisible', listStub('proj'));
    t.mock.method(projectsRepo, 'countVisible', async () => 40);

    const idsOnPage = async (pageNum) => {
      const { out, res } = capture();
      await searchController.search({
        query: { dataset: 'Project', keywords: '', pageNum: String(pageNum), pageSize: '10' },
        header: () => null
      }, res);
      return out.body[0].searchResults.map(r => r._id);
    };

    const first = await idsOnPage(0);
    const second = await idsOnPage(1);
    assert.deepStrictEqual(first, expectedIds('proj', 0));
    assert.deepStrictEqual(second, expectedIds('proj', 10), 'page 2 starts at row 10');
    assert.strictEqual(second.length, 10, 'and is a page, not the overfetched 20 rows');
  });

  // The other half of that decision, written down: a page bigger than the search layer will
  // assemble is REFUSED. Returning a short page under a large total is the failure, not the fix.
  await t.test('a keyword page beyond the ceiling is refused, not silently shortened', async () => {
    let searched = false;
    t.mock.method(aiSearch, 'searchDocuments', async () => {
      searched = true;
      return { count: 0, items: [] };
    });

    const { out, res } = capture();
    await searchController.search({
      query: { dataset: 'Document', keywords: 'fish', pageSize: '501' },
      header: () => null
    }, res);

    assert.strictEqual(out.status, 400);
    assert.match(out.body.error, /pageSize/);
    assert.strictEqual(searched, false);
  });

  // [C4] The Cosmos branches counted only when `pageNum` was present, and the envelope filled the
  // gap with the page length. DEMI's own frontend is the live caller with that request shape —
  // `registry-state.service.ts` asks for pageSize=500 and no pageNum — so a registry of any size
  // reported 500.
  await t.test('a page-sized list does not report its own length as the corpus', async () => {
    t.mock.method(projectsRepo, 'listVisible', async () => ({
      items: [{ id: '207', name: 'Site C', read: ['public'] }]
    }));
    t.mock.method(projectsRepo, 'countVisible', async () => 4210);

    const { out, res } = capture();
    await searchController.search({
      query: { dataset: 'Project', keywords: '', pageSize: '500' },
      header: () => null
    }, res);

    assert.strictEqual(out.body[0].searchResults.length, 1);
    assert.strictEqual(out.body[0].meta[0].searchResultsTotal, 4210,
      'the measured total, never the number of rows on the page');
  });

  // The rule itself, at the one place it is enforced. An absent count means NOT MEASURED, and the
  // envelope must say so rather than publishing the page length as a fact about the index.
  await t.test('an unmeasured total is omitted, not filled in from the page', async () => {
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      items: [{ id: '207', name: 'Site C', read: ['public'] }]
    }));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'site c' }, header: () => null }, res);

    assert.strictEqual(out.body[0].searchResults.length, 1);
    assert.ok(Array.isArray(out.body[0].meta), 'meta itself must survive — project.service.ts:49');
    assert.strictEqual(out.body[0].meta[0].searchResultsTotal, undefined,
      'not 1, which is the page length wearing the corpus total\'s name');
  });

  // [C5] A search that FAILED is not a search that found nothing. 200 with an empty array told
  // every visitor of /projects that the registry holds no projects.
  await t.test('a failed list is reported, not published as an empty registry', async () => {
    t.mock.method(projectsRepo, 'listVisible', async () => {
      throw new Error('Cosmos DB request rate is large');
    });

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'Project', keywords: '', pageSize: '10' }, header: () => null }, res);

    assert.strictEqual(out.status, 502);
    assert.ok(!Array.isArray(out.body), 'no result set is published for a search that did not run');
  });

  // [S1] The whole point of the type gate, seen from the endpoint: a 400 from the search service
  // must not be answered with the keywordless corpus listing. `and[centroid]=x` is the request that
  // proved it — the filter is dropped now, so the search still runs, and a failure that DOES reach
  // the catch answers 502 rather than an arbitrary page.
  await t.test('a keyword search that faults never answers with the unkeyworded list', async () => {
    let listed = false;
    t.mock.method(aiSearch, 'searchProjects', async () => {
      throw Object.assign(new Error('HTTP 400 invalid expression'), { status: 400 });
    });
    t.mock.method(projectsRepo, 'listVisible', async () => {
      listed = true;
      return { items: [{ id: '999', name: 'Some Other Project', read: ['public'] }] };
    });

    const { out, res } = capture();
    await searchController.search({
      query: { dataset: 'Project', keywords: 'zarquonflux', 'and[centroid]': 'x' },
      header: () => null
    }, res);

    assert.strictEqual(listed, false, 'the corpus listing must not answer a keyword search');
    assert.strictEqual(out.status, 502);
  });

  // [C7] Two id-spaces, two fields, neither derived from the other. `project._id` is the EAGLE
  // ObjectId eagle-public routes on; `projectId` is the DEMI id that is the Cosmos partition key
  // and the id-space DEMI's own frontend compares against `Project.id`.
  //
  // Asserted once, for one mapper. There used to be a keywordless twin of this test because
  // there used to be a keywordless mapper; both are gone with the Cosmos document read.
  await t.test('a document row carries the DEMI project id as well as the Eagle one', async () => {
    t.mock.method(aiSearch, 'searchDocuments', async () => ({
      count: 1,
      items: [{ id: 'doc1', displayName: 'Application', projectId: '207', read: ['public'] }]
    }));
    t.mock.method(projectsRepo, 'listByIds', async () => ([
      { id: '207', name: 'Site C', eagleId: '588511c4aaecd9001b826192' }
    ]));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'Document', keywords: 'application' }, header: () => null }, res);

    const [row] = out.body[0].searchResults;
    assert.strictEqual(row.projectId, '207', 'the DEMI id, which is the partition key');
    assert.strictEqual(row.project._id, '588511c4aaecd9001b826192', 'the Eagle id, for the link');
  });

  await t.test('a chunk row carries the DEMI project id as well as the Eagle one', async () => {
    t.mock.method(aiSearch, 'searchChunks', async () => ({
      count: 1,
      items: [{ chunkId: 'c1', documentId: 'd1', projectId: '207', pageNumber: 1, read: ['public'] }]
    }));
    t.mock.method(documentsRepo, 'listByIds', async () => ([{ id: 'd1', displayName: 'Doc' }]));
    t.mock.method(projectsRepo, 'listByIds', async () => ([
      { id: '207', name: 'Site C', eagleId: '588511c4aaecd9001b826192' }
    ]));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'DocumentChunk', keywords: 'river' }, header: () => null }, res);

    const [row] = out.body[0].searchResults;
    assert.strictEqual(row.projectId, '207');
    assert.strictEqual(row.project._id, '588511c4aaecd9001b826192');
  });

  // THE PROBE URL ITSELF, run through this controller. The availability web test asserts only an
  // HTTP 200, so a query the app can answer without AI Search leaves the alert green through a
  // total index outage — which is what `dataset=Project&pageSize=1` did: `hasCriteria` is false
  // without keywords or a filter, and the Project branch answers that from Cosmos.
  //
  // Reading the URL out of the param file rather than restating it is the point: editing that
  // line back to a Cosmos-served query turns this red.
  await t.test('the deployed prod availability probe fails when AI Search does', async () => {
    const params = fs.readFileSync(
      path.join(__dirname, '..', '..', 'azure', 'main.prod.bicepparam'), 'utf8');
    const match = /^param availabilityUrl = '([^']+)'$/m.exec(params);
    assert.ok(match, 'prod must set availabilityUrl');
    const query = Object.fromEntries(new URL(match[1]).searchParams);

    t.mock.method(aiSearch, 'searchDocuments', async () => {
      throw new Error('AI Search is down');
    });

    // Cosmos answers NORMALLY here, and that is deliberate. Throwing from these stubs would be
    // caught by the controller and returned as the very 502 this asserts — a green test for a
    // probe served entirely by Cosmos. They have to succeed for the assertion to mean anything.
    let servedByCosmos = false;
    t.mock.method(projectsRepo, 'listVisible', async () => {
      servedByCosmos = true;
      return { items: [] };
    });
    t.mock.method(projectsRepo, 'countVisible', async () => 0);
    t.mock.method(logger, 'error', () => {});

    const { out, res } = capture();
    await searchController.search({ query, header: () => null }, res);

    assert.strictEqual(servedByCosmos, false,
      'a query Cosmos can answer stays 200 through a total AI Search outage');
    assert.strictEqual(out.status, 502,
      'an AI Search outage must show up as a non-200 on the probe URL');
  });

  // EVERY REPOSITORY ROW ON THIS ROUTE IS REDACTED BEFORE A LABEL IS READ OFF IT. Reverting any of
  // the five `redactAllForAccess` calls in this controller to the raw rows left the suite green,
  // so the three tests below pin each site through the one thing a caller can see: a field a
  // per-record `vis` dial withholds from an anonymous caller must not reach the response, not even
  // as a label. The dial is the mechanism the redactor exists for — day-one defaults are 4/4, so a
  // catalogued field is otherwise indistinguishable from an unredacted one.
  await t.test('a dialled-down project name never labels a document row', async () => {
    t.mock.method(aiSearch, 'searchDocuments', async () => ({
      count: 1,
      items: [{ id: 'doc1', displayName: 'Application', projectId: '207', read: ['public'] }]
    }));
    t.mock.method(projectsRepo, 'listByIds', async () => ([{
      id: '207',
      name: 'Site C',
      eagleId: '588511c4aaecd9001b826192',
      // Level 2 and below only; an anonymous caller is level 4.
      vis: { name: 2, eagleId: 2 },
      read: ['staff'],
      s3Key: 'x',
      _etag: 'e'
    }]));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'Document', keywords: 'application' }, header: () => null }, res);

    const [row] = out.body[0].searchResults;
    assert.strictEqual(row.projectName, 'Associated Project');
    assert.deepStrictEqual(row.project, { _id: '207', name: 'Associated Project' },
      'the withheld Eagle id leaves the DEMI id in the pair');
  });

  await t.test('a chunk row is built from redacted parent rows', async () => {
    t.mock.method(aiSearch, 'searchChunks', async () => ({
      count: 1,
      items: [{ chunkId: 'c1', documentId: 'd1', projectId: '207', pageNumber: 3, snippet: 'a river' }]
    }));
    t.mock.method(documentsRepo, 'listByIds', async () => ([{
      id: 'd1',
      displayName: 'First',
      documentFileName: 'first.pdf',
      vis: { displayName: 2, documentFileName: 2 },
      // `type` carries no dial, so it proves the redactor is not simply emptying the row.
      type: 'PDF Document',
      milestone: 'Other',
      milestoneId: 'm1',
      datePosted: '2020-01-01T00:00:00.000Z',
      read: ['staff'],
      s3Key: 'x',
      _etag: 'e'
    }]));
    t.mock.method(projectsRepo, 'listByIds', async () => ([{
      id: '207',
      name: 'Site C',
      eagleId: '588511c4aaecd9001b826192',
      vis: { name: 2, eagleId: 2 },
      read: ['staff'],
      _etag: 'e'
    }]));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'DocumentChunk', keywords: 'river' }, header: () => null }, res);

    assert.deepStrictEqual(out.body[0].searchResults, [{
      _id: 'd1',
      _schemaName: 'DocumentChunk',
      documentId: 'd1',
      chunkId: 'c1',
      projectId: '207',
      project: { _id: '207', name: 'Associated Project' },
      projectName: 'Associated Project',
      documentName: 'Untitled Document',
      documentType: 'PDF Document',
      milestone: 'Other',
      milestoneId: 'm1',
      datePosted: '2020-01-01T00:00:00.000Z',
      pageNumber: 3,
      content: '',
      snippet: 'a river',
      snippets: ['a river'],
      matchCount: 1
    }], 'no s3Key, no read[], no _etag, no vis, and no withheld label');
  });

  await t.test('a summary citation is built from redacted parent rows', async () => {
    t.mock.method(aiSearch, 'searchChunks', async () => ({
      items: [{ chunkId: 'c1', documentId: 'd1', projectId: '207', pageNumber: 5 }]
    }));
    t.mock.method(chunksRepo, 'getById', async () => ({ id: 'c1', content: 'text of c1' }));
    t.mock.method(documentsRepo, 'listByIds', async () => ([{
      id: 'd1',
      displayName: 'First',
      documentFileName: 'first.pdf',
      vis: { displayName: 2, documentFileName: 2 },
      read: ['staff'],
      s3Key: 'x',
      _etag: 'e'
    }]));
    t.mock.method(projectsRepo, 'listByIds', async () => ([{
      id: '207',
      name: 'Site C',
      vis: { name: 2 },
      read: ['staff'],
      _etag: 'e'
    }]));
    t.mock.method(summarizer, 'summarize', async () => ({
      summary: 'a grounded answer',
      citations: [0],
      usage: null,
      estimatedCostCad: 0
    }));

    const { out, res } = capture();
    await searchController.summarize({ query: { keywords: 'caribou' }, header: () => null }, res);

    assert.deepStrictEqual(out.body.citations, [{
      n: 1,
      chunkId: 'c1',
      documentId: 'd1',
      projectId: '207',
      pageNumber: 5,
      documentName: 'Untitled Document',
      projectName: 'Associated Project'
    }]);
  });
});
