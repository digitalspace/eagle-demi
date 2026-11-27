'use strict';

/**
 * `POST /intake/uploads`: `pending` row with empty `read[]` plus a write-only link; Defender scans,
 * src/intake/handler.js releases or rejects. The two GETs answer scan status, one upload or a project's.
 */

const crypto = require('crypto');
const path = require('path');
const config = require('../../config');
const documents = require('../../repositories/documents');
const projects = require('../../repositories/projects');
const lists = require('../../repositories/lists');
const blobs = require('../../intake/blobs');
const store = require('../../intake/store');
const { UPLOAD_LINK_SECONDS } = require('../../intake/decision');
const { resolveAccess, canRead, capRead, readForLevel, levelOfRead } = require('../../helpers/access-sql');
const { naturalSortKey } = require('../../helpers/natural-sort');
const { serverError } = require('../../helpers/response');
const { refusedWriteKeys } = require('../../vis/redact');
const { resolveListLabel, toIsoOrNull } = require('../../seed/transform');
const { auditEvent } = require('../../utils/audit');
const { logger } = require('../../utils/logger');

const MAX_FILE_NAME = 255;
// Defender for Storage skips larger blobs, so they could never be scanned clean.
const MAX_INTAKE_BYTES = 2 * 1024 ** 3;
// eagle-api's cap on an Update image (api/helpers/updateImages.js).
const MAX_UPDATE_IMAGE_BYTES = 10 * 1024 * 1024;
const BODY_KEYS = new Set(['projectId', 'fileName', 'fileSize', 'requestedRead', 'publishOnRelease', 'fields']);
const DOCUMENT_SOURCES = Object.freeze(['PROJECT', 'PROJECT-NOTIFICATION', 'COMMENT', documents.UPDATE_SOURCE]);

/** The `fields` keys an upload may set; every other key is refused, whatever the caller may see. */
const INTAKE_FIELDS = Object.freeze([
  'documentFileName', 'displayName', 'documentSource', 'milestoneId', 'typeId', 'documentAuthorTypeId',
  'projectPhaseId', 'dateUploaded', 'datePosted', 'description', 'legislation', 'documentAuthor'
]);
const LIST_LABELS = Object.freeze({
  typeId: 'type', milestoneId: 'milestone', projectPhaseId: 'projectPhase', documentAuthorTypeId: 'documentAuthorType'
});
const DATE_FIELDS = ['dateUploaded', 'datePosted'];
const TEXT_FIELDS = ['description', 'documentAuthor'];
const NAME_FIELDS = ['documentFileName', 'displayName'];

const LIST_STATUSES = Object.freeze(['pending', 'rejected']);
const REJECTED_SHOWN_DAYS = 30;
const LIST_QUERY_KEYS = new Set(['projectId']);

const isText = value => typeof value === 'string' && value.trim() !== '';
const isName = value => isText(value) && value.length <= MAX_FILE_NAME;
const DISABLED = { error: 'Document intake is not enabled in this environment.' };

function requestedReadRefusal(requestedRead) {
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

/** The value's error for one allowed `fields` key, or null. */
function fieldValueRefusal(key, value) {
  if (NAME_FIELDS.includes(key) && !isName(value)) return `${key} must be text, at most ${MAX_FILE_NAME} characters.`;
  if (TEXT_FIELDS.includes(key) && typeof value !== 'string') return `${key} must be a string.`;
  if (DATE_FIELDS.includes(key) && value !== null && !toIsoOrNull(value)) return `${key} must be a date or null.`;
  if (key === 'legislation' && value !== null && !Number.isInteger(value)) return 'legislation must be a whole number or null.';
  if (key === 'documentSource' && !DOCUMENT_SOURCES.includes(value)) {
    return `documentSource must be one of ${DOCUMENT_SOURCES.join(', ')}.`;
  }
  return null;
}

/** The `fields` object's error, or null. The allow-list runs first; the PUT guards run on top of it. */
function fieldsRefusal(fields, access) {
  if (fields === undefined) return null;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return 'fields must be an object.';
  const unknown = Object.keys(fields).filter(key => !INTAKE_FIELDS.includes(key));
  if (unknown.length > 0) return `Fields not accepted on upload: ${unknown.join(', ')}`;
  const refused = refusedWriteKeys('documents', fields, access, undefined);
  if (refused.length > 0) return `Fields not writable by this caller: ${refused.join(', ')}`;
  // domain/documents badParentFieldTypes's rule; a native controller that writes res may not import domain/.
  const badTypes = Object.keys(LIST_LABELS).filter(key => Object.hasOwn(fields, key) &&
    fields[key] !== null && typeof fields[key] !== 'string');
  if (badTypes.length > 0) return `Fields must be a List id string or null: ${badTypes.join(', ')}`;
  for (const [key, value] of Object.entries(fields)) {
    const refusal = fieldValueRefusal(key, value);
    if (refusal) return refusal;
  }
  return null;
}

function fileSizeRefusal({ fileSize, fields }) {
  if (fileSize === undefined) return null;
  if (!Number.isInteger(fileSize) || fileSize < 0 || fileSize > MAX_INTAKE_BYTES) {
    return `fileSize must be a whole number of bytes, at most ${MAX_INTAKE_BYTES}.`;
  }
  if (fields && fields.documentSource === documents.UPDATE_SOURCE && fileSize > MAX_UPDATE_IMAGE_BYTES) {
    return `An Update image is at most ${MAX_UPDATE_IMAGE_BYTES} bytes.`;
  }
  return null;
}

/** The body's error, or null. */
function refusal(body, access) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'A JSON object body is required.';
  const unknown = Object.keys(body).filter(key => !BODY_KEYS.has(key));
  if (unknown.length > 0) return `Unknown body parameter: ${unknown.join(', ')}`;
  if (!isText(body.projectId)) return 'projectId is required.';
  if (!isName(body.fileName)) return `fileName is required, at most ${MAX_FILE_NAME} characters.`;
  if (body.publishOnRelease !== undefined && typeof body.publishOnRelease !== 'boolean') {
    return 'publishOnRelease must be true or false.';
  }
  return requestedReadRefusal(body.requestedRead) || fieldsRefusal(body.fields, access) || fileSizeRefusal(body);
}

/**
 * Whether the caller could read the row at `requestedRead`, as GET or PUT /documents/:id/level would
 * after release. `projectId` is passed because canRead checks it for scoped callers.
 */
function readableOnceReleased(projectId, requestedRead, access) {
  return canRead({ projectId, read: requestedRead }, access);
}

/** `.PDF` -> `pdf`; empty when the name has no plain extension. */
function extensionOf(fileName) {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

/** The allowed fields as stored: dates as ISO strings, each List id beside its label. */
async function storedFields(fields, access) {
  const out = { ...fields };
  for (const key of DATE_FIELDS) {
    if (Object.hasOwn(out, key)) out[key] = toIsoOrNull(out[key]);
  }
  const ids = Object.keys(LIST_LABELS).filter(key => out[key]).map(key => out[key]);
  if (ids.length === 0) return out;
  const rows = await lists.listByIds(access, ids, lists.KINDS.LIST);
  const names = new Map(rows.map(row => [String(row.id), row.name]));
  for (const [idKey, labelKey] of Object.entries(LIST_LABELS)) {
    if (Object.hasOwn(out, idKey)) out[labelKey] = resolveListLabel(out[idKey], names);
  }
  return out;
}

exports.createUpload = async (req, res) => {
  try {
    if (!config.intake.storageAccount) {
      return res.status(503).json(DISABLED);
    }
    const body = req.body;
    const access = resolveAccess(req);
    const refused = refusal(body, access);
    if (refused) return res.status(400).json({ error: refused });

    const projectId = body.projectId.trim();
    const parentProject = await projects.getById(access, projectId);
    if (!parentProject) {
      return res.status(404).json({ error: `Parent Project with id ${projectId} not found.` });
    }
    // Applied on release. Admitted at level 1 when absent, like every other create; never above the project.
    const requestedRead = capRead(body.requestedRead || readForLevel(1), parentProject.read);
    const publishOnRelease = body.publishOnRelease === true;
    // Release publishes without PUT /documents/:id/level, so the caller must pass that route's check now.
    if (publishOnRelease && !readableOnceReleased(projectId, requestedRead, access)) {
      return res.status(403).json({ error: 'This caller may not publish this document.' });
    }
    const fields = await storedFields(body.fields || {}, access);

    const id = crypto.randomUUID();
    const now = Date.now();
    // Signed before the row exists, so a signing failure leaves no pending row for the sweep.
    const uploadUrl = await blobs.staging().getUploadUrl(id, { expirySeconds: UPLOAD_LINK_SECONDS, now });
    const expiresAt = new Date(now + UPLOAD_LINK_SECONDS * 1000).toISOString();

    const fileName = body.fileName.trim();
    const displayName = fields.displayName || fileName;
    const createdAt = new Date(now).toISOString();

    await documents.upsert({
      documentFileName: fileName,
      region: parentProject.region || '',
      edrmsRecordNumber: '',
      orcsClassification: '',
      ...fields,
      // Server-set, after the caller's fields so none of them can be overridden.
      id,
      projectId,
      sourceSystem: 'demi',
      displayName,
      displayNameSort: naturalSortKey(displayName),
      fileExt: extensionOf(fileName),
      fileSize: body.fileSize === undefined ? null : body.fileSize,
      read: [],
      isPublished: false,
      isDeleted: false,
      contentExtracted: false,
      scanStatus: 'pending',
      requestedRead,
      publishOnRelease,
      publishRequestedBy: publishOnRelease ? ((req.user && req.user.preferred_username) || 'unknown') : null,
      createdAt,
      updatedAt: createdAt
    }, { create: true });

    auditEvent(req, {
      action: 'document.create',
      targetType: 'document',
      targetId: id,
      projectId,
      detail: { displayName, via: 'intake', publishOnRelease }
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

    // Read past the ACL: a pending or rejected row has an empty read[], so it is gated on its project.
    const row = await store.findById(id);
    // No scanStatus = an ordinary document: this route must not become a second document read.
    if (!row || typeof row.scanStatus !== 'string') return notFound();
    const access = resolveAccess(req);
    // A released row has its own read[]: the same check as GET /documents/:id, sealed rows included.
    const visible = Array.isArray(row.read) && row.read.length > 0
      ? canRead(row, access)
      : Boolean(await projects.getById(access, row.projectId));
    if (!visible) return notFound();

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

/** The only fields a listed upload answers: the rows are read past the ACL. */
function listedUpload(row) {
  return {
    id: row.id,
    displayName: row.displayName,
    scanStatus: row.scanStatus,
    scanRejectReason: row.scanRejectReason || null,
    publishRefused: row.publishRefused || null,
    createdAt: row.createdAt,
    scannedAt: row.scannedAt || null
  };
}

exports.listUploads = async (req, res) => {
  try {
    if (!config.intake.storageAccount) return res.status(503).json(DISABLED);
    const query = req.query || {};
    const unknown = Object.keys(query).filter(key => !LIST_QUERY_KEYS.has(key));
    if (unknown.length > 0) return res.status(400).json({ error: `Unknown query parameter: ${unknown.join(', ')}` });
    if (!isText(query.projectId)) return res.status(400).json({ error: 'projectId is required.' });

    const access = resolveAccess(req);
    const projectId = query.projectId.trim();
    if (!(await projects.getById(access, projectId))) return res.status(200).json([]);

    // Pending rows time out within hours, so one window covers both statuses.
    const since = new Date(Date.now() - REJECTED_SHOWN_DAYS * 24 * 3600 * 1000).toISOString();
    const rows = await store.listForProject(projectId, LIST_STATUSES, since);
    const readable = rows.filter(row => readableOnceReleased(row.projectId, row.requestedRead, access));
    return res.status(200).json(readable.map(listedUpload));
  } catch (err) {
    return serverError(res, err, 'intake upload list failed');
  }
};

exports.INTAKE_FIELDS = INTAKE_FIELDS;
exports.MAX_INTAKE_BYTES = MAX_INTAKE_BYTES;
