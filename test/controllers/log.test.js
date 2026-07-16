'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

// Ensure Log model is registered
const Log = require('../../src/models/log');
const logController = require('../../src/controllers/log');

test('Log Controller Tests', async (t) => {

  t.afterEach(() => {
    t.mock.restoreAll();
  });

  await t.test('getLogs returns matched logs with default options', async () => {
    const mockLogs = [
      { level: 'info', message: 'First log', requestId: 'req-1' },
      { level: 'error', message: 'Second log', requestId: 'req-2' }
    ];

    // Mock Log.find and its builder chain
    t.mock.method(Log, 'find', (query) => {
      // Expect empty query since no filters are sent
      assert.deepStrictEqual(query, {});
      return {
        sort: (sortObj) => {
          assert.deepStrictEqual(sortObj, { timestamp: -1 });
          return {
            limit: (limitVal) => {
              assert.strictEqual(limitVal, 100);
              return {
                lean: async () => mockLogs
              };
            }
          };
        }
      };
    });

    const req = { query: {} };
    let statusValue;
    let jsonResponse;
    const res = {
      status: (val) => {
        statusValue = val;
        return {
          json: (data) => {
            jsonResponse = data;
          }
        };
      }
    };

    await logController.getLogs(req, res);

    assert.strictEqual(statusValue, 200);
    assert.ok(jsonResponse.success);
    assert.strictEqual(jsonResponse.count, 2);
    assert.deepStrictEqual(jsonResponse.data, mockLogs);
  });

  await t.test('getLogs correctly filters by level and requestId, and respects limit/sort', async () => {
    const mockLogs = [
      { level: 'error', message: 'Error log matching', requestId: 'req-abc' }
    ];

    t.mock.method(Log, 'find', (query) => {
      // Validate query properties
      assert.strictEqual(query.level, 'error');
      assert.strictEqual(query.requestId, 'req-abc');
      return {
        sort: (sortObj) => {
          // Sort direction should be ascending (1)
          assert.deepStrictEqual(sortObj, { timestamp: 1 });
          return {
            limit: (limitVal) => {
              // Custom limit of 10
              assert.strictEqual(limitVal, 10);
              return {
                lean: async () => mockLogs
              };
            }
          };
        }
      };
    });

    const req = {
      query: {
        level: 'error',
        requestId: 'req-abc',
        limit: '10',
        sort: '1'
      }
    };

    let statusValue;
    let jsonResponse;
    const res = {
      status: (val) => {
        statusValue = val;
        return {
          json: (data) => {
            jsonResponse = data;
          }
        };
      }
    };

    await logController.getLogs(req, res);

    assert.strictEqual(statusValue, 200);
    assert.ok(jsonResponse.success);
    assert.strictEqual(jsonResponse.count, 1);
    assert.deepStrictEqual(jsonResponse.data, mockLogs);
  });

  await t.test('getLogs correctly processes search regex filter', async () => {
    t.mock.method(Log, 'find', (query) => {
      // Validate query has regex search on message
      assert.ok(query.message);
      assert.ok(query.message.$regex);
      assert.strictEqual(query.message.$regex, 'database');
      assert.strictEqual(query.message.$options, 'i');
      return {
        sort: () => ({
          limit: () => ({
            lean: async () => []
          })
        })
      };
    });

    const req = {
      query: {
        search: 'database'
      }
    };

    const res = {
      status: () => ({
        json: () => {}
      })
    };

    await logController.getLogs(req, res);
  });
});
