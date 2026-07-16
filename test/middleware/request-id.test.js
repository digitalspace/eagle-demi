'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const requestIdMiddleware = require('../../src/middleware/request-id');
const { asyncLocalStorage } = require('../../src/utils/logger');

test('Request ID Middleware Tests', async (t) => {

  await t.test('reuses existing x-request-id header', () => {
    const req = {
      header: (name) => {
        if (name.toLowerCase() === 'x-request-id') return 'existing-trace-123';
        return null;
      }
    };
    
    let responseHeaders = {};
    const res = {
      setHeader: (name, val) => {
        responseHeaders[name] = val;
      }
    };

    let nextCalled = false;
    const next = () => {
      nextCalled = true;
      // Inside next(), the AsyncLocalStorage context should contain our requestId
      const store = asyncLocalStorage.getStore();
      assert.ok(store);
      assert.strictEqual(store.requestId, 'existing-trace-123');
    };

    requestIdMiddleware(req, res, next);

    assert.ok(nextCalled);
    assert.strictEqual(req.id, 'existing-trace-123');
    assert.strictEqual(responseHeaders['X-Request-ID'], 'existing-trace-123');
  });

  await t.test('generates a new short trace ID when missing', () => {
    const req = {
      header: () => null
    };

    let responseHeaders = {};
    const res = {
      setHeader: (name, val) => {
        responseHeaders[name] = val;
      }
    };

    let nextCalled = false;
    const next = () => {
      nextCalled = true;
      const store = asyncLocalStorage.getStore();
      assert.ok(store);
      assert.strictEqual(store.requestId, req.id);
    };

    requestIdMiddleware(req, res, next);

    assert.ok(nextCalled);
    assert.ok(req.id);
    assert.strictEqual(req.id.length, 8); // Should be 8-char short ID
    assert.strictEqual(responseHeaders['X-Request-ID'], req.id);
  });
});
