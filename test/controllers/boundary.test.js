'use strict';

const test = require('node:test');
const assert = require('node:assert');

const Boundary = require('../../src/models/boundary');
const boundaryController = require('../../src/controllers/boundary');

test('Boundary Controller Tests', async (t) => {

  t.afterEach(() => {
    t.mock.restoreAll();
  });

  await t.test('getBoundaries returns list of boundaries', async () => {
    const mockBoundaries = [
      { type: 'Regional District', name: 'Metro Vancouver' },
      { type: 'Municipality', name: 'Vancouver' }
    ];

    t.mock.method(Boundary, 'find', async () => {
      return mockBoundaries;
    });

    const req = { query: {} };
    let jsonResponse;
    const res = {
      json: (data) => {
        jsonResponse = data;
        return res;
      },
      status: () => res
    };

    await boundaryController.getBoundaries(req, res);

    assert.ok(Array.isArray(jsonResponse));
  });

  await t.test('createBoundary successfully stores a new boundary', async () => {
    const reqBody = {
      type: 'Municipality',
      name: 'Victoria',
      code: 'VIC',
      geometry: { type: 'Polygon', coordinates: [[[-123.36, 48.42], [-123.35, 48.42], [-123.35, 48.41], [-123.36, 48.42]]] }
    };

    let upsertedDoc;
    t.mock.method(Boundary, 'upsert', async (doc) => {
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

    await boundaryController.createBoundary(req, res);

    assert.strictEqual(statusCode, 201);
    assert.strictEqual(jsonResponse.name, reqBody.name);
  });

  await t.test('createBoundary returns 400 when missing required fields', async () => {
    const req = { body: { name: 'Victoria' } };
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

    await boundaryController.createBoundary(req, res);

    assert.strictEqual(statusCode, 400);
    assert.ok(jsonResponse.error.includes('Missing required fields'));
  });

  await t.test('getBoundary finds boundary by ID', async () => {
    const boundaryId = 'Municipality_Victoria';
    const mockBoundary = { _id: boundaryId, name: 'Victoria' };

    t.mock.method(Boundary, 'findById', async (id) => {
      if (id === boundaryId) return mockBoundary;
      return null;
    });

    const req = { params: { id: boundaryId } };
    let jsonResponse;
    const res = {
      json: (data) => {
        jsonResponse = data;
        return res;
      },
      status: () => res
    };

    await boundaryController.getBoundary(req, res);

    assert.deepStrictEqual(jsonResponse, mockBoundary);
  });

  await t.test('getBoundary returns 404 if boundary does not exist', async () => {
    t.mock.method(Boundary, 'findById', async () => null);
    t.mock.method(Boundary, 'findOne', async () => null);

    const req = { params: { id: 'Nonexistent' } };
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

    await boundaryController.getBoundary(req, res);

    assert.strictEqual(statusCode, 404);
    assert.strictEqual(jsonResponse.error, 'Boundary not found');
  });

  await t.test('updateBoundary modifies existing boundary record', async () => {
    const boundaryId = 'Municipality_Victoria';
    const mockBoundary = { _id: boundaryId, name: 'Victoria' };

    t.mock.method(Boundary, 'findById', async () => mockBoundary);
    t.mock.method(Boundary, 'upsert', async (doc) => doc);

    const req = { params: { id: boundaryId }, body: { name: 'Victoria North' } };
    let jsonResponse;
    const res = {
      json: (data) => {
        jsonResponse = data;
        return res;
      },
      status: () => res
    };

    await boundaryController.updateBoundary(req, res);

    assert.strictEqual(jsonResponse.name, 'Victoria North');
  });

  await t.test('deleteBoundary removes a boundary record', async () => {
    const boundaryId = 'Municipality_Victoria';
    const mockBoundary = { _id: boundaryId, name: 'Victoria' };

    t.mock.method(Boundary, 'findById', async () => mockBoundary);
    t.mock.method(Boundary, 'deleteById', async () => true);

    const req = { params: { id: boundaryId } };
    let jsonResponse;
    const res = {
      json: (data) => {
        jsonResponse = data;
        return res;
      },
      status: () => res
    };

    await boundaryController.deleteBoundary(req, res);

    assert.strictEqual(jsonResponse.message, 'Boundary deleted successfully');
  });
});
