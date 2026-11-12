'use strict';

const { Readable } = require('node:stream');

const storage = require('../../src/storage');
const cosmos = require('../../src/db/cosmos-nosql');
const bulkDownloads = require('../../src/repositories/bulk-downloads');
const projects = require('../../src/repositories/projects');

const PROJECT = { id: '207', name: 'Site C Clean Energy' };

function doc(id, extra = {}) {
  return {
    id,
    projectId: PROJECT.id,
    displayName: `Document ${id}`,
    documentFileName: `${id}.pdf`,
    s3Key: `etl/${id}.pdf`,
    fileExt: 'pdf',
    fileSize: 10,
    mimeType: 'application/pdf',
    ...extra
  };
}

function job(docs, extra = {}) {
  return {
    id: 'job-1',
    status: 'queued',
    documentIds: docs.map(d => d.id),
    access: { authenticated: false, roles: [], level: 4 },
    requesterKey: '198.51.100.7',
    requesterId: '',
    documentCount: docs.length,
    createdAt: new Date().toISOString(),
    parts: [],
    ...extra
  };
}

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** Stub every worker dependency and hand back what each recorded. `docs` is what the manifest
 * read returns: a requested id left out is one this caller cannot see. */
function harness(t, { row, docs, getObjectStream, putObjectStream } = {}) {
  const patches = [];
  const uploads = new Map();
  const claims = [];
  const removed = [];
  const reads = [];
  const released = [];

  t.mock.method(bulkDownloads, 'getById', async () => row);
  // Snapshotted, because Cosmos serialises each patch as it is made and the worker keeps appending
  // to the same `parts` array — recording the reference would show every patch as the last one.
  t.mock.method(bulkDownloads, 'patch', async (id, fields) => {
    patches.push(JSON.parse(JSON.stringify(fields)));
    return fields;
  });
  // The terminal status writes are conditional (see the repository): true is "this worker still
  // owns the row", the ordinary case. A test about cancellation overrides it with false.
  t.mock.method(bulkDownloads, 'patchIfStatus', async (id, fields) => {
    patches.push(JSON.parse(JSON.stringify(fields)));
    return true;
  });
  // The claim, which is an etag-conditioned replace rather than a patch.
  t.mock.method(cosmos, 'replace', async (container, id, pk, item) => {
    claims.push(item);
    return item;
  });
  // REVERSED on purpose: a Cosmos `IN` query answers in whatever order it likes, so the worker has
  // to restore the requested order itself. Returning it already sorted would hide that entirely.
  t.mock.method(bulkDownloads, 'listDocumentsByIds', async (access, ids) => {
    reads.push(access);
    return (docs || []).filter(d => ids.includes(String(d.id))).reverse();
  });
  t.mock.method(projects, 'listByIds', async () => [PROJECT]);
  t.mock.method(bulkDownloads, 'releaseSlot', async key => { released.push(key); return true; });
  // The stamp every releaser competes for. True is "this worker claimed it", the ordinary case.
  t.mock.method(bulkDownloads, 'claimSlotRelease', async (id, at) => {
    patches.push({ slotReleasedAt: at });
    return true;
  });
  t.mock.method(storage, 'removeObject', async key => { removed.push(key); });
  t.mock.method(storage, 'putObjectStream', putObjectStream ||
    (async (key, stream) => { uploads.set(key, await collect(stream)); return key; }));
  t.mock.method(storage, 'getObjectStream', getObjectStream ||
    (async key => Readable.from([`bytes of ${key}`])));

  return {
    patches, uploads, claims, removed, reads, released,
    zipText: key => uploads.get(key).toString('latin1')
  };
}

// The one patch that flips the job's status; the metadata it names is patched separately.
const statusPatch = patches => patches.find(p => p.status) || {};
const readyPatch = patches => patches.find(p => p.partCount !== undefined) || {};

module.exports = { PROJECT, doc, job, harness, statusPatch, readyPatch };
