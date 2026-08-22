'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const searchController = require('../../src/controllers/search');
const aiSearch = require('../../src/search/ai-search');
const documentsRepo = require('../../src/repositories/documents');
const projectsRepo = require('../../src/repositories/projects');
const { logger } = require('../../src/utils/logger');

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
        // The stored shape. Only `wildfire` — DEMI's own aggregate, which the map explorer
        // renders — may reach a caller; the raw upstream payloads are traceability.
        sources: {
          track: { proponent_name: 'KGHM' },
          eagle: { projectLeadEmail: 'lead@gov.bc.ca' },
          wildfire: { count: 2, activeNearby: true }
        }
      }
    ];

    t.mock.method(projectsRepo, 'listVisible', async (access, opts) => {
      // The repository owns the SQL; what this path must not lose is the track-provenance
      // restriction and the caller's access context — the two things the old Mongo filter
      // combined by hand.
      assert.ok(access, 'expected an access context');
      assert.strictEqual(opts.trackOnly, true);
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
    assert.strictEqual(sources.wildfire.count, 2, 'wildfire aggregate survives for the map');
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

  await t.test('search documents returns documents from Cosmos DB', async () => {
    const mockDocuments = [
      {
        id: 'doc1',
        displayName: 'Test Doc',
        s3Key: 'uploads/test_doc.pdf',
        region: 'Skeena',
        projectId: '12345',
        read: ['public'],
        isPublished: true
      }
    ];

    t.mock.method(documentsRepo, 'listVisible', async (access, opts) => {
      assert.ok(access, 'expected an access context');
      assert.strictEqual(opts.pageSize, 10);
      return { items: mockDocuments };
    });

    // The keywordless path labels its results too, exactly as the AI Search path does.
    t.mock.method(projectsRepo, 'listByIds', async (access, ids) => {
      assert.deepStrictEqual(ids, ['12345']);
      return [{ id: '12345', name: 'Ajax Mine' }];
    });

    const req = {
      query: { dataset: 'Document', keywords: '', pageSize: '10' },
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
    assert.strictEqual(jsonResponse[0].searchResults[0].displayName, 'Test Doc');
    assert.strictEqual(jsonResponse[0].searchResults[0].documentFileName, 'test_doc.pdf');
    assert.strictEqual(jsonResponse[0].searchResults[0].isPublished, true);
    assert.strictEqual(jsonResponse[0].searchResults[0].projectName, 'Ajax Mine');
  });

  // The Cosmos full-text backend was ruled out and Azure AI Search is not built yet (TODO.md §B),
  // so this branch answers empty WITHOUT reaching any data layer. Asserting "never queried" is the
  // point: a stub that still hit Cosmos would burn RU per keystroke against a container with no
  // full-text index, and the failure would show up as latency rather than as an error.
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
        return [{ id: 'd1', displayName: 'Application', documentFileName: 'app.pdf', type: 'Application' }];
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
      assert.strictEqual(hit._id, 'd1::p2::c0');
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
  await t.test('an unknown project filter returns no rows rather than every row', async () => {
    let searched = false;
    t.mock.method(aiSearch, 'searchDocuments', async () => { searched = true; return { count: 9, items: [] }; });
    t.mock.method(projectsRepo, 'getByEagleId', async () => null);

    const { out, res } = capture();
    await searchController.search({
      query: { dataset: 'Document', keywords: 'fish', project: '588511c4aaecd9001b826192' },
      header: () => null
    }, res);

    assert.deepStrictEqual(out.body[0].searchResults, []);
    assert.strictEqual(searched, false, 'no request may be issued for a project nobody can name');
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

  await t.test('a project created through the API reports its real state too', async () => {
    // TWO WRITERS DISAGREE ON THIS FIELD. `merge/project.js:38` stores `projectState`;
    // `controllers/nosql/project.js:87` createProject stores `status`. Reading only `projectState`
    // fixes the synced rows and breaks the API-created ones — the same wrong answer from the other
    // direction, which is why the mapper reads whichever name the row carries.
    const apiCreated = {
      id: '9001', name: 'Hand Made', status: 'Withdrawn',
      eagleId: '588511c4aaecd9001b826192', read: ['public'], isPublished: true
    };
    t.mock.method(projectsRepo, 'listVisible', async () => ({ items: [apiCreated] }));
    t.mock.method(projectsRepo, 'countVisible', async () => 1);

    const c = capture();
    await searchController.search(
      { query: { dataset: 'Project', keywords: '', pageSize: '10' }, header: () => null }, c.res);

    assert.strictEqual(c.out.body[0].searchResults[0].status, 'Withdrawn',
      'a row written by createProject must not read back as the Active default');
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

  // A `sortBy` on either keywordless list path is inert — the repositories hardcode their order,
  // and `buildOrderBy` runs only on the keyword branches. Inert is acceptable; SILENTLY inert is
  // not, and it is the exact case this endpoint's contract singles out ("a sort doing nothing ...
  // all under a 200"). eagle-public reaches it: the table sends `keywords: ''` with its default
  // sort. Asserted through the logger because reporting IS the behaviour under test.
  for (const [dataset, repo] of [['Project', projectsRepo], ['Document', documentsRepo]]) {
    await t.test(`an inert sort on the keywordless ${dataset} list is reported, not swallowed`, async () => {
      t.mock.method(repo, 'listVisible', async () => ({ items: [] }));
      t.mock.method(repo, 'countVisible', async () => 0);
      const warned = [];
      t.mock.method(logger, 'info', (msg) => warned.push(String(msg)));
      t.mock.method(logger, 'warn', (msg) => warned.push(String(msg)));

      const { out, res } = capture();
      await searchController.search(
        { query: { dataset, keywords: '', sortBy: '-name', pageSize: '10' } }, res);

      assert.strictEqual(out.status, 200);
      assert.ok(
        warned.some(m => /ignored sortBy/.test(m) && /-name/.test(m)),
        `${dataset}: an ignored sortBy must be named in the log, got: ${JSON.stringify(warned)}`
      );
    });
  }

  // [C2] The keywordless Document path resolved the Eagle ObjectId to a DEMI project id and then
  // dropped it: a request for ONE project's documents was answered with the whole corpus, under a
  // corpus-wide total. That is the failure `resolveProjectFilter`'s docstring warns about, landing
  // on the branch where the project WAS resolvable.
  await t.test('a project-scoped list is scoped, and so is its total', async () => {
    let listOpts;
    let countOpts;
    t.mock.method(projectsRepo, 'getByEagleId', async (access, eagleId) => {
      assert.strictEqual(eagleId, '588511c4aaecd9001b826192');
      return { id: '207', name: 'Site C' };
    });
    t.mock.method(documentsRepo, 'listVisible', async (access, opts) => {
      listOpts = opts;
      return { items: [] };
    });
    t.mock.method(documentsRepo, 'countVisible', async (access, opts) => {
      countOpts = opts;
      return 4;
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

    assert.deepStrictEqual(listOpts.projectId, ['207'], 'the resolved DEMI id reaches the read');
    assert.deepStrictEqual(countOpts.projectId, ['207'],
      'and the count, or one project reports the size of the corpus');
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

  await t.test('the keywordless document list serves page 2 from row 10, not row 0', async () => {
    t.mock.method(documentsRepo, 'listVisible', listStub('doc'));
    t.mock.method(documentsRepo, 'countVisible', async () => 40);
    t.mock.method(projectsRepo, 'listByIds', async () => ([{ id: '207', name: 'Site C' }]));

    const idsOnPage = async (pageNum) => {
      const { out, res } = capture();
      await searchController.search({
        query: { dataset: 'Document', keywords: '', pageNum: String(pageNum), pageSize: '10' },
        header: () => null
      }, res);
      return out.body[0].searchResults.map(r => r._id);
    };

    const first = await idsOnPage(0);
    const second = await idsOnPage(1);
    assert.deepStrictEqual(first, expectedIds('doc', 0));
    assert.deepStrictEqual(second, expectedIds('doc', 10), 'page 2 starts at row 10');
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

  await t.test('the keywordless document rows carry it too', async () => {
    t.mock.method(documentsRepo, 'listVisible', async () => ({
      items: [{ id: 'doc1', displayName: 'Application', projectId: '207', read: ['public'] }]
    }));
    t.mock.method(documentsRepo, 'countVisible', async () => 1);
    t.mock.method(projectsRepo, 'listByIds', async () => ([
      { id: '207', name: 'Site C', eagleId: '588511c4aaecd9001b826192' }
    ]));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'Document', keywords: '' }, header: () => null }, res);

    const [row] = out.body[0].searchResults;
    assert.strictEqual(row.projectId, '207');
    assert.strictEqual(row.project._id, '588511c4aaecd9001b826192');
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
});
