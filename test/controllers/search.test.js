'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const Project = require('../../src/models/project');
const Document = require('../../src/models/document');
const searchController = require('../../src/controllers/search');
const aiSearch = require('../../src/search/ai-search');
const documentsRepo = require('../../src/repositories/documents');
const projectsRepo = require('../../src/repositories/projects');

test('Search Controller Tests', async (t) => {

  t.afterEach(() => {
    t.mock.restoreAll();
  });

  await t.test('search projects returns projects from Cosmos DB when no keywords are provided', async () => {
    const mockProjects = [
      {
        _id: '12345',
        name: 'Ajax Mine',
        region: 'Thompson-Okanagan',
        sector: 'Mining',
        status: 'Completed',
        centroid: { type: 'Point', coordinates: [-120.37, 50.62] },
        isPublished: true
      }
    ];

    t.mock.method(Project, 'find', async (filter, options) => {
      // Anonymous: ACL clause AND the track-provenance clause, combined with $and so
      // neither can cancel the other out.
      assert.ok(Array.isArray(filter.$and), 'expected combined $and filter');
      assert.ok(filter.$and.some(c => Array.isArray(c.$or)), 'expected read ACL clause');
      assert.ok(
        filter.$and.some(c => c['sources.track']),
        'expected track provenance clause'
      );
      assert.strictEqual(options.maxItemCount, 10);
      return mockProjects;
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
      t.mock.method(Project, 'find', async () => { listed = true; return []; });

      const req = { query: { dataset: 'Project', keywords: 'zarquonflux' }, header: () => null };
      let jsonResponse;
      const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };

      await searchController.search(req, res);

      assert.deepStrictEqual(jsonResponse, [{ searchResults: [] }]);
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
        _id: 'doc1',
        displayName: 'Test Doc',
        s3Key: 'uploads/test_doc.pdf',
        region: 'Skeena',
        project: '12345',
        isPublished: true
      }
    ];

    t.mock.method(Document, 'find', async (filter) => {
      assert.ok(Array.isArray(filter.$or), 'public document read must apply an ACL clause');
      assert.deepStrictEqual(filter.$or[0], { read: { $in: ['public'] } });
      return mockDocuments;
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
      assert.deepStrictEqual(hit.read, ['public']);
      // content is not retrievable from the index, so the API never ships chunk text.
      assert.strictEqual(hit.content, '');
      assert.ok(hit.snippet.includes('<mark>river</mark>'));
      assert.ok(!hit.snippet.includes('<script>'), 'document text must not reach the DOM as markup');
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

    assert.deepStrictEqual(jsonResponse, [{ searchResults: [] }]);
    assert.strictEqual(called, false, 'no filter can express "nothing", so issue no request');
  });

  // An empty result caused by a fault is not the same fact as "nothing matched", but it must not
  // become a 5xx either: the frontend retries those twice at 1s and lands on empty regardless.
  await t.test('a search backend failure degrades to empty rather than a 500', async () => {
    t.mock.method(aiSearch, 'searchChunks', async () => { throw new Error('HTTP 403 forbidden'); });

    const req = { query: { dataset: 'DocumentChunk', keywords: 'river' }, header: () => null };
    let jsonResponse;
    let statusCode = 200;
    const res = {
      json: (data) => { jsonResponse = data; return res; },
      status: (code) => { statusCode = code; return res; }
    };

    await searchController.search(req, res);

    assert.strictEqual(statusCode, 200);
    assert.deepStrictEqual(jsonResponse, [{ searchResults: [] }]);
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
