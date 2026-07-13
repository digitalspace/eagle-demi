'use strict';

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const fs = require('fs');
const extract = require('../../src/extract');

// Load models
const Document = require('../../src/models/document');
const Project = require('../../src/models/project');
const Region = require('../../src/models/region');
const documentController = require('../../src/controllers/document');

test('Document Controller Tests', async (t) => {

  t.afterEach(() => {
    t.mock.restoreAll();
  });

  await t.test('getDocuments returns published documents for unauthenticated public requests', async () => {
    const mockPublishedProjects = [
      { _id: new mongoose.Types.ObjectId('64a5f1dc2d0a9c002225f25e'), isPublished: true }
    ];

    const mockDocs = [
      { displayName: 'Doc 1', project: '64a5f1dc2d0a9c002225f25e', isPublished: true }
    ];

    // Mock Project.find
    t.mock.method(Project, 'find', () => {
      return {
        select: async (fields) => {
          assert.strictEqual(fields, '_id');
          return mockPublishedProjects;
        }
      };
    });

    // Mock Document.find
    t.mock.method(Document, 'find', (query) => {
      assert.strictEqual(query.isPublished, true);
      assert.deepStrictEqual(query.project.$in, [mockPublishedProjects[0]._id]);
      return {
        populate: async (field) => {
          assert.strictEqual(field, 'project');
          return mockDocs;
        }
      };
    });

    const req = { query: {}, header: () => null };
    let jsonResponse;
    const res = {
      json: (data) => {
        jsonResponse = data;
        return res;
      },
      status: () => res
    };

    await documentController.getDocuments(req, res);

    assert.deepStrictEqual(jsonResponse, mockDocs);
  });

  await t.test('getDocuments returns all documents for authenticated admin requests', async () => {
    const mockDocs = [
      { displayName: 'Doc 1', project: '64a5f1dc2d0a9c002225f25e', isPublished: true },
      { displayName: 'Unpublished Doc', project: '64a5f1dc2d0a9c002225f25f', isPublished: false }
    ];

    // Mock Document.find
    t.mock.method(Document, 'find', (query) => {
      // Query should be empty (no public-filtering)
      assert.deepStrictEqual(query, {});
      return {
        populate: async (field) => {
          assert.strictEqual(field, 'project');
          return mockDocs;
        }
      };
    });

    const req = {
      query: {},
      header: (name) => name === 'X-Api-Key' ? 'eagle-demi-api-key' : null
    };

    let jsonResponse;
    const res = {
      json: (data) => {
        jsonResponse = data;
        return res;
      },
      status: () => res
    };

    await documentController.getDocuments(req, res);

    assert.deepStrictEqual(jsonResponse, mockDocs);
  });

  await t.test('getDocument returns document when published', async () => {
    const docId = '64a5f1dc2d0a9c002225f25a';
    const mockDoc = {
      _id: docId,
      displayName: 'Test Doc',
      isPublished: true,
      project: { _id: '64a5f1dc2d0a9c002225f25e', isPublished: true }
    };

    t.mock.method(Document, 'findById', (id) => {
      assert.strictEqual(id, docId);
      return {
        populate: async (field) => {
          assert.strictEqual(field, 'project');
          return mockDoc;
        }
      };
    });

    const req = { params: { id: docId }, header: () => null };
    let jsonResponse;
    const res = {
      json: (data) => {
        jsonResponse = data;
        return res;
      },
      status: () => res
    };

    await documentController.getDocument(req, res);

    assert.deepStrictEqual(jsonResponse, mockDoc);
  });

  await t.test('getDocument returns 403 for public requests if document is not published', async () => {
    const docId = '64a5f1dc2d0a9c002225f25a';
    const mockDoc = {
      _id: docId,
      displayName: 'Test Doc',
      isPublished: false,
      project: { _id: '64a5f1dc2d0a9c002225f25e', isPublished: true }
    };

    t.mock.method(Document, 'findById', (id) => {
      return {
        populate: async () => mockDoc
      };
    });

    const req = { params: { id: docId }, header: () => null };
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

    await documentController.getDocument(req, res);

    assert.strictEqual(statusCode, 403);
    assert.strictEqual(jsonResponse.error, 'Access denied. This document or its project is not published.');
  });

  await t.test('createDocument creates a new document record', async () => {
    const mockProject = { _id: '64a5f1dc2d0a9c002225f25e', region: 'Thompson-Okanagan' };
    const reqBody = {
      project: '64a5f1dc2d0a9c002225f25e',
      displayName: 'Sample Document',
      s3Key: '64a5f1dc2d0a9c002225f25e/sample.pdf'
    };

    t.mock.method(Project, 'findById', async (id) => {
      assert.strictEqual(id, reqBody.project);
      return mockProject;
    });

    t.mock.method(Document.prototype, 'save', async function() {
      assert.strictEqual(this.displayName, reqBody.displayName);
      assert.strictEqual(this.s3Key, reqBody.s3Key);
      assert.strictEqual(this.region, mockProject.region);
      return this;
    });

    const req = { reqBody, body: reqBody };
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

    await documentController.createDocument(req, res);

    assert.strictEqual(statusCode, 201);
    assert.strictEqual(jsonResponse.displayName, reqBody.displayName);
  });

  await t.test('extractDocument uploads to MinIO and queues extraction task', async () => {
    const mockProject = { _id: '64a5f1dc2d0a9c002225f25e', region: 'Thompson-Okanagan' };
    const mockFile = {
      path: '/tmp/test_upload.pdf',
      originalname: 'test_upload.pdf'
    };
    const reqBody = {
      project: '64a5f1dc2d0a9c002225f25e',
      displayName: 'Uploader Test Doc'
    };

    t.mock.method(Project, 'findById', async (id) => {
      assert.strictEqual(id, reqBody.project);
      return mockProject;
    });

    t.mock.method(global, 'setImmediate', () => {});

    const mockMinioClient = {
      bucketExists: async () => true,
      fPutObject: async (bucket, path, filepath) => {
        assert.strictEqual(filepath, mockFile.path);
      }
    };
    t.mock.method(extract, 'getMinioClient', () => mockMinioClient);
    t.mock.method(fs.promises, 'unlink', async () => {});

    t.mock.method(Document.prototype, 'save', async function() {
      assert.strictEqual(this.displayName, reqBody.displayName);
      return this;
    });

    const req = { file: mockFile, body: reqBody };

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

    await documentController.extractDocument(req, res);

    assert.strictEqual(statusCode, 202);
    assert.strictEqual(jsonResponse.message, 'File stored and extraction queued.');
  });
});
