'use strict';

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

// Load models
const Boundary = require('../../src/models/boundary');
const boundaryController = require('../../src/controllers/boundary');

test('Boundary Controller Tests', async (t) => {

  t.afterEach(() => {
    t.mock.restoreAll();
  });

  await t.test('getBoundaries returns list of boundaries, projecting out geometry by default', async () => {
    const mockBoundaries = [
      { type: 'Regional District', name: 'Metro Vancouver' },
      { type: 'Municipality', name: 'Vancouver' }
    ];

    t.mock.method(Boundary, 'find', async (query, projection) => {
      assert.deepStrictEqual(query, {});
      assert.deepStrictEqual(projection, { geometry: 0 });
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

    assert.deepStrictEqual(jsonResponse, mockBoundaries);
  });

  await t.test('getBoundaries includes geometry when geometry=true parameter is present', async () => {
    const mockBoundaries = [
      { type: 'Regional District', name: 'Metro Vancouver', geometry: { type: 'Polygon', coordinates: [] } }
    ];

    t.mock.method(Boundary, 'find', async (query, projection) => {
      assert.deepStrictEqual(query, { type: 'Regional District' });
      assert.deepStrictEqual(projection, {});
      return mockBoundaries;
    });

    const req = { query: { type: 'Regional District', geometry: 'true' } };
    let jsonResponse;
    const res = {
      json: (data) => {
        jsonResponse = data;
        return res;
      },
      status: () => res
    };

    await boundaryController.getBoundaries(req, res);

    assert.deepStrictEqual(jsonResponse, mockBoundaries);
  });

  await t.test('createBoundary successfully stores a new boundary', async () => {
    const reqBody = {
      type: 'Municipality',
      name: 'Victoria',
      code: 'VIC',
      geometry: { type: 'Polygon', coordinates: [[[-123.36, 48.42], [-123.35, 48.42], [-123.35, 48.41], [-123.36, 48.42]]] }
    };

    t.mock.method(Boundary.prototype, 'save', async function() {
      assert.strictEqual(this.name, reqBody.name);
      assert.strictEqual(this.type, reqBody.type);
      return this;
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

  await t.test('getBoundary finds boundary by ObjectId', async () => {
    const boundaryId = '64a5f1dc2d0a9c002225f25a';
    const mockBoundary = { _id: boundaryId, name: 'Metro Vancouver' };

    t.mock.method(Boundary, 'findOne', async (query) => {
      assert.deepStrictEqual(query, { _id: boundaryId });
      return mockBoundary;
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

  await t.test('getBoundary finds boundary by name when not an ObjectId', async () => {
    const boundaryName = 'Metro Vancouver';
    const mockBoundary = { name: boundaryName };

    t.mock.method(Boundary, 'findOne', async (query) => {
      assert.deepStrictEqual(query, { name: boundaryName });
      return mockBoundary;
    });

    const req = { params: { id: boundaryName } };
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
    t.mock.method(Boundary, 'findOne', async () => {
      return null;
    });

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
    const boundaryId = '64a5f1dc2d0a9c002225f25a';
    const updatePayload = { name: 'Metro Vancouver North' };
    const mockUpdated = { _id: boundaryId, name: 'Metro Vancouver North' };

    t.mock.method(Boundary, 'findOneAndUpdate', async (query, update, options) => {
      assert.deepStrictEqual(query, { _id: boundaryId });
      assert.deepStrictEqual(update, updatePayload);
      assert.ok(options.new);
      return mockUpdated;
    });

    const req = { params: { id: boundaryId }, body: updatePayload };
    let jsonResponse;
    const res = {
      json: (data) => {
        jsonResponse = data;
        return res;
      },
      status: () => res
    };

    await boundaryController.updateBoundary(req, res);

    assert.deepStrictEqual(jsonResponse, mockUpdated);
  });

  await t.test('deleteBoundary removes a boundary record', async () => {
    const boundaryId = '64a5f1dc2d0a9c002225f25a';
    const mockDeleted = { _id: boundaryId, name: 'Metro Vancouver' };

    t.mock.method(Boundary, 'findOneAndDelete', async (query) => {
      assert.deepStrictEqual(query, { _id: boundaryId });
      return mockDeleted;
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

    await boundaryController.deleteBoundary(req, res);

    assert.strictEqual(jsonResponse.message, 'Boundary deleted successfully');
    assert.deepStrictEqual(jsonResponse.deleted, mockDeleted);
  });
});
