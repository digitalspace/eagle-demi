'use strict';

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
      // Verify coordinates were swapped back to [lng, lat]
      assert.deepStrictEqual(jsonResponse[0].searchResults[0].centroid, [-120.37, 50.62]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await t.test('search documents returns empty array when no keywords are provided', async () => {
    const req = {
      query: { dataset: 'Document', keywords: '' },
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

    assert.deepStrictEqual(jsonResponse, [{ searchResults: [] }]);
  });

  await t.test('search documents queries Typesense grouped documents when keywords are provided', async () => {
    const mockTypesenseResponse = {
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

    // Mock global fetch
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      assert.ok(url.includes('collections/document_chunks/documents/search'));
      assert.ok(url.includes('group_by=documentId'));
      return {
        ok: true,
        status: 200,
        json: async () => mockTypesenseResponse
      };
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
      assert.strictEqual(jsonResponse[0].searchResults.length, 1);
      assert.strictEqual(jsonResponse[0].searchResults[0]._id, 'doc-123');
      assert.strictEqual(jsonResponse[0].searchResults[0].description, 'Extract <mark>content</mark> of the mine.');
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
});
