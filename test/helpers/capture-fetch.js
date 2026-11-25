'use strict';

/** Replace global.fetch. A real credential lookup in CI would hang rather than fail. */
function captureFetch(t, responder) {
  const calls = [];
  const originalFetch = global.fetch;

  global.fetch = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    const result = responder(calls.length - 1);
    // `throws` models a transport-level failure — the shape a request timeout arrives in, which is
    // an exception from the abort signal rather than any HTTP status.
    if (result.throws) throw result.throws;
    return {
      ok: result.ok !== false,
      status: result.status || 200,
      // Retry-After is read off the real Headers API, so the stub has to answer `get()` rather
      // than expose a plain object.
      headers: { get: (name) => (result.headers || {})[String(name).toLowerCase()] ?? null },
      json: async () => result.json || {},
      text: async () => JSON.stringify(result.json || {})
    };
  };

  t.after(() => { global.fetch = originalFetch; });
  return calls;
}

// The credential is only constructed on a cache miss, so seeding a live token keeps every test
// off the network. Mirrors what DefaultAzureCredential would have returned.
function stubToken() {
  const { DefaultAzureCredential } = require('@azure/identity');
  DefaultAzureCredential.prototype.getToken = async () => ({
    token: 'test-token',
    expiresOnTimestamp: Date.now() + 60 * 60 * 1000
  });
}

module.exports = { captureFetch, stubToken };
