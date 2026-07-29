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

    t.mock.method(Log, 'find', async (filter, options) => {
      assert.deepStrictEqual(filter, {});
      assert.strictEqual(options.maxItemCount, 100);
      assert.deepStrictEqual(options.sort, { timestamp: -1 });
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

    t.mock.method(Log, 'find', async (filter, options) => {
      assert.strictEqual(filter.level, 'error');
      assert.strictEqual(filter.requestId, 'req-abc');
      assert.strictEqual(options.maxItemCount, 10);
      assert.deepStrictEqual(options.sort, { timestamp: 1 });
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
