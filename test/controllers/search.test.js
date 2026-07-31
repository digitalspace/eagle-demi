'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const Project = require('../../src/models/project');
const Document = require('../../src/models/document');
const searchController = require('../../src/controllers/search');
const chunksRepo = require('../../src/repositories/chunks');
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

  await t.test('search projects queries Typesense when keywords are provided', async () => {
    const mockTypesenseResponse = {
      hits: [
        {
          document: {
            id: '12345',
            name: 'Ajax Mine',
            displayName: 'Ajax Mine',
            sector: 'Mining',
            status: 'Completed',
            region: 'Thompson-Okanagan',
            description: 'Proposed open-pit copper mine.',
            proponent: 'KGHM Ajax',
            centroid: [50.62, -120.37], // [lat, lng] inside Typesense
            allowed_roles: ['public']
          }
        }
      ]
    };

    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      assert.ok(url.includes('collections/projects/documents/search'));
      assert.ok(url.includes('q=Ajax'));
      return {
        ok: true,
        status: 200,
        json: async () => mockTypesenseResponse
      };
    };

    const req = {
      query: { dataset: 'Project', keywords: 'Ajax', pageSize: '5' },
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

    try {
      await searchController.search(req, res);
      assert.ok(Array.isArray(jsonResponse));
      assert.strictEqual(jsonResponse[0].searchResults.length, 1);
      assert.strictEqual(jsonResponse[0].searchResults[0].name, 'Ajax Mine');
      assert.strictEqual(jsonResponse[0].searchResults[0].isPublished, true);
      assert.deepStrictEqual(jsonResponse[0].searchResults[0].centroid, [-120.37, 50.62]);
    } finally {
      global.fetch = originalFetch;
    }
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
  await t.test('DocumentChunk search answers empty without touching a backend', async () => {
    let touched = false;
    for (const repo of [documentsRepo, projectsRepo]) {
      t.mock.method(repo, 'listByIds', async () => { touched = true; return []; });
    }
    t.mock.method(chunksRepo, 'listVisible', async () => { touched = true; return { items: [] }; });

    const req = {
      query: { dataset: 'DocumentChunk', keywords: 'river', pageSize: '50', fuzzy: 'true' },
      header: () => null
    };
    let jsonResponse;
    let statusCode = 200;
    const res = {
      json: (data) => { jsonResponse = data; return res; },
      status: (code) => { statusCode = code; return res; }
    };

    await searchController.search(req, res);

    assert.strictEqual(statusCode, 200, '200, not 5xx — the frontend retries 5xx twice at 1s');
    assert.deepStrictEqual(jsonResponse, [{ searchResults: [] }]);
    assert.strictEqual(touched, false, 'the branch must issue no query at all');
  });

  await t.test('DocumentChunk search with no keywords never queries', async () => {
    let called = false;
    t.mock.method(chunksRepo, 'listVisible', async () => { called = true; return { items: [] }; });

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
