'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const extract = require('../../src/extract');

const Document = require('../../src/models/document');
const Project = require('../../src/models/project');
const documentController = require('../../src/controllers/document');

test('Document Controller Tests', async (t) => {

  t.afterEach(() => {
    t.mock.restoreAll();
  });

  await t.test('getDocuments returns published documents for unauthenticated public requests', async () => {
    const mockDocs = [
      { displayName: 'Doc 1', project: '12345', isPublished: true }
    ];

    t.mock.method(Document, 'find', async (filter) => {
      // Anonymous callers must be constrained by the read ACL, never handed a bare {}.
      assert.ok(filter && typeof filter === 'object', 'filter must be a Mongo filter object');
      assert.ok(Array.isArray(filter.$or), 'public read must apply an ACL $or clause');
      assert.deepStrictEqual(filter.$or[0], { read: { $in: ['public'] } });
      return mockDocs;
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
      { displayName: 'Doc 1', project: '12345', isPublished: true },
      { displayName: 'Unpublished Doc', project: '12346', isPublished: false }
    ];

    t.mock.method(Document, 'find', async (filter) => {
      // Privileged roles read unfiltered.
      assert.deepStrictEqual(filter, {});
      return mockDocs;
    });

    // Roles come from the verified token via req.user — the controller no longer
    // re-implements auth by sniffing headers.
    const req = {
      query: {},
      user: { realm_access: { roles: ['sysadmin'] } },
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

    await documentController.getDocuments(req, res);

    assert.deepStrictEqual(jsonResponse, mockDocs);
  });

  await t.test('getDocument returns document when published', async () => {
    const docId = '12345';
    const mockDoc = {
      _id: docId,
      displayName: 'Test Doc',
      isPublished: true,
      project: '12345'
    };

    t.mock.method(Document, 'findById', async (id) => {
      assert.strictEqual(id, docId);
      return mockDoc;
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
    const docId = '12345';
    const mockDoc = {
      _id: docId,
      displayName: 'Test Doc',
      isPublished: false,
      project: '12345'
    };

    t.mock.method(Document, 'findById', async () => mockDoc);

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
    assert.strictEqual(jsonResponse.error, 'Access denied. Document is not published.');
  });

  await t.test('createDocument creates a new document record', async () => {
    const mockProject = { _id: '12345', region: 'Thompson-Okanagan' };
    const reqBody = {
      project: '12345',
      displayName: 'Sample Document',
      s3Key: '12345/sample.pdf'
    };

    t.mock.method(Project, 'findById', async (id) => {
      assert.strictEqual(id, reqBody.project);
      return mockProject;
    });

    let upsertedDoc;
    t.mock.method(Document, 'upsert', async (doc) => {
      upsertedDoc = doc;
      return doc;
    });

    const req = { body: reqBody };
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
    assert.strictEqual(upsertedDoc.displayName, reqBody.displayName);
  });

  await t.test('extractDocument uploads to MinIO and queues extraction task', async () => {
    const mockProject = { _id: '12345', region: 'Thompson-Okanagan' };
    const mockFile = {
      path: '/tmp/test_upload.pdf',
      originalname: 'test_upload.pdf'
    };
    const reqBody = {
      project: '12345',
      displayName: 'Uploader Test Doc'
    };

    t.mock.method(Project, 'findById', async (id) => {
      assert.strictEqual(id, reqBody.project);
      return mockProject;
    });

    const mockMinioClient = {
      bucketExists: async () => true,
      fPutObject: async (bucket, path, filepath) => {
        assert.strictEqual(filepath, mockFile.path);
      }
    };
    t.mock.method(extract, 'getMinioClient', () => mockMinioClient);
    t.mock.method(fs.promises, 'unlink', async () => {});

    t.mock.method(Document, 'upsert', async (doc) => doc);

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
