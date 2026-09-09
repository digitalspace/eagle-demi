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
    calls.push({
      url: String(url), method: init.method || 'GET', headers: init.headers, body: init.body
    });
    const page = queue.shift() || { body: [], continuation: null };
    const status = page.status || 200;
    return {
      ok: status < 400,
      status,
      headers: { get: name => (name === 'x-continuation-token' ? page.continuation : null) },
      json: async () => page.body,
      text: async () => ''
    };
  };
  return { impl, calls };
}

/** What a recorded request carried, decoded; null when it carried nothing. */
function sentBody(call) {
  return call.body === undefined ? null : JSON.parse(call.body);
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

  await t.test('sends the record itself as the JSON request body', async () => {
    // Method and URL alone cannot tell a write apart from a write of nothing: a PUT with no body
    // stores an empty summary over the generated one.
    const { impl, calls } = stubFetch([{ body: { id: '272' } }]);
    const record = {
      id: '272',
      generatedAt: '2026-09-08T00:00:00.000Z',
      sections: [{ key: 'compliance', paragraph: 'Two non-compliances were recorded.' }]
    };

    await apiSource({ baseUrl: 'https://demi.example/api', token: 't', fetchImpl: impl })
      .save(record);

    assert.deepStrictEqual(sentBody(calls[0]), record);
  });
});

test('apiSource on a 404', async (t) => {
  await t.test('reads a project that is not there as null', async () => {
    const { impl } = stubFetch([{ status: 404, body: { error: 'Project not found' } }]);

    const project = await apiSource({
      baseUrl: 'https://demi.example/api', token: 't', fetchImpl: impl
    }).project('999');

    assert.strictEqual(project, null);
  });

  await t.test('reads a project with nothing stored yet as null', async () => {
    // null is what `--section` merges into: an error here would stop the first generation run of
    // every project instead of writing its first record.
    const { impl } = stubFetch([{ status: 404, body: { error: 'Summary not found' } }]);

    const summary = await apiSource({
      baseUrl: 'https://demi.example/api', token: 't', fetchImpl: impl
    }).summary('272');

    assert.strictEqual(summary, null);
  });
});

test('apiSource.organizations', async (t) => {
  await t.test('asks the filtered search for pageSize 500, not 1000', async () => {
    // `/search` refuses pageSize above 500 for a filtered read — `and[companyType]` is a filter.
    const { impl, calls } = stubFetch([{ body: [{ searchResults: [{ id: 'org1' }] }] }]);

    await apiSource({ baseUrl: 'https://demi.example/api', token: 't', fetchImpl: impl })
      .organizations();

    assert.ok(calls[0].url.includes('pageSize=500'), `asked ${calls[0].url}`);
  });

  await t.test('asks for the next page while a page comes back full', async () => {
    const first = Array.from({ length: 500 }, (_, i) => ({ id: `org${i}` }));
    const { impl, calls } = stubFetch([
      { body: [{ searchResults: first }] },
      { body: [{ searchResults: [{ id: 'orgLast' }] }] }
    ]);

    const orgs = await apiSource({
      baseUrl: 'https://demi.example/api', token: 't', fetchImpl: impl
    }).organizations();

    assert.strictEqual(orgs.length, 501);
    assert.strictEqual(orgs[500].id, 'orgLast');
    assert.ok(calls[1].url.includes('pageNum=1'), `asked ${calls[1].url}`);
  });
});

test('apiSource.chunksForDocument', async (t) => {
  await t.test('reads the rows from the document own chunks route', async () => {
    const { impl, calls } = stubFetch([
      { body: { items: [{ id: 'docX::p1::c0' }, { id: 'docX::p1::c1' }] } }
    ]);

    const { items } = await apiSource({
      baseUrl: 'https://demi.example/api', token: 't', fetchImpl: impl
    }).chunksForDocument('docX');

    assert.deepStrictEqual(items.map(c => c.id), ['docX::p1::c0', 'docX::p1::c1']);
    assert.ok(calls[0].url.startsWith('https://demi.example/api/documents/docX/chunks?'),
      `asked ${calls[0].url}`);
  });

  await t.test('asks for the next page while a page comes back full', async () => {
    // 500 rows is the page size asked for, so a full page means there may be more. A reader that
    // stops there drops every passage past the first 500 of a long inspection record.
    const first = Array.from({ length: 500 }, (_, i) => ({ id: `docX::p1::c${i}` }));
    const { impl, calls } = stubFetch([
      { body: { items: first } },
      { body: { items: [{ id: 'docX::p2::c0' }] } }
    ]);

    const { items } = await apiSource({
      baseUrl: 'https://demi.example/api', token: 't', fetchImpl: impl
    }).chunksForDocument('docX');

    assert.strictEqual(items.length, 501);
    assert.strictEqual(items[500].id, 'docX::p2::c0');
    assert.ok(calls[1].url.includes('page=2'), `asked ${calls[1].url}`);
  });

  await t.test('reads a body carrying no items as no chunks', async () => {
    const { impl } = stubFetch([{ body: { count: 0 } }]);

    const { items } = await apiSource({
      baseUrl: 'https://demi.example/api', token: 't', fetchImpl: impl
    }).chunksForDocument('docX');

    assert.deepStrictEqual(items, []);
  });
});
