'use strict';

/**
 * Document controller — Cosmos NoSQL.
 *
 * The ACL rule that matters: a document can never out-rank its parent project. That is
 * enforced in one place (resolveDocumentAcl) and used by every write path — the Mongo version
 * had it in createDocument only, so an upload through the intake route could be published
 * under a private project.
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const storage = require('../../storage');

const documents = require('../../repositories/documents');
const projects = require('../../repositories/projects');
const chunks = require('../../repositories/chunks');
const { chunkMarkdown } = require('../../chunker');
const { resolveAccess, systemAccess, SECURE_ROLES } = require('../../helpers/access-sql');
// Required as a module rather than destructured so the call is interceptable in tests —
// otherwise a unit test would open a real Typesense connection and burn its retry schedule.
const typesenseClient = require('../../typesense/typesenseClient');

// Presigned links carry no auth of their own — anyone holding the URL can fetch the object
// until it expires, so keep the window short.
const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

/**
 * Resolve a new document's ACL. Fail closed, and never let a document out-rank its parent.
 * EVERY document write path must go through this.
 */
function resolveDocumentAcl(parentProject, isPublished) {
  const requested = isPublished === true || isPublished === 'true';
  const parentIsPublic = Array.isArray(parentProject.read) && parentProject.read.length > 0
    ? parentProject.read.includes('public')
    : parentProject.isPublished === true;
  const published = requested && parentIsPublic;

  return {
    published,
    read: published ? ['public', ...SECURE_ROLES] : [...SECURE_ROLES]
  };
}

exports.getDocuments = async (req, res) => {
  try {
    const access = resolveAccess(req);

    // `extracted` is opt-in and tri-state: absent means "don't filter". Only the exact strings
    // are honoured, so a typo cannot silently become `false` and hide the extracted corpus.
    let extracted;
    if (req.query.extracted === 'false') extracted = false;
    if (req.query.extracted === 'true') extracted = true;

    const { items, continuationToken } = await documents.listVisible(access, {
      projectId: req.query.project,
      extracted,
      pageSize: Math.min(parseInt(req.query.pageSize || '1000', 10), 5000),
      continuationToken: req.query.continuationToken
    });

    if (continuationToken) res.setHeader('x-continuation-token', continuationToken);
    return res.json(items);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.getDocument = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const doc = await documents.getById(access, req.params.id, req.query.project);

    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }
    return res.json(doc);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

/**
 * Short-lived presigned download URL, gated by the same visibility rule as the metadata — a
 * caller who cannot see the document must not be able to fetch its bytes.
 */
exports.downloadDocument = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const doc = await documents.getById(access, req.params.id, req.query.project);

    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }
    if (!doc.s3Key) {
      return res.status(404).json({ error: 'Document has no stored file.' });
    }

    const fileName = doc.s3Key.split('/').pop();
    // The storage layer owns key resolution and expiry. It used to be done here, with the
    // client borrowed from the extraction script — which is how extract.js came to read keys
    // without the environment prefix while this path applied it.
    const url = await storage.getDownloadUrl(doc.s3Key, {
      expirySeconds: DOWNLOAD_URL_TTL_SECONDS,
      fileName
    });

    return res.json({
      url,
      expiresIn: DOWNLOAD_URL_TTL_SECONDS,
      fileName,
      displayName: doc.displayName || null
    });
  } catch (err) {
    console.error('[Document Controller] Presigned download failed:', err.message);
    return res.status(500).json({ error: 'Failed to generate download link.' });
  }
};

exports.createDocument = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const { project, displayName, s3Key, region, edrmsRecordNumber, orcsClassification, isPublished } = req.body;

    if (!project || !displayName || !s3Key) {
      return res.status(400).json({ error: 'Missing required fields: project, displayName, s3Key' });
    }

    const parentProject = await projects.getById(access, project);
    if (!parentProject) {
      return res.status(404).json({ error: `Parent Project with id ${project} not found.` });
    }

    const acl = resolveDocumentAcl(parentProject, isPublished);
    const now = new Date().toISOString();

    const saved = await documents.upsert({
      id: crypto.randomUUID(),
      projectId: String(project),
      sourceSystem: 'demi',
      displayName,
      s3Key,
      region: region || parentProject.region || '',
      edrmsRecordNumber: edrmsRecordNumber || '',
      orcsClassification: orcsClassification || '',
      read: acl.read,
      isPublished: acl.published,
      isDeleted: false,
      contentExtracted: false,
      createdAt: now,
      updatedAt: now
    });

    return res.status(201).json(saved);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.extractDocument = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const file = req.file;
    const { project, displayName, region, edrmsRecordNumber, orcsClassification, isPublished } = req.body;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }
    if (!project) {
      if (file.path) fs.promises.unlink(file.path).catch(() => {});
      return res.status(400).json({ error: 'A valid project id is required.' });
    }

    const parentProject = await projects.getById(access, project);
    if (!parentProject) {
      if (file.path) fs.promises.unlink(file.path).catch(() => {});
      return res.status(404).json({ error: `Parent Project with id ${project} not found.` });
    }

    const fileExtension = file.originalname.match(/\.([0-9a-z]+$)/i)?.[1] || '';
    const randomizedName = crypto.randomBytes(16).toString('hex') + (fileExtension ? '.' + fileExtension : '');
    const objectPath = path.posix.join(project.toString(), randomizedName);

    // `objectPath` is recorded as-is: the storage layer may store it under an environment
    // prefix, but the metadata must stay environment-independent or the record breaks when
    // copied between environments.
    await storage.putFile(objectPath, file.path, file.mimetype);
    fs.promises.unlink(file.path).catch(() => {});

    const acl = resolveDocumentAcl(parentProject, isPublished);
    const now = new Date().toISOString();

    const saved = await documents.upsert({
      id: crypto.randomUUID(),
      projectId: String(project),
      sourceSystem: 'demi',
      displayName: displayName || file.originalname,
      s3Key: objectPath,
      fileExt: (fileExtension || 'pdf').toLowerCase(),
      region: region || parentProject.region || '',
      edrmsRecordNumber: edrmsRecordNumber || '',
      orcsClassification: orcsClassification || '',
      read: acl.read,
      isPublished: acl.published,
      // Written as explicit defaults so downstream filters are equalities. Mongo's
      // {$ne: true} matched missing fields; SQL `!= true` does not, and translating that
      // literally would make the extractor silently process nothing.
      isDeleted: false,
      contentExtracted: false,
      createdAt: now,
      updatedAt: now
    });

    return res.status(202).json({
      message: 'File stored. Text extraction runs on the next scheduled extraction pass.',
      docId: String(saved.id)
    });
  } catch (err) {
    if (req.file && req.file.path) fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
};

exports.updateDocument = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const existing = await documents.getById(access, req.params.id, req.query.project);
    if (!existing) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // projectId is the partition key — reassigning it would be a delete-and-reinsert.
    const { id: _ignoredId, projectId: _ignoredPk, ...changes } = req.body;

    const saved = await documents.upsert({
      ...existing,
      ...changes,
      id: existing.id,
      projectId: existing.projectId,
      updatedAt: new Date().toISOString()
    });

    return res.json(saved);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

/**
 * Publish or unpublish. This is how a document is hidden from the public and from
 * proponents — deletion is for genuine removal, not for hiding.
 */
exports.setDocumentPublished = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const existing = await documents.getById(access, req.params.id, req.query.project);
    if (!existing) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const published = req.body.isPublished === true || req.body.isPublished === 'true';
    const parentProject = await projects.getById(access, existing.projectId);

    // A document still cannot out-rank its parent: publishing under a private project is a
    // no-op that would otherwise silently expose it.
    if (published && parentProject && !resolveDocumentAcl(parentProject, true).published) {
      return res.status(409).json({
        error: 'Cannot publish a document whose project is not published.'
      });
    }

    const updated = await documents.setPublished(
      existing.id, existing.projectId, published, SECURE_ROLES
    );
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

/**
 * Permanently remove the document record and its search-index entry.
 *
 * The stored file is deliberately left in place — no request path may destroy a source
 * document. Orphaned blobs are reclaimed by a separate audited job.
 *
 * The index entry is removed explicitly rather than through the change feed, which emits no
 * deletes in latest-version mode. That is also why no soft-delete marker is needed.
 */
exports.deleteDocument = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const existing = await documents.getById(access, req.params.id, req.query.project);
    if (!existing) {
      return res.status(404).json({ error: 'Document not found' });
    }

    await documents.deleteById(existing.id, existing.projectId);

    // The document's extracted text has to go with it. Without this the chunks survive in Cosmos
    // and the next nightly full sync re-indexes the complete text of a deleted document — the
    // exact thing "a chunk must never be findable when its document is not" forbids.
    let removedChunks = 0;
    try {
      const result = await chunks.removeForDocument(systemAccess(), existing.id);
      removedChunks = result.succeeded || 0;
    } catch (err) {
      console.error('[Document Controller] Chunk removal failed:', err.message);
    }

    // Best-effort: the record is already gone, and the nightly full sync reconciles the index
    // via alias swap, so a failure here must not turn a successful delete into a 500.
    const removedFromIndex = await typesenseClient.deleteFromIndex('documents', existing.id);
    const removedChunksFromIndex =
      await typesenseClient.deleteChunksForDocument(existing.id);

    return res.json({
      message: 'Document deleted successfully',
      deleted: existing,
      removedFromIndex,
      removedChunks,
      removedChunksFromIndex,
      // Stated in the response so it is obvious the file survives the record.
      storedFileRetained: Boolean(existing.s3Key)
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

/**
 * Ingest extracted text for a document: POST /documents/:id/chunks  { markdown }
 *
 * The extraction host sends MARKDOWN, not chunks. Splitting stays here so `src/chunker.js` remains
 * the single implementation — an external worker never decides how text is divided, and the
 * payload is the same size either way.
 *
 * It also never supplies an ACL. `read[]` is copied from the LIVE document on every call, so a
 * compromised or buggy extraction host cannot widen a document's visibility, and a chunk cannot
 * out-rank its parent. This is why the route takes a document id rather than chunk objects.
 *
 * Idempotent: chunk ids are deterministic and replaceForDocument reconciles, so re-posting the
 * same markdown is a no-op and a killed backfill can simply be restarted.
 */
exports.ingestChunks = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const doc = await documents.getById(access, req.params.id, req.query.project);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const { markdown, error } = req.body || {};

    // A failed extraction reports itself rather than going silent, so --retry-failed can find it.
    if (error) {
      await documents.patchExtraction(doc.id, doc.projectId, {
        contentExtracted: true,
        contentExtractedAt: new Date().toISOString(),
        contentPageCount: 0,
        contentExtractionError: String(error).slice(0, 500),
        extractionMethod: 'docling'
      });
      return res.json({ id: doc.id, chunks: 0, recordedError: true });
    }

    if (typeof markdown !== 'string') {
      return res.status(400).json({ error: 'markdown (string) or error (string) is required' });
    }

    const read = Array.isArray(doc.read) && doc.read.length > 0 ? doc.read : [...SECURE_ROLES];

    const items = chunkMarkdown(markdown).map(({ pageNumber, chunkIndex, content }) => ({
      id: chunks.chunkId(doc.id, pageNumber, chunkIndex),
      documentId: String(doc.id),
      projectId: String(doc.projectId),
      pageNumber,
      chunkIndex,
      content,
      read,
      extractedAt: new Date().toISOString()
    }));

    // systemAccess() so reconciliation sees every pre-existing chunk. A caller-scoped read could
    // miss chunks it may not see and then leave them orphaned behind the new set.
    const result = await chunks.replaceForDocument(systemAccess(), doc.id, items);

    // bulkVerified REPORTS partial failure, it does not throw. Ignoring `failed` is exactly the bug
    // that once reported 60,578 documents written when 56,317 landed — here it would mark a
    // document extracted while part of its text is missing, and the work list would never offer it
    // again. Record the failure and 500 so the worker retries the whole document.
    if (result && result.failed) {
      const detail = `chunk write incomplete: ${result.failed} of ${items.length} failed ` +
        `(${JSON.stringify(result.statusCounts)})`;
      await documents.patchExtraction(doc.id, doc.projectId, {
        contentExtractionError: detail.slice(0, 500)
      });
      return res.status(500).json({ error: detail });
    }

    await documents.patchExtraction(doc.id, doc.projectId, {
      contentExtracted: true,
      contentExtractedAt: new Date().toISOString(),
      contentPageCount: items.length,
      contentExtractionError: null,
      extractionMethod: 'docling'
    });

    return res.json({ id: doc.id, chunks: items.length });
  } catch (err) {
    console.error('[Document Controller] Chunk ingest failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

exports.resolveDocumentAcl = resolveDocumentAcl;
