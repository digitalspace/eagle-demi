'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

// Load models so controllers can reference them
const Project = require('../../src/models/project');
const Document = require('../../src/models/document');
const searchController = require('../../src/controllers/search');

test('Search Controller Tests', async (t) => {

  t.afterEach(() => {
    t.mock.restoreAll();
  });

  await t.test('search projects returns projects from MongoDB when no keywords are provided', async () => {
    const mockProjects = [
      {
        _id: new mongoose.Types.ObjectId('64a5f1dc2d0a9c002225f25e'),
        name: 'Ajax Mine',
        region: 'Thompson-Okanagan',
        sector: 'Mining',
        status: 'Completed',
        centroid: { type: 'Point', coordinates: [-120.37, 50.62] },
        metadata: {}
      }
    ];

    t.mock.method(Project, 'find', () => {
      return {
        limit: async (limitVal) => {
          assert.strictEqual(limitVal, 10);
          return mockProjects;
        }
      };
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

  await t.test('search projects gates by read array for public/unauthenticated requests', async () => {
    let capturedQuery = null;
    t.mock.method(Project, 'find', (query) => {
      capturedQuery = query;
      return {
        limit: async () => []
      };
    });

    const req = {
      query: { dataset: 'Project', keywords: '', pageSize: '10' },
      header: () => null
    };

    const res = {
      json: () => res,
      status: () => res
    };

    await searchController.search(req, res);

    assert.deepStrictEqual(capturedQuery, { $or: [{ isPublished: true }, { read: { $in: ['public'] } }] });
  });

  await t.test('search projects queries Typesense when keywords are provided', async () => {
    const mockTypesenseResponse = {
      hits: [
        {
          document: {
            id: '64a5f1dc2d0a9c002225f25e',
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

    // Mock global fetch
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
      // Verify coordinates were swapped back to [lng, lat]
      assert.deepStrictEqual(jsonResponse[0].searchResults[0].centroid, [-120.37, 50.62]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await t.test('search documents returns documents from MongoDB when no keywords are provided', async () => {
    const mockDocuments = [
      {
        _id: new mongoose.Types.ObjectId('64a5f1dc2d0a9c002225f25a'),
        displayName: 'Test Doc',
        s3Key: 'uploads/test_doc.pdf',
        region: 'Skeena',
        orcsClassification: '34800-20/MOCK',
        project: new mongoose.Types.ObjectId('64a5f1dc2d0a9c002225f25e'),
        isPublished: true
      }
    ];

    t.mock.method(Document, 'find', () => {
      return {
        limit: (limitVal) => {
          assert.strictEqual(limitVal, 10);
          return {
            sort: async (sortObj) => {
              assert.deepStrictEqual(sortObj, { createdAt: -1 });
              return mockDocuments;
            }
          };
        }
      };
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

  await t.test('search documents queries Typesense grouped documents and metadata when keywords are provided', async () => {
    const mockDocsResponse = {
      hits: [
        {
          document: {
            id: 'doc-metadata-only',
            displayName: 'Metadata Match Report',
            documentFileName: 'metadata_match.pdf',
            type: 'PDF Document',
            projectId: '64a5f1dc2d0a9c002225f25e',
            projectName: 'Ajax Mine',
            allowed_roles: ['public'],
            description: 'Direct title match document.'
          }
        },
        {
          document: {
            id: 'doc-123',
            displayName: 'Mine Assessment.pdf',
            documentFileName: 'Mine Assessment.pdf',
            type: 'PDF Document',
            projectId: '64a5f1dc2d0a9c002225f25e',
            projectName: 'Ajax Mine',
            allowed_roles: ['public'],
            description: 'This is a generic description.'
          }
        }
      ]
    };

    const mockChunksResponse = {
      grouped_hits: [
        {
          group_key: ['doc-123'],
          hits: [
            {
              document: {
                documentName: 'Mine Assessment.pdf',
                documentType: 'PDF Document',
                projectId: '64a5f1dc2d0a9c002225f25e',
                projectName: 'Ajax Mine',
                allowed_roles: ['public'],
                content: 'Extract content of the mine.'
              },
              highlights: [
                {
                  field: 'content',
                  snippet: 'Extract <mark>content</mark> of the mine.'
                }
              ]
            }
          ]
        }
      ]
    };

    // Mock global fetch to handle batched multi_search query
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      if (url.includes('multi_search')) {
        assert.strictEqual(options.method, 'POST');
        const body = JSON.parse(options.body);
        assert.strictEqual(body.searches.length, 2);
        assert.strictEqual(body.searches[0].collection, 'documents');
        assert.strictEqual(body.searches[1].collection, 'document_chunks');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              mockDocsResponse,
              mockChunksResponse
            ]
          })
        };
      }
      return { ok: false, status: 404 };
    };

    const req = {
      query: { dataset: 'Document', keywords: 'content' },
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
      const results = jsonResponse[0].searchResults;
      
      // Should find 2 unique merged documents
      assert.strictEqual(results.length, 2);
      
      // 'doc-123' matched both metadata and content, so its description is updated with the deep-text snippet and ranked first
      assert.strictEqual(results[0]._id, 'doc-123');
      assert.strictEqual(results[0].description, 'Extract <mark>content</mark> of the mine.');
      assert.strictEqual(results[0].isPublished, true);

      // 'doc-metadata-only' matched only metadata, so it ranks second and preserves its generic description
      assert.strictEqual(results[1]._id, 'doc-metadata-only');
      assert.strictEqual(results[1].description, 'Direct title match document.');
    } finally {
      global.fetch = originalFetch;
    }
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

  await t.test('search projects regex fallback escapes special regex characters', async () => {
    let capturedQuery = null;
    t.mock.method(Project, 'find', (query) => {
      capturedQuery = query;
      return {
        limit: async () => []
      };
    });

    // Mock global fetch to force Typesense query to fail and use fallback
    const originalFetch = global.fetch;
    global.fetch = async () => {
      return { ok: false, status: 500 };
    };

    const req = {
      query: { dataset: 'Project', keywords: 'Ajax.*Mine+', pageSize: '10' },
      header: () => null
    };

    const res = {
      json: () => res,
      status: () => res
    };

    try {
      await searchController.search(req, res);
      assert.ok(capturedQuery);
      // Ensure the captured query has escaped regex
      const escapedPattern = 'Ajax\\.\\*Mine\\+';
      const nameRegex = capturedQuery.$or[0].name;
      assert.strictEqual(nameRegex.source, escapedPattern);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
