'use strict';

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

// Load models so controllers can reference them
const Project = require('../../src/models/project');
const Region = require('../../src/models/region');
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

    const req = { query: {} };
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

    const req = { query: { region: 'NonexistentRegion' } };
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

    const req = { query: { region: regionName } };
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

    const req = { query: { region: 'AnyRegion' } };
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
