'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const storage = require('../../src/storage');

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

  await t.test('extractDocument stores the file and queues extraction', async () => {
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

    // Mocked at the storage seam, not at a MinIO client: the controller no longer knows
    // which backend is active, which is the point of src/storage/.
    let storedKey, storedPath;
    t.mock.method(storage, 'putFile', async (key, filePath) => {
      storedKey = key; storedPath = filePath;
      return key;
    });
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
    assert.strictEqual(jsonResponse.message, 'File stored. Text extraction runs on the next scheduled extraction pass.');
    assert.strictEqual(storedPath, mockFile.path);
    assert.ok(storedKey.startsWith('12345/'), 'stored under the project id');
  });

  await t.test('extractDocument sets a fail-closed read ACL and cannot out-rank its project', async (t2) => {
    const mockFile = { path: '/tmp/test_upload.pdf', originalname: 'test_upload.pdf' };

    t2.mock.method(storage, 'putFile', async (key) => key);
    t2.mock.method(fs.promises, 'unlink', async () => {});

    let upserted;
    t2.mock.method(Document, 'upsert', async (doc) => { upserted = doc; return doc; });

    const run = async (parentProject, isPublished) => {
      t2.mock.method(Project, 'findById', async () => parentProject);
      const res = { status: () => res, json: () => res };
      await documentController.extractDocument(
        { file: { ...mockFile }, body: { project: '12345', isPublished } },
        res
      );
      return upserted;
    };

    // Private project + requested public -> must NOT become public.
    let doc = await run({ _id: '12345', read: ['sysadmin'], isPublished: false }, 'true');
    assert.strictEqual(doc.isPublished, false, 'must not out-rank a private parent project');
    assert.ok(!doc.read.includes('public'), 'read[] must not contain public');

    // Public project + requested public -> public.
    doc = await run({ _id: '12345', read: ['public', 'sysadmin'], isPublished: true }, 'true');
    assert.strictEqual(doc.isPublished, true);
    assert.ok(doc.read.includes('public'));

    // Public project, publish not requested -> stays closed.
    doc = await run({ _id: '12345', read: ['public', 'sysadmin'], isPublished: true }, undefined);
    assert.strictEqual(doc.isPublished, false, 'defaults closed');
    assert.ok(!doc.read.includes('public'));
  });
});
