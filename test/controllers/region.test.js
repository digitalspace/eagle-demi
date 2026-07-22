'use strict';

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

// Load models
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

    t.mock.method(Region, 'find', (query) => {
      assert.deepStrictEqual(query, {});
      return {
        lean: async () => mockRegions
      };
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

    t.mock.method(Region.prototype, 'save', async function() {
      assert.strictEqual(this.name, reqBody.name);
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

    await regionController.createRegion(req, res);

    assert.strictEqual(statusCode, 201);
    assert.strictEqual(jsonResponse.name, reqBody.name);
  });

  await t.test('getRegion finds region by ObjectId', async () => {
    const regionId = '64a5f1dc2d0a9c002225f25a';
    const mockRegion = { _id: regionId, name: 'Skeena' };

    t.mock.method(Region, 'findOne', (query) => {
      assert.deepStrictEqual(query, { _id: regionId });
      return {
        lean: async () => mockRegion
      };
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
    t.mock.method(Region, 'findOne', () => {
      return {
        lean: async () => null
      };
    });

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
    const regionId = '64a5f1dc2d0a9c002225f25a';
    const updatePayload = { name: 'Skeena-North' };
    const mockUpdatedRegion = { _id: regionId, name: 'Skeena-North' };

    t.mock.method(Region, 'findOneAndUpdate', async (query, update, options) => {
      assert.deepStrictEqual(query, { _id: regionId });
      assert.deepStrictEqual(update, updatePayload);
      assert.ok(options.new);
      return mockUpdatedRegion;
    });

    const req = { params: { id: regionId }, body: updatePayload };
    let jsonResponse;
    const res = {
      json: (data) => {
        jsonResponse = data;
        return res;
      },
      status: () => res
    };

    await regionController.updateRegion(req, res);

    assert.deepStrictEqual(jsonResponse, mockUpdatedRegion);
  });

  await t.test('deleteRegion removes a region from the directory', async () => {
    const regionId = '64a5f1dc2d0a9c002225f25a';
    const mockDeleted = { _id: regionId, name: 'Skeena' };

    t.mock.method(Region, 'findOneAndDelete', async (query) => {
      assert.deepStrictEqual(query, { _id: regionId });
      return mockDeleted;
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

    await regionController.deleteRegion(req, res);

    assert.strictEqual(jsonResponse.message, 'Region deleted successfully');
    assert.deepStrictEqual(jsonResponse.deleted, mockDeleted);
  });
});
