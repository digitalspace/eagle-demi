'use strict';

/**
 * Drive the dispatcher the way the Functions host does, and hand the caller a `fetch`-shaped call.
 *
 * There is no http.Server to boot any more: `@azure/functions` exports a constructible
 * HttpRequest, and dispatch() answers an HttpResponseInit, so a real `Response` built from it gives
 * the suites `.status`, `.headers.get()`, `.text()` and `.json()` with no dependency and no socket.
 */

const { HttpRequest } = require('@azure/functions');

const BASE = 'http://127.0.0.1';

/** @param {(call: (path: string, init?: RequestInit) => Promise<Response>) => Promise<void>} fn */
async function withServer(fn) {
  const { dispatch } = require('../../src/http/router');

  await fn(async (path, init = {}) => {
    const request = new HttpRequest({
      method: init.method || 'GET',
      url: `${BASE}${path}`,
      headers: init.headers || {},
      body: init.body === undefined ? undefined : { string: init.body }
    });
    const res = await dispatch(request, { error: () => {} });
    return new Response(res.body || null, { status: res.status, headers: res.headers });
  });
}

module.exports = { withServer };
