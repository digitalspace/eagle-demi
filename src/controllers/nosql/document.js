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
const config = require('../../config');
const extract = require('../../extract');

const documents = require('../../repositories/documents');
const projects = require('../../repositories/projects');
const { resolveAccess, SECURE_ROLES } = require('../../helpers/access-sql');
// Required as a module rather than destructured so the call is interceptable in tests —
// otherwise a unit test would open a real Typesense connection and burn its retry schedule.
const typesenseClient = require('../../typesense/typesenseClient');
const { resolveObjectKey } = require('../../storage/objectKey');

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

    const { items, continuationToken } = await documents.listVisible(access, {
      projectId: req.query.project,
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

    const minioClient = extract.getMinioClient();
    // The recorded key is relative to the prod bucket; non-prod buckets nest that copy one
    // level deeper. Without this the presigned URL is well-formed but 404s.
    const url = await minioClient.presignedGetObject(
      config.minioBucket,
      resolveObjectKey(doc.s3Key),
      DOWNLOAD_URL_TTL_SECONDS
    );

    return res.json({
      url,
      expiresIn: DOWNLOAD_URL_TTL_SECONDS,
      fileName: doc.s3Key.split('/').pop(),
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

    const minioClient = extract.getMinioClient();
    const exists = await minioClient.bucketExists(config.minioBucket);
    if (!exists) {
      await minioClient.makeBucket(config.minioBucket);
    }

    await minioClient.fPutObject(config.minioBucket, objectPath, file.path);
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

    // Best-effort: the record is already gone, and the nightly full sync reconciles the index
    // via alias swap, so a failure here must not turn a successful delete into a 500.
    const removedFromIndex = await typesenseClient.deleteFromIndex('documents', existing.id);

    return res.json({
      message: 'Document deleted successfully',
      deleted: existing,
      removedFromIndex,
      // Stated in the response so it is obvious the file survives the record.
      storedFileRetained: Boolean(existing.s3Key)
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.resolveDocumentAcl = resolveDocumentAcl;
