'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

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

    t.mock.method(Log, 'find', async (whereClause, parameters, options) => {
      assert.strictEqual(whereClause, '');
      assert.strictEqual(options.maxItemCount, 100);
      assert.strictEqual(options.orderBy, 'c.timestamp DESC');
      return mockLogs;
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

  await t.test('getLogs correctly filters by level and requestId', async () => {
    const mockLogs = [
      { level: 'error', message: 'Error log matching', requestId: 'req-abc' }
    ];

    t.mock.method(Log, 'find', async (whereClause, parameters, options) => {
      assert.ok(whereClause.includes('c.level = @level'));
      assert.ok(whereClause.includes('c.requestId = @reqId'));
      assert.strictEqual(options.maxItemCount, 10);
      assert.strictEqual(options.orderBy, 'c.timestamp ASC');
      return mockLogs;
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
});
