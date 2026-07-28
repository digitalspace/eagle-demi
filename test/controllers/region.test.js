'use strict';

const test = require('node:test');
const assert = require('node:assert');

const Region = require('../../src/models/region');
const regionController = require('../../src/controllers/region');

test('Region Controller Tests', async (t) => {

  t.afterEach(() => {
    t.mock.restoreAll();
  });

  await t.test('getRegions returns list of all spatial region boundary documents', async () => {
    const mockRegions = [
      { name: 'Skeena', geometry: { type: 'Polygon', coordinates: [] } },
      { name: 'Kootenay', geometry: { type: 'Polygon', coordinates: [] } }
    ];

    t.mock.method(Region, 'find', async () => {
      return mockRegions;
    });

    const req = {};
    let jsonResponse;
    const res = {
      json: (data) => {
        jsonResponse = data;
        return res;
      },
      status: () => res
    };

    await regionController.getRegions(req, res);

    assert.deepStrictEqual(jsonResponse, mockRegions);
  });

  await t.test('createRegion successfully stores a new region', async () => {
    const reqBody = {
      name: 'Okanagan',
      geometry: { type: 'Polygon', coordinates: [[[-120, 50], [-119, 50], [-119, 49], [-120, 50]]] }
    };

    let upsertedDoc;
    t.mock.method(Region, 'upsert', async (doc) => {
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

    await regionController.createRegion(req, res);

    assert.strictEqual(statusCode, 201);
    assert.strictEqual(jsonResponse.name, reqBody.name);
  });

  await t.test('getRegion finds region by ID', async () => {
    const regionId = 'Skeena';
    const mockRegion = { _id: regionId, name: 'Skeena' };

    t.mock.method(Region, 'findById', async (id) => {
      if (id === regionId) return mockRegion;
      return null;
    });

    const req = { params: { id: regionId } };
    let jsonResponse;
    const res = {
      json: (data) => {
        jsonResponse = data;
        return res;
      },
      status: () => res
    };

    await regionController.getRegion(req, res);

    assert.deepStrictEqual(jsonResponse, mockRegion);
  });

  await t.test('getRegion returns 404 if region does not exist', async () => {
    t.mock.method(Region, 'findById', async () => null);
    t.mock.method(Region, 'findOne', async () => null);

    const req = { params: { id: 'NonexistentRegion' } };
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

    await regionController.getRegion(req, res);

    assert.strictEqual(statusCode, 404);
    assert.strictEqual(jsonResponse.error, 'Region not found');
  });

  await t.test('updateRegion modifies existing region record', async () => {
    const regionId = 'Skeena';
    const mockRegion = { _id: regionId, name: 'Skeena' };

    t.mock.method(Region, 'findById', async () => mockRegion);
    t.mock.method(Region, 'upsert', async (doc) => doc);

    const req = { params: { id: regionId }, body: { name: 'Skeena-North' } };
    let jsonResponse;
    const res = {
      json: (data) => {
        jsonResponse = data;
        return res;
      },
      status: () => res
    };

    await regionController.updateRegion(req, res);

    assert.strictEqual(jsonResponse.name, 'Skeena-North');
  });

  await t.test('deleteRegion removes a region from the directory', async () => {
    const regionId = 'Skeena';
    const mockRegion = { _id: regionId, name: 'Skeena' };

    t.mock.method(Region, 'findById', async () => mockRegion);
    t.mock.method(Region, 'deleteById', async () => true);

    const req = { params: { id: regionId } };
    let jsonResponse;
    const res = {
      json: (data) => {
        jsonResponse = data;
        return res;
      },
      status: () => res
    };

    await regionController.deleteRegion(req, res);

    assert.strictEqual(jsonResponse.message, 'Region deleted successfully');
  });
});
