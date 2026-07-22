'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

// Load models so controllers can reference them
const Project = require('../../src/models/project');
const Region = require('../../src/models/region');
const Boundary = require('../../src/models/boundary');
const projectController = require('../../src/controllers/project');

test('Spatial Controller Tests', async (t) => {

  t.afterEach(() => {
    t.mock.restoreAll();
  });

  await t.test('getProjects returns all projects when region query parameter is absent', async () => {
    const mockProjects = [
      { name: 'Project North', centroid: { type: 'Point', coordinates: [-125.0, 55.0] } },
      { name: 'Project South', centroid: { type: 'Point', coordinates: [-123.0, 49.0] } }
    ];

    t.mock.method(Project, 'find', async (query) => {
      assert.deepStrictEqual(query, {});
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

  await t.test('getProjects returns 404 when specified region is not found', async () => {
    t.mock.method(Region, 'findOne', async (query) => {
      assert.deepStrictEqual(query, { name: 'NonexistentRegion' });
      return null;
    });

    const req = { query: { region: 'NonexistentRegion' }, header: () => null };
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

    assert.strictEqual(statusCode, 404);
    assert.deepStrictEqual(jsonResponse, { error: 'Region not found' });
  });

  await t.test('getProjects filters projects inside region using $geoWithin spatial query', async () => {
    const regionName = 'Kootenay';
    const mockGeometry = {
      type: 'Polygon',
      coordinates: [[
        [-118.0, 49.0],
        [-114.0, 49.0],
        [-114.0, 52.0],
        [-118.0, 52.0],
        [-118.0, 49.0]
      ]]
    };

    const mockRegion = {
      name: regionName,
      geometry: mockGeometry
    };

    const mockFilteredProjects = [
      { name: 'Kootenay Mine', centroid: { type: 'Point', coordinates: [-116.0, 50.0] } }
    ];

    t.mock.method(Region, 'findOne', async (query) => {
      assert.deepStrictEqual(query, { name: regionName });
      return mockRegion;
    });

    t.mock.method(Project, 'find', async (query) => {
      assert.deepStrictEqual(query, {
        centroid: {
          $geoWithin: { $geometry: mockGeometry }
        }
      });
      return mockFilteredProjects;
    });

    const req = { query: { region: regionName }, header: (name) => name === 'X-Api-Key' ? 'eagle-demi-api-key' : null };
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

  await t.test('getProjects returns 500 when database find fails', async () => {
    const errorMsg = 'Database connection lost';
    t.mock.method(Region, 'findOne', async () => {
      throw new Error(errorMsg);
    });

    const req = { query: { region: 'AnyRegion' }, header: () => null };
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

  await t.test('getProjects filters projects by administrative boundaries using text attributes', async () => {
    const rdName = 'Metro Vancouver';
    const muniName = 'Vancouver';
    const edName = 'Vancouver-Point Grey';

    const mockFilteredProjects = [
      { name: 'Metro Project', centroid: { type: 'Point', coordinates: [-123.0, 49.5] } }
    ];

    t.mock.method(Project, 'find', async (query) => {
      assert.deepStrictEqual(query, {
        regionalDistrict: rdName,
        municipality: muniName,
        electoralDistrict: edName
      });
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

  await t.test('createProject auto-tags project with correct regionalDistrict, municipality, and electoralDistrict', async () => {
    t.mock.method(Boundary, 'find', async () => {
      return [
        { type: 'Regional District', name: 'Metro Vancouver' },
        { type: 'Municipality', name: 'Vancouver' },
        { type: 'Electoral District', name: 'Vancouver-Point Grey' }
      ];
    });

    let savedProjectData;
    t.mock.method(Project.prototype, 'save', async function() {
      savedProjectData = this;
      return this;
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
    assert.strictEqual(savedProjectData.regionalDistrict, 'Metro Vancouver');
    assert.strictEqual(savedProjectData.municipality, 'Vancouver');
    assert.strictEqual(savedProjectData.electoralDistrict, 'Vancouver-Point Grey');
    assert.strictEqual(jsonResponse.regionalDistrict, 'Metro Vancouver');
  });

  await t.test('updateProject auto-tags project with correct boundaries when centroid is updated', async () => {
    t.mock.method(Boundary, 'find', async () => {
      return [
        { type: 'Regional District', name: 'Capital Regional District' },
        { type: 'Municipality', name: 'Victoria' },
        { type: 'Electoral District', name: 'Victoria-Beacon Hill' }
      ];
    });

    t.mock.method(Project, 'findOneAndUpdate', async (query, updateBody, _options) => {
      return { ...updateBody, trackProjectId: 12345 };
    });

    const req = {
      params: { id: '12345' },
      body: {
        centroid: { type: 'Point', coordinates: [-123.36, 48.42] }
      }
    };

    let jsonResponse;
    const res = {
      json: (data) => {
        jsonResponse = data;
        return res;
      }
    };

    await projectController.updateProject(req, res);

    assert.strictEqual(jsonResponse.regionalDistrict, 'Capital Regional District');
    assert.strictEqual(jsonResponse.municipality, 'Victoria');
    assert.strictEqual(jsonResponse.electoralDistrict, 'Victoria-Beacon Hill');
  });
});
