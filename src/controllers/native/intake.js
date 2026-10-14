'use strict';

/**
 * `POST /intake/uploads`: start one document upload through the intake account. Creates the
 * document row as `pending` with an empty `read[]`, and answers a 15-minute write-only link for
 * `incoming/<documentId>`. Defender scans the upload and src/intake/handler.js releases or rejects it.
 * `GET /intake/uploads/:id`: that upload's scan status.
 */

const crypto = require('crypto');
const path = require('path');
const config = require('../../config');
const documents = require('../../repositories/documents');
const projects = require('../../repositories/projects');
const blobs = require('../../intake/blobs');
const store = require('../../intake/store');
const { resolveAccess, capRead, readForLevel, levelOfRead } = require('../../helpers/access-sql');
const { naturalSortKey } = require('../../helpers/natural-sort');
const { serverError } = require('../../helpers/response');
const { auditEvent } = require('../../utils/audit');
const { logger } = require('../../utils/logger');

const UPLOAD_LINK_SECONDS = 15 * 60;
const MAX_FILE_NAME = 255;
const BODY_KEYS = new Set(['projectId', 'fileName', 'requestedRead']);

const isText = value => typeof value === 'string' && value.trim() !== '';
const DISABLED = { error: 'Document intake is not enabled in this environment.' };

/** The body's error, or null. */
function refusal(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'A JSON object body is required.';
  const unknown = Object.keys(body).filter(key => !BODY_KEYS.has(key));
  if (unknown.length > 0) return `Unknown body parameter: ${unknown.join(', ')}`;
  if (!isText(body.projectId)) return 'projectId is required.';
  if (!isText(body.fileName) || body.fileName.length > MAX_FILE_NAME) {
    return `fileName is required, at most ${MAX_FILE_NAME} characters.`;
  }
  const { requestedRead } = body;
  if (requestedRead === undefined) return null;
  if (!Array.isArray(requestedRead) || !requestedRead.every(isText)) {
    return 'requestedRead must be an array of role names.';
  }
  // Sealing and publishing each have their own route with its own checks; intake does neither.
  const level = levelOfRead(requestedRead);
  if (level === 0 || level === 4) {
    return 'requestedRead cannot seal or publish. Use the sealed routes or PUT /api/documents/{id}/level.';
  }
  return null;
}

/** `.PDF` -> `pdf`; empty when the name has no plain extension. */
function extensionOf(fileName) {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

exports.createUpload = async (req, res) => {
  try {
    if (!config.intake.storageAccount) {
      return res.status(503).json(DISABLED);
    }
    const body = req.body;
    const refused = refusal(body);
    if (refused) return res.status(400).json({ error: refused });

    const access = resolveAccess(req);
    const projectId = body.projectId.trim();
    const parentProject = await projects.getById(access, projectId);
    if (!parentProject) {
      return res.status(404).json({ error: `Parent Project with id ${projectId} not found.` });
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    // Signed before the row exists, so a signing failure leaves no pending row for the sweep.
    const uploadUrl = await blobs.staging().getUploadUrl(id, { expirySeconds: UPLOAD_LINK_SECONDS, now });
    const expiresAt = new Date(now + UPLOAD_LINK_SECONDS * 1000).toISOString();

    const fileName = body.fileName.trim();
    const createdAt = new Date(now).toISOString();
    // Applied on release. Admitted at level 1 when absent, like every other create; never above the project.
    const requestedRead = capRead(body.requestedRead || readForLevel(1), parentProject.read);

    await documents.upsert({
      id,
      projectId,
      sourceSystem: 'demi',
      displayName: fileName,
      displayNameSort: naturalSortKey(fileName),
      fileExt: extensionOf(fileName),
      region: parentProject.region || '',
      edrmsRecordNumber: '',
      orcsClassification: '',
      read: [],
      isPublished: false,
      isDeleted: false,
      contentExtracted: false,
      scanStatus: 'pending',
      requestedRead,
      createdAt,
      updatedAt: createdAt
    }, { create: true });

    auditEvent(req, {
      action: 'document.create',
      targetType: 'document',
      targetId: id,
      projectId,
      detail: { displayName: fileName, via: 'intake' }
    });
    logger.info('[intake] upload link issued', { documentId: id, projectId, expiresAt });

    return res.status(201).json({ documentId: id, uploadUrl, expiresAt });
  } catch (err) {
    return serverError(res, err, 'intake upload failed');
  }
};

exports.getUpload = async (req, res) => {
  try {
    if (!config.intake.storageAccount) return res.status(503).json(DISABLED);
    const id = req.params.id;
    const notFound = () => res.status(404).json({ error: `Upload with id ${id} not found.` });

    // A pending or rejected row has an empty read[], so it is read past the ACL and gated on its project.
    const row = await store.findById(id);
    // No scanStatus = an ordinary document: this route must not become a second document read.
    if (!row || typeof row.scanStatus !== 'string') return notFound();
    if (!await projects.getById(resolveAccess(req), row.projectId)) return notFound();

    return res.status(200).json({
      documentId: row.id,
      scanStatus: row.scanStatus,
      scanRejectReason: row.scanRejectReason || null,
      scannedAt: row.scannedAt || null,
      createdAt: row.createdAt
    });
  } catch (err) {
    return serverError(res, err, 'intake upload status failed');
  }
};
