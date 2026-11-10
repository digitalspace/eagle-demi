'use strict';

// Shared by the download controller suites: a readable document, its stored object, and requests.

const assert = require('node:assert');
const { Readable } = require('stream');
const storage = require('../../src/storage');
const documents = require('../../src/repositories/documents');
const controller = require('../../src/controllers/nosql/document');
const { makeRes } = require('../../src/http/router');
const { withServer } = require('./with-server');

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

const BYTES = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
const PDF = { ...DOC, mimeType: 'application/pdf' };
const STAT = {
  size: BYTES.length, contentType: 'application/pdf', etag: 'store-etag-1', versionId: 'v1',
  lastModified: new Date('2026-09-01T10:00:00Z')
};
const LAST_MODIFIED = 'Tue, 01 Sep 2026 10:00:00 GMT';
const PATH = `/api/documents/${DOC.id}/download?inline=1`;

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

/** The handler called directly, stream left open: it holds a slot until destroyed. */
async function holdOpen() {
  const out = res();
  await controller.downloadDocument(req({ query: { inline: '1' } }), out);
  assert.equal(out.statusCode, 200);
  return out.body;
}

module.exports = {
  URL_WITH_DISPOSITION, DOC, req, res, allow,
  BYTES, PDF, STAT, LAST_MODIFIED, PATH, stored, get, holdOpen
};
