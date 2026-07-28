'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const Project = require('../../src/models/project');
const Region = require('../../src/models/region');
const Boundary = require('../../src/models/boundary');
const projectController = require('../../src/controllers/project');

test('Spatial Controller Tests', async (t) => {

  t.afterEach(() => {
    t.mock.restoreAll();
  });

  await t.test('getProjects returns all projects when filters are absent', async () => {
    const mockProjects = [
      { name: 'Project North', centroid: { type: 'Point', coordinates: [-125.0, 55.0] } },
      { name: 'Project South', centroid: { type: 'Point', coordinates: [-123.0, 49.0] } }
    ];

    t.mock.method(Project, 'find', async (whereClause) => {
      assert.strictEqual(whereClause, '');
      return mockProjects;
    });

    const req = { query: {}, header: (name) => name === 'X-Api-Key' ? 'eagle-demi-api-key' : null };
    let jsonResponse;
    const res = {
      json: (data) => {
        jsonResponse = data;
        return res;
      },
      status: () => res
    };

    await projectController.getProjects(req, res);

    assert.deepStrictEqual(jsonResponse, mockProjects);
  });

  await t.test('getProjects filters projects by administrative boundaries', async () => {
    const rdName = 'Metro Vancouver';
    const muniName = 'Vancouver';
    const edName = 'Vancouver-Point Grey';

    const mockFilteredProjects = [
      { name: 'Metro Project', centroid: { type: 'Point', coordinates: [-123.0, 49.5] } }
    ];

    t.mock.method(Project, 'find', async (whereClause, parameters) => {
      assert.ok(whereClause.includes('regionalDistrict = @rd'));
      assert.ok(whereClause.includes('municipality = @muni'));
      assert.ok(whereClause.includes('electoralDistrict = @ed'));
      assert.strictEqual(parameters.length, 3);
      return mockFilteredProjects;
    });

    const req = {
      query: {
        regionalDistrict: rdName,
        municipality: muniName,
        electoralDistrict: edName
      },
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

    await projectController.getProjects(req, res);

    assert.deepStrictEqual(jsonResponse, mockFilteredProjects);
  });

  await t.test('createProject creates project successfully', async () => {
    let upsertedDoc;
    t.mock.method(Project, 'upsert', async (doc) => {
      upsertedDoc = doc;
      return doc;
    });

    const req = {
      body: {
        trackProjectId: 12345,
        name: 'Test Project',
        centroid: { type: 'Point', coordinates: [-123.12, 49.28] }
      }
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

    await projectController.createProject(req, res);

    assert.strictEqual(statusCode, 201);
    assert.strictEqual(upsertedDoc.name, 'Test Project');
    assert.strictEqual(upsertedDoc.trackProjectId, 12345);
    assert.deepStrictEqual(jsonResponse, upsertedDoc);
  });

  await t.test('updateProject updates project successfully', async () => {
    const existingProject = { _id: '12345', trackProjectId: 12345, name: 'Old Name' };

    t.mock.method(Project, 'findById', async (id) => {
      if (id === '12345') return existingProject;
      return null;
    });

    let updatedDoc;
    t.mock.method(Project, 'upsert', async (doc) => {
      updatedDoc = doc;
      return doc;
    });

    const req = {
      params: { id: '12345' },
      body: {
        name: 'Updated Name'
      }
    };

    let jsonResponse;
    const res = {
      json: (data) => {
        jsonResponse = data;
        return res;
      },
      status: () => res
    };

    await projectController.updateProject(req, res);

    assert.strictEqual(updatedDoc.name, 'Updated Name');
    assert.strictEqual(jsonResponse.name, 'Updated Name');
  });

  await t.test('getProjects returns 500 when database find fails', async () => {
    const errorMsg = 'Database connection lost';
    t.mock.method(Project, 'find', async () => {
      throw new Error(errorMsg);
    });

    const req = { query: {}, header: () => null };
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

    await projectController.getProjects(req, res);

    assert.strictEqual(statusCode, 500);
    assert.deepStrictEqual(jsonResponse, { error: errorMsg });
  });
});
