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
// Before src/config is first required: the audit writer is inert without these, so a HEAD that
// wrote an event would pass the "no event" check below. Batch of 1 sends each row at once.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';
process.env.AUDIT_MAX_BATCH = '1';

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('events');
const { Readable } = require('stream');
const { HttpRequest } = require('@azure/functions');

const storage = require('../../src/storage');
const documents = require('../../src/repositories/documents');
const controller = require('../../src/controllers/nosql/document');
const audit = require('../../src/utils/audit');
const { logger } = require('../../src/utils/logger');
const { makeRes, dispatch } = require('../../src/http/router');
const { withServer } = require('../helpers/with-server');
const { TIER } = require('../../src/helpers/access-sql');
const config = require('../../src/config');

// Both streams (analytics and audit) land here instead of the ingestion API.
const sent = [];
audit._setTransport(async (stream, batch) => { sent.push(...batch.map(row => ({ stream, ...row }))); });

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
    assert.equal(body.fileName, 'Site C Report.pdf');
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

});

test('the file name the URL is signed with', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  // The redirect mode has no JSON body to carry the name: `response-content-disposition` on the
  // presigned URL is the only thing saying it, so the presign and the body must agree.
  async function names(t, fields, query = {}) {
    const doc = { ...DOC, s3Key: 'etl/site-c/4dd67fbf0c.pdf', ...fields };
    const presign = allow(t, { doc });
    const response = res();
    await controller.downloadDocument(req({ query }), response);
    const signed = presign.mock.calls[0].arguments[1].fileName;
    return { signed, body: response.body ? JSON.parse(response.body) : null };
  }

  await t.test('the document file name, not the storage key', async (t) => {
    const { signed, body } = await names(t, { documentFileName: 'Site C EAC Application.pdf' });
    assert.strictEqual(signed, 'Site C EAC Application.pdf');
    assert.strictEqual(body.fileName, signed);
  });

  await t.test('a file name with no extension takes the recorded one', async (t) => {
    const { signed } = await names(t, { documentFileName: 'Site C Application', fileExt: 'pdf' });
    assert.strictEqual(signed, 'Site C Application.pdf');
  });

  await t.test('no file name: the display name, with the extension of the stored key', async (t) => {
    const { signed } = await names(t, {});
    assert.strictEqual(signed, 'Site C Report.pdf');
  });

  await t.test('a version number is not an extension: the stored key lends one', async (t) => {
    const { signed } = await names(t, { documentFileName: 'Report v1.2' });
    assert.strictEqual(signed, 'Report v1.2.pdf');
  });

  await t.test('a name withheld from this caller is not signed; the key names the file', async (t) => {
    const { signed, body } = await names(t, {
      documentFileName: 'Sealed Enforcement Order.pdf',
      displayName: 'Sealed Enforcement Order',
      vis: { documentFileName: 0, displayName: 0 }
    });
    assert.strictEqual(signed, '4dd67fbf0c.pdf');
    assert.strictEqual(body.displayName, null, 'the withheld title must not ride along in the body');
  });

  await t.test('an inline redirect signs the same name', async (t) => {
    const { signed } = await names(t, { documentFileName: 'Site C EAC Application.pdf' },
      { redirect: '1', inline: '1' });
    assert.strictEqual(signed, 'Site C EAC Application.pdf');
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

test('download in inline mode', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  // Streaming off: these cases are about the presign, which the stream mode falls back to.
  const streamMax = config.downloadStreamMaxBytes;
  config.downloadStreamMaxBytes = 0;
  t.after(() => { config.downloadStreamMaxBytes = streamMax; });

  /** The inlineType the presign was asked for. */
  async function signedType(t, query, doc = DOC) {
    const presign = allow(t, { doc });
    const response = res();
    await controller.downloadDocument(req({ query }), response);
    assert.equal(presign.mock.callCount(), 1);
    return { response, type: presign.mock.calls[0].arguments[1].inlineType };
  }

  await t.test('?inline=1&redirect=1 on a PDF signs it inline as application/pdf', async (t) => {
    const { response, type } = await signedType(t, { redirect: '1', inline: '1' },
      { ...DOC, mimeType: 'application/pdf' });
    assert.equal(type, 'application/pdf');
    assert.equal(response.statusCode, 302);
  });

  await t.test('?inline=1 alone, streaming off, answers the inline 302', async (t) => {
    const { response, type } = await signedType(t, { inline: '1' });
    assert.equal(type, 'application/pdf', 'no recorded type: the .pdf name decides');
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers['cache-control'], 'no-store');
  });

  await t.test('?inline=1 never answers JSON, even to an XHR Accept', async (t) => {
    allow(t);
    const response = res();
    await controller.downloadDocument(req({ query: { inline: '1' }, headers: { accept: 'application/json' } }),
      response);
    assert.equal(response.statusCode, 302);
  });

  await t.test('the last inline value wins', async (t) => {
    const { type } = await signedType(t, { inline: ['0', '1'] }, { ...DOC, mimeType: 'application/pdf' });
    assert.strictEqual(type, 'application/pdf');
  });

  await t.test('the JSON body says the URL is an attachment', async (t) => {
    const { response } = await signedType(t, {}, { ...DOC, mimeType: 'application/pdf' });
    assert.strictEqual(JSON.parse(response.body).inline, false);
  });

  await t.test('an inline view is marked in the analytics and audit detail; a save is not', async (t) => {
    const restricted = { ...DOC, mimeType: 'application/pdf', isPublished: false };
    const detailOf = async (query) => {
      sent.length = 0;
      await signedType(t, query, restricted);
      await audit.flush();
      t.mock.restoreAll();
      const row = (stream) => sent.find(r => r.stream === stream).Detail;
      return { analytics: row(audit.EVENTS_STREAM), audited: row(audit.AUDIT_STREAM) };
    };

    const view = await detailOf({ inline: '1' });
    assert.deepStrictEqual(view.analytics, { inline: true });
    assert.deepStrictEqual(view.audited, { displayName: 'Site C Report', inline: true });

    const save = await detailOf({});
    assert.deepStrictEqual(save.analytics, {});
    assert.deepStrictEqual(save.audited, { displayName: 'Site C Report' });
  });

  await t.test('HTML, SVG or an unknown type stays an attachment', async (t) => {
    for (const doc of [
      { ...DOC, mimeType: 'text/html', s3Key: 'etl/page.html' },
      { ...DOC, mimeType: 'image/svg+xml', s3Key: 'etl/logo.svg' },
      { ...DOC, mimeType: 'text/html' },
      { ...DOC, s3Key: 'etl/noext' }
    ]) {
      const { type } = await signedType(t, { redirect: '1', inline: '1' }, doc);
      assert.strictEqual(type, null, JSON.stringify(doc));
      t.mock.restoreAll();
    }
  });

  await t.test('without inline=1 a PDF is still an attachment', async (t) => {
    for (const query of [{ redirect: '1' }, { redirect: '1', inline: 'true' }, { inline: ['1', '0'] }]) {
      const { type } = await signedType(t, query, { ...DOC, mimeType: 'application/pdf' });
      assert.strictEqual(type, null, JSON.stringify(query));
      t.mock.restoreAll();
    }
  });

  await t.test('HEAD ignores it: still attachment', async (t) => {
    allow(t);
    t.mock.method(storage, 'statObject', async () => ({ size: 1, contentType: 'application/pdf' }));
    await withServer(async (call) => {
      const res = await call(`/api/documents/${DOC.id}/download?inline=1`, { method: 'HEAD' });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-disposition'), /^attachment;/);
    });
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

test('HEAD is answered here, never redirected', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  // The presigned URL is signed for GET, so a HEAD that followed a 302 got a 403 from the store.
  // Every case runs through the dispatcher: the router is what turns HEAD into this GET route.
  const head = (call, path) => call(path, { method: 'HEAD' });
  const STAT = { size: 48213, contentType: 'application/pdf' };
  const PATH = `/api/documents/${DOC.id}/download`;

  /** dispatch() as the Functions host gets it, before any Response object fills a header in. */
  const rawHead = (path) => dispatch(
    new HttpRequest({ method: 'HEAD', url: `http://127.0.0.1${path}`, headers: {} }),
    { error: () => {} });

  /** What a store outage looks like: a socket error, not an HTTP answer. */
  const unreachable = () => Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:9000'),
    { code: 'ECONNREFUSED' });

  await t.test('a visible document answers 200 with the file headers and mints no url', async (t) => {
    const presign = allow(t);
    t.mock.method(storage, 'statObject', async () => STAT);
    await withServer(async (call) => {
      const res = await head(call, `/api/documents/${DOC.id}/download`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/pdf');
      assert.equal(res.headers.get('content-length'), '48213');
      assert.equal(res.headers.get('content-disposition'),
        'attachment; filename="Site C Report.pdf"; filename*=UTF-8\'\'Site%20C%20Report.pdf');
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('location'), null);
      assert.equal(await res.text(), '');
    });
    assert.equal(presign.mock.callCount(), 0, 'a HEAD must not mint a presigned url');
  });

  await t.test('?redirect=1 still answers 200, not a 302', async (t) => {
    allow(t);
    t.mock.method(storage, 'statObject', async () => STAT);
    await withServer(async (call) => {
      const res = await head(call, `/api/documents/${DOC.id}/download?redirect=1`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('location'), null);
    });
  });

  await t.test('an unpublished document the caller can see writes no analytics or audit event', async (t) => {
    // GET of this row writes both. HEAD hands out no bytes, so it must write neither.
    allow(t, { doc: { ...DOC, isPublished: false } });
    t.mock.method(storage, 'statObject', async () => STAT);
    sent.length = 0;
    await withServer(async (call) => {
      const res = await head(call, PATH);
      assert.equal(res.status, 200);
    });
    await audit.flush();
    assert.deepEqual(sent, []);
  });

  await t.test('an unknown id is the same 404 as GET, JSON headers included', async (t) => {
    t.mock.method(documents, 'getById', async () => null);
    await withServer(async (call) => {
      const res = await head(call, '/api/documents/no-such-id/download');
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
      assert.equal(res.headers.get('content-length'),
        String(Buffer.byteLength(JSON.stringify({ error: 'Document not found' }))));
    });
  });

  await t.test('a failed lookup logs and answers as GET does', async (t) => {
    t.mock.method(documents, 'getById', async () => { throw new Error('cosmos 503'); });
    const error = t.mock.method(logger, 'error', () => {});
    const response = res();

    await controller.downloadDocument(req({ method: 'HEAD' }), response);

    assert.equal(response.statusCode, 500);
    assert.deepEqual(JSON.parse(response.body), { error: 'Failed to generate download link.' });
    assert.deepEqual(error.mock.calls.map(c => c.arguments[0]),
      ['[Document Controller] Presigned download failed: cosmos 503']);
  });

  await t.test('a document hidden from the caller is a 404', async (t) => {
    // A fake that hides the document from the public tier only: the dispatcher's request carries
    // no credential, so this proves HEAD hands getById the caller's own access.
    t.mock.method(documents, 'getById',
      async (access) => (access.tier === TIER.PUBLIC ? null : { ...DOC, isPublished: false }));
    t.mock.method(storage, 'statObject', async () => STAT);
    await withServer(async (call) => {
      const res = await head(call, `/api/documents/${DOC.id}/download`);
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('content-disposition'), null);
    });
  });

  await t.test('a record whose object is gone from the store is a 404', async (t) => {
    allow(t);
    t.mock.method(storage, 'statObject', async () => null);
    await withServer(async (call) => {
      const res = await head(call, `/api/documents/${DOC.id}/download`);
      assert.equal(res.status, 404);
    });
  });

  await t.test('a store outage answers from the record instead of a 500', async (t) => {
    allow(t, { doc: { ...DOC, mimeType: 'application/pdf', fileSize: '1200' } });
    t.mock.method(storage, 'statObject', async () => { throw unreachable(); });
    const warn = t.mock.method(logger, 'warn', () => {});
    await withServer(async (call) => {
      const res = await head(call, PATH);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/pdf');
      assert.equal(res.headers.get('content-length'), '1200');
    });
    assert.equal(warn.mock.callCount(), 1);
  });

  await t.test('a store 5xx answers from the record too', async (t) => {
    allow(t, { doc: { ...DOC, fileSize: 1200 } });
    t.mock.method(storage, 'statObject', async () => {
      throw Object.assign(new Error('Service Unavailable'), { statusCode: 503 });
    });
    t.mock.method(logger, 'warn', () => {});
    const out = await rawHead(PATH);
    assert.equal(out.status, 200);
    assert.equal(out.headers['content-length'], '1200');
  });

  await t.test('a stat still running after 3 s answers from the record', async (t) => {
    allow(t, { doc: { ...DOC, mimeType: 'application/pdf', fileSize: 1200 } });
    let statCalled;
    const called = new Promise((resolve) => { statCalled = resolve; });
    t.mock.method(storage, 'statObject', () => { statCalled(); return new Promise(() => {}); });
    const warn = t.mock.method(logger, 'warn', () => {});
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const pending = rawHead(PATH);
      await called;
      t.mock.timers.tick(3000);
      // setImmediate is not mocked, so this resolves only if 3 s of fake time did not end the wait.
      const out = await Promise.race([pending, new Promise(r => setImmediate(r, 'still waiting'))]);
      assert.notEqual(out, 'still waiting', 'HEAD is still waiting on the store 3 s in');
      assert.equal(out.status, 200);
      assert.equal(out.headers['content-length'], '1200');
      assert.equal(warn.mock.callCount(), 1);
    } finally {
      t.mock.timers.reset();
    }
  });

  await t.test('a refused store is a 500, logged and answered as GET does', async (t) => {
    // A permission fault does not clear on retry; answering from the record would hide it.
    const shapes = {
      minio: Object.assign(new Error('Valid and authorized credentials required'),
        { name: 'S3Error', code: 'AccessDenied' }),
      azure: Object.assign(new Error('This request is not authorized to perform this operation.'),
        { statusCode: 403, details: { errorCode: 'AuthorizationPermissionMismatch' } })
    };
    for (const [backend, err] of Object.entries(shapes)) {
      t.mock.restoreAll();
      allow(t, { doc: { ...DOC, fileSize: 1200 } });
      t.mock.method(storage, 'statObject', async () => { throw err; });
      const error = t.mock.method(logger, 'error', () => {});
      // The handler's own response: dispatch() drops a HEAD body, and the body is what is checked.
      const out = res();
      await controller.downloadDocument(req({ method: 'HEAD' }), out);
      assert.equal(out.statusCode, 500, backend);
      assert.deepEqual(JSON.parse(out.body), { error: 'Failed to generate download link.' }, backend);
      assert.ok(error.mock.calls.some(c =>
        c.arguments[0] === `[Document Controller] Presigned download failed: ${err.message}`), backend);
    }
  });

  await t.test('a key the store refuses as a name is a 404', async (t) => {
    allow(t);
    t.mock.method(storage, 'statObject', async () => {
      throw Object.assign(new Error('Invalid object name: x'), { name: 'InvalidObjectNameError' });
    });
    const out = res();
    await controller.downloadDocument(req({ method: 'HEAD' }), out);
    assert.equal(out.statusCode, 404);
    assert.deepEqual(JSON.parse(out.body), { error: 'Document has no stored file.' });
  });

  await t.test('a Content-Type that is not a media type is never passed through', async (t) => {
    const cases = [
      // The stored type is bad, the record's is good: the record's.
      { stat: 'application/pdf\r\nSet-Cookie: a=1', mimeType: 'application/pdf', want: 'application/pdf' },
      // Both bad: the safe default.
      { stat: 'pdf', mimeType: 'text/html\nX-Injected: 1', want: 'application/octet-stream' },
      // A parameter is part of a valid type and stays.
      { stat: 'text/plain; charset=utf-8', mimeType: 'pdf', want: 'text/plain; charset=utf-8' }
    ];
    for (const { stat, mimeType, want } of cases) {
      t.mock.restoreAll();
      allow(t, { doc: { ...DOC, mimeType } });
      t.mock.method(storage, 'statObject', async () => ({ size: 10, contentType: stat }));
      const out = await rawHead(PATH);
      assert.equal(out.status, 200);
      assert.equal(out.headers['content-type'], want, JSON.stringify(stat));
    }
  });

  await t.test('with no stat and no recorded size, no Content-Length is claimed', async (t) => {
    // The raw dispatch() result: a Response built from it could fill the header in on its own.
    allow(t);
    t.mock.method(storage, 'statObject', async () => { throw unreachable(); });
    t.mock.method(logger, 'warn', () => {});
    const out = await rawHead(PATH);
    assert.equal(out.status, 200);
    assert.ok(!('content-length' in out.headers), `content-length: ${out.headers['content-length']}`);
    assert.equal(out.headers['content-type'], 'application/octet-stream');
    assert.equal(out.body, undefined);
  });
});

test('download in stream mode: ?inline=1 without redirect=1', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const { downloadStreamMaxBytes, downloadStreamMaxConcurrent } = config;
  t.afterEach(() => Object.assign(config, { downloadStreamMaxBytes, downloadStreamMaxConcurrent }));

  const BYTES = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
  const PDF = { ...DOC, mimeType: 'application/pdf' };
  const STAT = {
    size: BYTES.length, contentType: 'application/pdf', etag: 'store-etag-1', versionId: 'v1',
    lastModified: new Date('2026-09-01T10:00:00Z')
  };
  const LAST_MODIFIED = 'Tue, 01 Sep 2026 10:00:00 GMT';
  const PATH = `/api/documents/${DOC.id}/download?inline=1`;
  const STAFF = { realm_access: { roles: ['staff'] } };

  /** A visible document with a stored object; returns the mocks a case may inspect. */
  function stored(t, { doc = PDF, stat = STAT } = {}) {
    const presign = allow(t, { doc });
    const statObject = t.mock.method(storage, 'statObject', async () => stat);
    const open = t.mock.method(storage, 'getObjectStream', async (key, { offset, length }) =>
      Readable.from([BYTES.subarray(offset, offset + length)]));
    return { presign, statObject, open };
  }

  /** One request through the dispatcher, body read whole. */
  async function get(headers = {}, path = PATH) {
    let out;
    await withServer(async (call) => {
      const r = await call(path, { headers });
      out = { res: r, body: Buffer.from(await r.arrayBuffer()) };
    });
    return out;
  }

  /**
   * The handler called directly, for a credentialed caller the dispatcher would need a token for.
   * The body is drained, so the stream's slot is free for the next case.
   */
  async function getAs(user, headers = {}) {
    const out = res();
    await controller.downloadDocument(req({ user, headers, query: { inline: '1' } }), out);
    if (out.streamed) await out.body.toArray();
    return out;
  }

  /** The handler called directly, stream left open: it holds a slot until destroyed. */
  async function holdOpen() {
    const out = res();
    await controller.downloadDocument(req({ query: { inline: '1' } }), out);
    assert.equal(out.statusCode, 200);
    return out.body;
  }

  await t.test('an anonymous public PDF answers 200 with the bytes and every header', async (t) => {
    const { open, presign } = stored(t);
    const { res: r, body } = await get();
    assert.equal(r.status, 200);
    assert.deepEqual(body, BYTES);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.equal(r.headers.get('content-length'), '4096');
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.equal(r.headers.get('last-modified'), LAST_MODIFIED);
    assert.match(r.headers.get('etag'), /^"[\w-]{32}"$/);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=300');
    assert.equal(r.headers.get('content-disposition'),
      'inline; filename="Site C Report.pdf"; filename*=UTF-8\'\'Site%20C%20Report.pdf');
    assert.equal(r.headers.get('location'), null);
    assert.equal(open.mock.calls[0].arguments[1].versionId, 'v1', 'bytes pinned to the stat version');
    assert.equal(presign.mock.callCount(), 0);
  });

  await t.test('the ETag changes with the file name, not only the bytes', async (t) => {
    stored(t);
    const before = (await get()).res.headers.get('etag');
    t.mock.restoreAll();
    stored(t, { doc: { ...PDF, documentFileName: 'Renamed.pdf' } });
    assert.notEqual((await get()).res.headers.get('etag'), before);
  });

  await t.test('Range bytes=0-1023 answers 206 with that slice', async (t) => {
    stored(t);
    const { res: r, body } = await get({ range: 'bytes=0-1023' });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 0-1023/4096');
    assert.equal(r.headers.get('content-length'), '1024');
    assert.deepEqual(body, BYTES.subarray(0, 1024));
  });

  await t.test('a suffix range answers the last bytes', async (t) => {
    stored(t);
    const { res: r, body } = await get({ range: 'bytes=-100' });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 3996-4095/4096');
    assert.deepEqual(body, BYTES.subarray(3996));
  });

  await t.test('a range running past the end is cut at the size', async (t) => {
    stored(t);
    const { res: r } = await get({ range: 'bytes=4000-9999' });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 4000-4095/4096');
  });

  await t.test('a range starting past the end is 416 with the size', async (t) => {
    const { open } = stored(t);
    const { res: r } = await get({ range: 'bytes=4096-' });
    assert.equal(r.status, 416);
    assert.equal(r.headers.get('content-range'), 'bytes */4096');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(open.mock.callCount(), 0);
  });

  await t.test('an inverted range is ignored: the whole file', async (t) => {
    stored(t);
    const { res: r } = await get({ range: 'bytes=5-3' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-length'), '4096');
  });

  await t.test('a multi-part range answers the whole file', async (t) => {
    stored(t);
    const { res: r, body } = await get({ range: 'bytes=0-9,20-29' });
    assert.equal(r.status, 200);
    assert.equal(body.length, 4096);
  });

  await t.test('an If-Range that no longer matches answers the whole file', async (t) => {
    stored(t);
    const { res: r } = await get({ range: 'bytes=0-9', 'if-range': '"stale-tag"' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-length'), '4096');
  });

  await t.test('an If-Range equal to Last-Modified keeps the range', async (t) => {
    stored(t);
    const { res: r } = await get({ range: 'bytes=0-9', 'if-range': LAST_MODIFIED });
    assert.equal(r.status, 206);
  });

  await t.test('a matching If-None-Match is 304 with the validators and no body', async (t) => {
    stored(t);
    const etag = (await get()).res.headers.get('etag');
    const { res: r, body } = await get({ 'if-none-match': `W/${etag}` });
    assert.equal(r.status, 304);
    assert.equal(r.headers.get('etag'), etag);
    assert.equal(r.headers.get('last-modified'), LAST_MODIFIED);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=300');
    assert.equal(body.length, 0);
  });

  await t.test('If-Modified-Since at Last-Modified is 304', async (t) => {
    const { open } = stored(t);
    const { res: r } = await get({ 'if-modified-since': LAST_MODIFIED });
    assert.equal(r.status, 304);
    assert.equal(open.mock.callCount(), 0);
  });

  await t.test('If-Modified-Since before Last-Modified sends the file', async (t) => {
    stored(t);
    const { res: r } = await get({ 'if-modified-since': 'Mon, 31 Aug 2026 10:00:00 GMT' });
    assert.equal(r.status, 200);
  });

  await t.test('a credentialed caller gets private, no-store', async (t) => {
    stored(t);
    const out = await getAs(STAFF);
    assert.equal(out.statusCode, 200);
    assert.equal(out.headers['cache-control'], 'private, no-store');
  });

  await t.test('a document hidden from an anonymous caller is a 404, no-store', async (t) => {
    t.mock.method(documents, 'getById',
      async (access) => (access.tier === TIER.PUBLIC ? null : { ...PDF, isPublished: false }));
    const statObject = t.mock.method(storage, 'statObject', async () => STAT);
    const { res: r } = await get();
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(statObject.mock.callCount(), 0);
  });

  await t.test('a file over the cap is the inline 302, no-store', async (t) => {
    config.downloadStreamMaxBytes = BYTES.length - 1;
    const { presign, open } = stored(t);
    t.mock.method(logger, 'info', () => {});
    const { res: r } = await get();
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), URL_WITH_DISPOSITION);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(presign.mock.calls[0].arguments[1].inlineType, 'application/pdf');
    assert.equal(open.mock.callCount(), 0);
  });

  await t.test('a cap of 0 is the 302 without asking the store', async (t) => {
    config.downloadStreamMaxBytes = 0;
    const { statObject } = stored(t);
    const { res: r } = await get();
    assert.equal(r.status, 302);
    assert.equal(statObject.mock.callCount(), 0);
  });

  await t.test('a type that may not open inline, like docx, is the attachment 302', async (t) => {
    const { presign, statObject } = stored(t, { doc: { ...DOC, s3Key: 'etl/site-c/report.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } });
    const { res: r } = await get();
    assert.equal(r.status, 302);
    assert.equal(presign.mock.calls[0].arguments[1].inlineType, null);
    assert.equal(statObject.mock.callCount(), 0);
  });

  await t.test('a failed stat is the 302, logged', async (t) => {
    stored(t);
    t.mock.method(storage, 'statObject', async () => { throw new Error('store down'); });
    const warn = t.mock.method(logger, 'warn', () => {});
    const { res: r } = await get();
    assert.equal(r.status, 302);
    assert.equal(warn.mock.callCount(), 1);
  });

  await t.test('a store that will not open the read is the 302 with no-store', async (t) => {
    stored(t);
    t.mock.method(storage, 'getObjectStream', async () => { throw new Error('refused'); });
    t.mock.method(logger, 'warn', () => {});
    const { res: r } = await get();
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('etag'), null);
  });

  await t.test('redirect=1&inline=1 is still the 302', async (t) => {
    const { open } = stored(t);
    const { res: r } = await get({}, `${PATH}&redirect=1`);
    assert.equal(r.status, 302);
    assert.equal(open.mock.callCount(), 0);
  });

  await t.test('the JSON mode answers no-store', async (t) => {
    stored(t);
    const { res: r } = await get({}, `/api/documents/${DOC.id}/download`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });

  await t.test('the JSON 404 answers no-store', async (t) => {
    t.mock.method(documents, 'getById', async () => null);
    const { res: r } = await get({}, `/api/documents/${DOC.id}/download`);
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });

  /** Analytics rows one request wrote. */
  async function events(headers) {
    sent.length = 0;
    await get(headers);
    await audit.flush();
    return sent.filter(r => r.stream === audit.EVENTS_STREAM);
  }

  await t.test('an unranged view writes one analytics event, marked inline', async (t) => {
    stored(t);
    const rows = await events({});
    assert.equal(rows.length, 1);
    assert.deepStrictEqual(rows[0].Detail, { inline: true });
  });

  await t.test('a range from byte 0 writes the event', async (t) => {
    stored(t);
    assert.equal((await events({ range: 'bytes=0-1023' })).length, 1);
  });

  await t.test('a range from mid-file writes no analytics event', async (t) => {
    stored(t);
    assert.equal((await events({ range: 'bytes=1024-2047' })).length, 0);
  });

  await t.test('a mid-file range of a document the public cannot see is still audited', async (t) => {
    // `bytes=1-` is all but one byte of the file: skipping its audit row would be a way around it.
    stored(t, { doc: { ...PDF, isPublished: false } });
    sent.length = 0;
    const out = await getAs(STAFF, { range: 'bytes=1-' });
    assert.equal(out.statusCode, 206);
    await audit.flush();
    assert.equal(sent.filter(r => r.stream === audit.EVENTS_STREAM).length, 0);
    assert.equal(sent.filter(r => r.stream === audit.AUDIT_STREAM).length, 1);
  });

  await t.test('a streamed document the public cannot see writes the audit row', async (t) => {
    stored(t, { doc: { ...PDF, isPublished: false } });
    sent.length = 0;
    const out = await getAs(STAFF);
    assert.equal(out.statusCode, 200);
    await audit.flush();
    const row = sent.find(r => r.stream === audit.AUDIT_STREAM);
    assert.deepStrictEqual(row.Detail, { displayName: 'Site C Report', inline: true });
  });

  await t.test('a record changed after the object moves Last-Modified', async (t) => {
    // A rename touches the record only; the edge revalidates by date, so the date must move.
    stored(t, { doc: { ...PDF, updatedAt: '2026-09-20T08:00:00.000Z' } });
    const { res: r } = await get({ 'if-modified-since': LAST_MODIFIED });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('last-modified'), 'Sun, 20 Sep 2026 08:00:00 GMT');
  });

  await t.test('an If-Modified-Since in the future is ignored', async (t) => {
    stored(t);
    const { res: r } = await get({ 'if-modified-since': 'Fri, 01 Jan 2100 00:00:00 GMT' });
    assert.equal(r.status, 200);
  });

  await t.test('an object with no modification date is the 302', async (t) => {
    const { open } = stored(t, { stat: { ...STAT, lastModified: null } });
    const { res: r } = await get();
    assert.equal(r.status, 302);
    assert.equal(open.mock.callCount(), 0);
  });

  await t.test('an object with no etag is the 302', async (t) => {
    const { open } = stored(t, { stat: { ...STAT, etag: null } });
    const { res: r } = await get();
    assert.equal(r.status, 302);
    assert.equal(open.mock.callCount(), 0);
  });

  await t.test('a file name the header cannot carry is the 302, with no read opened', async (t) => {
    // A lone surrogate, which encodeURIComponent throws on.
    const { open } = stored(t, { doc: { ...PDF, documentFileName: 'Report \uD83D draft.pdf' } });
    const warn = t.mock.method(logger, 'warn', () => {});
    const { res: r } = await get();
    assert.equal(r.status, 302);
    assert.equal(open.mock.callCount(), 0);
    assert.equal(warn.mock.callCount(), 1);
  });

  await t.test('an unversioned store pins the read to the stat etag', async (t) => {
    const { open } = stored(t, { stat: { ...STAT, versionId: null } });
    const { res: r } = await get();
    assert.equal(r.status, 200);
    assert.equal(open.mock.calls[0].arguments[1].ifMatch, 'store-etag-1');
    assert.equal(open.mock.calls[0].arguments[1].versionId, undefined);
  });

  await t.test('an object replaced between stat and read (412) is the 302', async (t) => {
    stored(t, { stat: { ...STAT, versionId: null } });
    t.mock.method(storage, 'getObjectStream', async () => {
      throw Object.assign(new Error('precondition failed'), { statusCode: 412, code: 'ConditionNotMet' });
    });
    t.mock.method(logger, 'warn', () => {});
    const { res: r } = await get();
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });

  await t.test('a store read with no bytes after 10 s is dropped for the 302', async (t) => {
    stored(t);
    const stalled = new Readable({ read() {} });
    let opened;
    const called = new Promise((resolve) => { opened = resolve; });
    t.mock.method(storage, 'getObjectStream', async () => { opened(); return stalled; });
    t.mock.method(logger, 'warn', () => {});
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const out = res();
      const pending = controller.downloadDocument(req({ query: { inline: '1' } }), out);
      await called;
      // setImmediate is not mocked: the open has settled as far as it can before time moves.
      await new Promise(resolve => setImmediate(resolve));
      t.mock.timers.tick(10000);
      await pending;
      assert.equal(out.statusCode, 302);
      assert.equal(stalled.destroyed, true, 'a stalled read would hold its store connection');
    } finally {
      t.mock.timers.reset();
    }
  });

  await t.test('at the stream cap the next viewer gets the 302 until a stream closes', async (t) => {
    config.downloadStreamMaxConcurrent = 1;
    const { open } = stored(t);
    t.mock.method(logger, 'info', () => {});
    const held = await holdOpen();

    const { res: capped } = await get();
    assert.equal(capped.status, 302);
    assert.equal(capped.headers.get('cache-control'), 'no-store');

    const source = await open.mock.calls[0].result;
    held.destroy();
    await once(source, 'close');
    assert.equal((await get()).res.status, 200);
  });

  await t.test('a 304 or a 416 takes no stream slot', async (t) => {
    config.downloadStreamMaxConcurrent = 1;
    const { open } = stored(t);
    assert.equal((await get({ 'if-modified-since': LAST_MODIFIED })).res.status, 304);
    assert.equal((await get({ range: 'bytes=9999-' })).res.status, 416);
    const held = await holdOpen();
    const source = await open.mock.calls[0].result;
    held.destroy();
    await once(source, 'close');
  });

  await t.test('viewers arriving together get one stream at a cap of 1, the rest the 302', async (t) => {
    // The open is slow, so all three are past the cap check before any read has started.
    config.downloadStreamMaxConcurrent = 1;
    stored(t);
    t.mock.method(storage, 'getObjectStream', async (key, { offset, length }) => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return Readable.from([BYTES.subarray(offset, offset + length)]);
    });
    t.mock.method(logger, 'info', () => {});
    const outs = [res(), res(), res()];
    await Promise.all(outs.map(out => controller.downloadDocument(req({ query: { inline: '1' } }), out)));
    assert.deepEqual(outs.map(out => out.statusCode).sort(), [200, 302, 302]);
    await Promise.all(outs.filter(out => out.streamed).map(out => out.body.toArray()));
  });
});
