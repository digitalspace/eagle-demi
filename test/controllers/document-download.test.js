'use strict';

/**
 * GET /api/documents/:id/download — the two modes.
 *
 * JSON is what eagle-admin-console and the old public site read. The 302 is what a plain
 * `<a href>` needs: a browser navigation cannot read the JSON body, so without it the visitor
 * lands on a page of presigned URL text. Both modes run the SAME visibility check, and that is the
 * assertion that matters most here — a redirect that skipped `documents.getById` would hand out a
 * link to an unpublished document.
 *
 * The router's own response object, not a `{ status, json }` double: it refuses a second send, so a
 * handler that redirected AND answered JSON fails here instead of passing.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const storage = require('../../src/storage');
const documents = require('../../src/repositories/documents');
const controller = require('../../src/controllers/nosql/document');
const { makeRes } = require('../../src/http/router');
const { withServer } = require('../helpers/with-server');

const URL_WITH_DISPOSITION =
  'https://demistoretest.blob.core.windows.net/demi-test/etl/site-c/report.pdf' +
  '?sig=redacted&rscd=attachment%3B%20filename%3D%22report.pdf%22';

const DOC = {
  id: 'doc-1',
  projectId: '207',
  displayName: 'Site C Report',
  s3Key: 'etl/site-c/report.pdf',
  isPublished: true
};

function req(overrides = {}) {
  return { headers: {}, query: {}, params: { id: DOC.id }, ...overrides };
}

function res() {
  return makeRes('test-request');
}

/** A readable document and a presign that succeeds — the happy path both modes share. */
function allow(t, { doc = DOC } = {}) {
  t.mock.method(documents, 'getById', async () => doc);
  return t.mock.method(storage, 'getDownloadUrl', async () => URL_WITH_DISPOSITION);
}

test('download in JSON mode', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('returns the presigned url, unchanged', async (t) => {
    allow(t);
    const response = res();

    await controller.downloadDocument(req(), response);

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.url, URL_WITH_DISPOSITION);
    assert.equal(body.fileName, 'report.pdf');
    assert.equal(body.displayName, 'Site C Report');
    assert.ok(body.expiresIn > 0);
    assert.ok(!('location' in response.headers), 'JSON mode must not set a Location');
  });

  await t.test('an XHR Accept keeps the JSON', async (t) => {
    allow(t);
    for (const accept of ['application/json', '*/*', 'application/json, text/plain, */*']) {
      const response = res();
      await controller.downloadDocument(req({ headers: { accept } }), response);
      assert.equal(response.statusCode, 200, accept);
      assert.equal(JSON.parse(response.body).url, URL_WITH_DISPOSITION, accept);
    }
  });

  await t.test('the presign is asked for the file name, so the browser saves report.pdf', async (t) => {
    // Already the behaviour, asserted because the redirect mode has no JSON body to carry the name
    // — `response-content-disposition` on the presigned URL is the only thing left saying it.
    const presign = allow(t);
    await controller.downloadDocument(req(), res());

    assert.equal(presign.mock.callCount(), 1);
    assert.deepEqual(presign.mock.calls[0].arguments[1].fileName, 'report.pdf');
  });
});

test('download in redirect mode', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('?redirect=1 answers 302 to the presigned url, no-store', async (t) => {
    allow(t);
    const response = res();

    await controller.downloadDocument(req({ query: { redirect: '1' } }), response);

    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, URL_WITH_DISPOSITION);
    // The Location IS the credential: it is presigned and short-lived, so a cache or a history
    // entry replaying this response hands out a link nobody authorised again.
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.body, '', 'a redirect carries no body');
  });

  await t.test('an Accept of text/html redirects without the query flag', async (t) => {
    // What an `<a href>` sends. The whole point of the mode.
    allow(t);
    for (const accept of ['text/html', 'text/html,application/xhtml+xml,application/xml;q=0.9']) {
      const response = res();
      await controller.downloadDocument(req({ headers: { accept } }), response);
      assert.equal(response.statusCode, 302, accept);
      assert.equal(response.headers.location, URL_WITH_DISPOSITION, accept);
    }
  });

  await t.test('the last redirect value wins, not the first', async (t) => {
    // Repeated query keys arrive as arrays from querystring.parse, so `?redirect=0&redirect=1` must
    // not be compared as an array against '1'.
    allow(t);
    const response = res();
    await controller.downloadDocument(req({ query: { redirect: ['0', '1'] } }), response);
    assert.equal(response.statusCode, 302);
  });

  await t.test('any other redirect value stays JSON', async (t) => {
    allow(t);
    for (const redirect of ['0', 'true', '', 'yes']) {
      const response = res();
      await controller.downloadDocument(req({ query: { redirect } }), response);
      assert.equal(response.statusCode, 200, `redirect=${redirect}`);
    }
  });

  await t.test('the ACL still runs — an unreadable document is a 404 JSON, never a redirect', async (t) => {
    // `documents.getById` applies the caller's access, so null is "published[] and read[] do not
    // admit you" as well as "no such id". Either way there is nowhere to send the caller.
    t.mock.method(documents, 'getById', async () => null);
    const presign = t.mock.method(storage, 'getDownloadUrl', async () => URL_WITH_DISPOSITION);
    const response = res();

    await controller.downloadDocument(req({ query: { redirect: '1' } }), response);

    assert.equal(response.statusCode, 404);
    assert.deepEqual(JSON.parse(response.body), { error: 'Document not found' });
    assert.ok(!('location' in response.headers), 'a 404 must not redirect anywhere');
    assert.equal(presign.mock.callCount(), 0, 'no url may be minted for a document nobody may read');
  });

  await t.test('a document with no stored file is a 404 JSON in redirect mode too', async (t) => {
    t.mock.method(documents, 'getById', async () => ({ ...DOC, s3Key: '' }));
    const response = res();

    await controller.downloadDocument(req({ query: { redirect: '1' } }), response);

    assert.equal(response.statusCode, 404);
    assert.deepEqual(JSON.parse(response.body), { error: 'Document has no stored file.' });
  });

  await t.test('a failed presign is a 500 JSON in redirect mode too', async (t) => {
    t.mock.method(documents, 'getById', async () => DOC);
    t.mock.method(storage, 'getDownloadUrl', async () => { throw new Error('storage unreachable'); });
    const response = res();

    await controller.downloadDocument(req({ query: { redirect: '1' } }), response);

    assert.equal(response.statusCode, 500);
    assert.deepEqual(JSON.parse(response.body), { error: 'Failed to generate download link.' });
    assert.ok(!('location' in response.headers));
  });
});

test('the redirect survives the dispatcher', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  // The handler setting a header is not the same as the host returning one: `makeRes` merges the
  // security headers and dispatch() hands back `{ status, headers, body }`, so this is the only
  // place the 302 is checked as the caller would receive it.
  await t.test('302, Location and no-store reach the caller', async (t) => {
    allow(t);
    await withServer(async (call) => {
      const res = await call(`/api/documents/${DOC.id}/download?redirect=1`);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), URL_WITH_DISPOSITION);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    });
  });

  await t.test('and the JSON mode still answers 200 at the same path', async (t) => {
    allow(t);
    await withServer(async (call) => {
      const res = await call(`/api/documents/${DOC.id}/download`);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).url, URL_WITH_DISPOSITION);
    });
  });
});
