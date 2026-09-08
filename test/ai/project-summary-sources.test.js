'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { apiSource } = require('../../src/ai/project-summary-sources');

/** A fetch that answers from a queue and records every request it was handed. */
function stubFetch(pages) {
  const calls = [];
  const queue = pages.slice();
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers });
    const page = queue.shift() || { body: [], continuation: null };
    return {
      ok: true,
      status: 200,
      headers: { get: name => (name === 'x-continuation-token' ? page.continuation : null) },
      json: async () => page.body,
      text: async () => ''
    };
  };
  return { impl, calls };
}

test('apiSource.documents', async (t) => {
  await t.test('follows the continuation token to the end of the list', async () => {
    // Site C has 2,158 documents against a 1,000-row page cap. A reader that stops at the first
    // page silently drops the Inspection Records the compliance counts are made of.
    const { impl, calls } = stubFetch([
      { body: [{ id: 'd1' }], continuation: 'tok-1' },
      { body: [{ id: 'd2' }], continuation: null }
    ]);

    const rows = await apiSource({
      baseUrl: 'https://demi.example/api', token: 't', fetchImpl: impl
    }).documents('272');

    assert.deepStrictEqual(rows.map(r => r.id), ['d1', 'd2']);
    assert.ok(calls[1].url.includes('continuationToken=tok-1'));
  });
});

test('apiSource authentication', async (t) => {
  await t.test('sends the bearer token', async () => {
    const { impl, calls } = stubFetch([{ body: { id: '272' } }]);
    await apiSource({ baseUrl: 'https://demi.example/api', token: 'abc', fetchImpl: impl })
      .project('272');

    assert.strictEqual(calls[0].headers.Authorization, 'Bearer abc');
  });

  await t.test('sends an API key instead of a token, never both', async () => {
    // `helpers/auth.js` prefers `X-Api-Key` and ignores a bearer token beside it, so a request
    // carrying both would authenticate as something other than what the operator passed.
    const { impl, calls } = stubFetch([{ body: { id: '272' } }]);
    await apiSource({
      baseUrl: 'https://demi.example/api', token: 'abc', apiKey: 'key', fetchImpl: impl
    }).project('272');

    assert.strictEqual(calls[0].headers['X-Api-Key'], 'key');
    assert.strictEqual(calls[0].headers.Authorization, undefined);
  });

  await t.test('refuses to be built with no credential at all', () => {
    assert.throws(() => apiSource({ baseUrl: 'https://demi.example/api' }),
      /token or an API key/);
  });
});

test('apiSource.save', async (t) => {
  await t.test('PUTs the record to the project it belongs to', async () => {
    const { impl, calls } = stubFetch([{ body: { id: '272' } }]);
    await apiSource({ baseUrl: 'https://demi.example/api', token: 't', fetchImpl: impl })
      .save({ id: '272', generatedAt: 'now' });

    assert.strictEqual(calls[0].method, 'PUT');
    assert.strictEqual(calls[0].url, 'https://demi.example/api/projects/272/summary');
  });
});
