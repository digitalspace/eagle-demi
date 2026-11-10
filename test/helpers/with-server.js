'use strict';

/**
 * Drive the dispatcher the way the Functions host does, and hand the caller a `fetch`-shaped call.
 *
 * There is no http.Server to boot any more: `@azure/functions` exports a constructible
 * HttpRequest, and dispatch() answers an HttpResponseInit, so a real `Response` built from it gives
 * the suites `.status`, `.headers.get()`, `.text()` and `.json()` with no dependency and no socket.
 */

const { HttpRequest } = require('@azure/functions');
const jwt = require('jsonwebtoken');

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
    // The body goes in exactly as the Functions worker passes it: `res.body || null` would launder
    // an empty-string body into null and hide the null-body-status bug the worker throws on.
    return new Response(res.body, { status: res.status, headers: res.headers });
  });
}

/** Call `/api<path>` as a user holding `roles`; returns status, JSON body and two headers. */
async function send(method, path, roles, body) {
  const token = jwt.sign({ sub: 'kc-1', preferred_username: 'idir-user', realm_access: { roles } }, 'suite-only');
  let result;
  await withServer(async (call) => {
    const res = await call(`/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    result = {
      status: res.status,
      body: await res.json(),
      total: res.headers.get('x-total-count'),
      cache: res.headers.get('cache-control')
    };
  });
  return result;
}

module.exports = { withServer, send };
