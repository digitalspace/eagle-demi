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
const { chunkMarkdown, createChunkAccumulator } = require('../../chunker');
const {
  resolveAccess, systemAccess, pageSizeFor, readForLevel, levelOfRead
} = require('../../helpers/access-sql');
const { serverError } = require('../../helpers/response');
const aiSearch = require('../../search/ai-search');
const { purgeDocument } = require('../../helpers/purge');
const { logger } = require('../../utils/logger');
const { auditEvent, analyticsEvent } = require('../../utils/audit');
const { transformDocument, seedAcl } = require('../../seed/transform');
const { redactForAccess, redactAllForAccess, refusedWriteKeys } = require('../../vis/redact');

// Presigned links carry no auth of their own — anyone holding the URL can fetch the object
// until it expires, so keep the window short.
const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

// Marks a request that arrived through the deprecated `published` alias. A symbol, so no request
// body can set it.
const LEGACY_PUBLISH = Symbol('legacy publish alias');

/**
 * Resolve a new document's ACL: admits at level 1 (docs/rbac-architecture.md §1, "Default on
 * admission is level 1"), capped at the parent's own level so a document can never out-rank
 * its project. EVERY document write path must go through this.
 */
function resolveDocumentAcl(parentProject) {
  const read = readForLevel(Math.min(1, levelOfRead(parentProject.read)));

  // `published` is READ OFF the capped read[] — read[] is authoritative, isPublished mirrors it.
  return { published: read.includes('public'), read };
}

exports.getDocuments = async (req, res) => {
  try {
    const access = resolveAccess(req);

    // `extracted` is opt-in and tri-state: absent means "don't filter". Only the exact strings
    // are honoured, so a typo cannot silently become `false` and hide the extracted corpus.
    let extracted;
    if (req.query.extracted === 'false') extracted = false;
    if (req.query.extracted === 'true') extracted = true;

    // Anonymous callers cap at ANON_MAX_PAGE_SIZE; authenticated ones keep the full ceiling.
    const { pageSize, error } = pageSizeFor(access, req.query.pageSize);
    if (error) return res.status(400).json({ error });

    const { items, continuationToken } = await documents.listVisible(access, {
      projectId: req.query.project,
      extracted,
      pageSize,
      continuationToken: req.query.continuationToken
    });

    if (continuationToken) res.setHeader('x-continuation-token', continuationToken);
    return res.json(redactAllForAccess('documents', items, access));
  } catch (err) {
    return serverError(res, err, 'document controller failed');
  }
};

exports.getDocument = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const doc = await documents.getById(access, req.params.id, req.query.project);

    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }
    return res.json(redactForAccess('documents', doc, access));
  } catch (err) {
    return serverError(res, err, 'document controller failed');
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

    analyticsEvent(req, {
      eventName: 'document.download',
      projectId: doc.projectId,
      documentId: doc.id
    });

    // A download of a document the public cannot see is an access to restricted material, which
    // is an audit question and not a usage statistic. Public downloads stay in the analytics
    // table only — recording every one of those for seven years is neither useful nor cheap.
    if (!doc.isPublished) {
      auditEvent(req, {
        action: 'document.download',
        targetType: 'document',
        targetId: doc.id,
        projectId: doc.projectId,
        detail: { displayName: doc.displayName || null }
      });
    }

    return res.json({
      url,
      expiresIn: DOWNLOAD_URL_TTL_SECONDS,
      fileName,
      displayName: doc.displayName || null
    });
  } catch (err) {
    logger.error(`[Document Controller] Presigned download failed: ${err.message}`);
    return res.status(500).json({ error: 'Failed to generate download link.' });
  }
};

exports.createDocument = async (req, res) => {
  try {
    const access = resolveAccess(req);
    // No `isPublished`: a create body cannot publish. Widening is `PUT /api/documents/:id/level`.
    const { project, displayName, s3Key, region, edrmsRecordNumber, orcsClassification } = req.body;

    if (!project || !displayName || !s3Key) {
      return res.status(400).json({ error: 'Missing required fields: project, displayName, s3Key' });
    }

    const parentProject = await projects.getById(access, project);
    if (!parentProject) {
      return res.status(404).json({ error: `Parent Project with id ${project} not found.` });
    }

    const acl = resolveDocumentAcl(parentProject);
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

    auditEvent(req, {
      action: 'document.create',
      targetType: 'document',
      targetId: saved.id,
      projectId: saved.projectId,
      detail: { displayName: saved.displayName, s3Key: saved.s3Key, isPublished: saved.isPublished }
    });

    return res.status(201).json(redactForAccess('documents', saved, access));
  } catch (err) {
    return serverError(res, err, 'document controller failed');
  }
};

exports.extractDocument = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const file = req.file;
    const { project, displayName, region, edrmsRecordNumber, orcsClassification } = req.body;

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

    const acl = resolveDocumentAcl(parentProject);
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

    // Same action as createDocument, not a `document.upload` of its own: this is the same thing
    // happening through a second door, and two action names would make "who created documents"
    // two queries that a reader has to remember to union. `via` is what separates them.
    auditEvent(req, {
      action: 'document.create',
      targetType: 'document',
      targetId: saved.id,
      projectId: saved.projectId,
      detail: { displayName: saved.displayName, isPublished: saved.isPublished, via: 'upload' }
    });

    return res.status(202).json({
      message: 'File stored. Text extraction runs on the next scheduled extraction pass.',
      docId: String(saved.id)
    });
  } catch (err) {
    if (req.file && req.file.path) fs.promises.unlink(req.file.path).catch(() => {});
    return serverError(res, err, 'document controller failed');
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
    //
    // `read` and `isPublished` are stripped too, and that is the security half: spreading the body
    // straight into the upsert let a writer set an arbitrary ACL, bypassing resolveDocumentAcl and
    // the 409 on PUT /documents/:id/published that stops a document being published under a
    // private project. Visibility changes go through that route, which enforces the parent.
    // `ownRead` goes with them: it is the pre-cascade ACL, so setting it by hand widens the
    // document the next time setAclForProject re-derives `read` from it.
    //
    // The Cosmos bookkeeping keys are dropped for a different reason, the same one as project.js:
    // a caller who GETs a document and PUTs the response back sends them, and they are catalogued
    // at maxVis 0 (or 2 for `_etag`), so the guard below would 400 an otherwise ordinary edit.
    const {
      id: _ignoredId, projectId: _ignoredPk,
      read: _ignoredRead, ownRead: _ignoredOwnRead, isPublished: _ignoredPublished,
      _rid: _ignoredRid, _self: _ignoredSelf, _attachments: _ignoredAttachments,
      _ts: _ignoredTs, _etag: _ignoredEtag,
      ...changes
    } = req.body;

    // A field the caller cannot SEE is a field they cannot set: the response is redacted, so
    // accepting a hidden key back would overwrite a value they were never shown
    // (docs/rbac-architecture.md §2 item 1). `vis` is refused at EVERY level — the dial map is
    // policy rather than content, and no route sets it yet.
    const refused = refusedWriteKeys('documents', changes, access, existing);
    if (refused.length) {
      return res.status(400).json({
        error: `Fields not writable by this caller: ${refused.join(', ')}`
      });
    }

    const saved = await documents.upsert({
      ...existing,
      ...changes,
      id: existing.id,
      projectId: existing.projectId,
      read: existing.read,
      isPublished: existing.isPublished,
      updatedAt: new Date().toISOString()
    });

    // Field names only — see the same call in project.js for why the values do not go in.
    auditEvent(req, {
      action: 'document.update',
      targetType: 'document',
      targetId: existing.id,
      projectId: existing.projectId,
      detail: {
        fields: Object.keys(changes),
        isPublishedFrom: existing.isPublished,
        isPublishedTo: saved.isPublished
      }
    });

    return res.json(redactForAccess('documents', saved, access));
  } catch (err) {
    return serverError(res, err, 'document controller failed');
  }
};

/**
 * Move a document to a ladder level (docs/rbac-architecture.md §1, "Widening is an act").
 *
 * The ONLY route that raises a document's level, and the only place a document is hidden from the
 * public — deletion is for genuine removal, not for hiding.
 */
exports.setLevel = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const { level, confirm, reason } = req.body || {};

    if (!Number.isInteger(level) || level < 1 || level > 4) {
      return res.status(400).json({
        error: 'level must be an integer 1-4. Level 0 is the sealed compartment and is not set here.'
      });
    }
    if (level === 4 && confirm !== true) {
      return res.status(400).json({ error: 'Publishing to level 4 requires "confirm": true.' });
    }
    if (level === 4 && !String(reason || '').trim()) {
      return res.status(400).json({ error: 'Publishing to level 4 requires a non-empty "reason".' });
    }

    const existing = await documents.getById(access, req.params.id, req.query.project);
    if (!existing) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const from = levelOfRead(existing.read);
    const parentProject = await projects.getById(access, existing.projectId);
    // A document still cannot out-rank its parent, and an unreadable parent fails closed. Only a
    // widen is checked: an unreachable project must never block hiding a document.
    if (level > from && level > (parentProject ? levelOfRead(parentProject.read) : 1)) {
      return res.status(409).json({
        error: 'Cannot raise a document above the level of its project.'
      });
    }

    // Pulling a record back from public is incident response, not a routine correction.
    const takedown = from === 4 && level < 4;
    if (takedown && !access.roles.includes('sysadmin')) {
      return res.status(403).json({
        error: 'Only sysadmin may pull a record back from level 4. See docs/takedown-runbook.md.'
      });
    }

    const published = level === 4;
    const updated = await documents.setPublished(existing.id, existing.projectId, level);

    // The highest-value row in the table: this is the call that changes who can see a document.
    // Before the chunk patch below, not after — the change is already applied by here and the
    // patch can return 500.
    auditEvent(req, {
      action: takedown ? 'record.takedown' : (level > from ? 'record.widen' : 'record.narrow'),
      targetType: 'document',
      targetId: existing.id,
      projectId: existing.projectId,
      detail: {
        from,
        to: level,
        // The alias's `confirm` is synthetic, so it is not a confirmation anybody made.
        confirmed: confirm === true && !req[LEGACY_PUBLISH],
        reason: reason || ''
      }
    });

    const acl = updated && Array.isArray(updated.read) && updated.read.length > 0
      ? updated.read
      : readForLevel(level);

    // No document LIST is a live read any more (#148), so without this the row stayed listed and
    // keyword-searchable under its old ACL until the indexer's next PT5M pass — the file was
    // hidden at once by the point read, its metadata was not. Best-effort and never fatal: the
    // Cosmos write is authoritative and has already landed.
    await aiSearch.writeAcls(aiSearch.indexes().documents, [
      { id: existing.id, read: acl, isPublished: published }
    ]);

    // The chunks carry a SNAPSHOT of this ACL, taken at ingest, and nothing else refreshes it.
    // Without this the extracted text of a document just made private stays readable — in Cosmos,
    // and in the AI Search index indefinitely, because unpublishing never advanced the chunks'
    // `_ts` and the indexer is a high-water mark. Patching them advances it.
    //
    // AFTER the document patch, deliberately: a failure here leaves the document private and its
    // chunks over-permissive, which the search gate now covers. The reverse order could leave the
    // document public while its chunks were locked down, which nothing covers.
    try {
      const chunkAcl = await chunks.setAclForDocument(systemAccess(), existing.id, acl);
      if (chunkAcl.failed > 0) {
        logger.error('[Document Controller] chunk ACL patch partially failed', {
          documentId: existing.id, ...chunkAcl
        });
        return res.status(500).json({
          success: false,
          error: 'Document visibility changed, but its extracted text was not fully updated.'
        });
      }
    } catch (aclErr) {
      // Surfaced, never swallowed: a half-applied ACL is worse than a failed one, because the
      // operator believes the document is restricted.
      logger.error('[Document Controller] chunk ACL patch failed', {
        documentId: existing.id, error: aclErr.message
      });
      return res.status(500).json({
        success: false,
        error: 'Document visibility changed, but its extracted text was not updated.'
      });
    }

    return res.json(redactForAccess('documents', updated, access));
  } catch (err) {
    return serverError(res, err, 'document controller failed');
  }
};

/**
 * Publish or unpublish. DEPRECATED — a thin alias for `setLevel`, kept because
 * eagle-admin-console still sends `{ isPublished }`. It goes through the same guards on purpose:
 * an alias that skipped them would be the way around the ladder.
 *
 * The `confirm` it synthesises satisfies the level-4 guard and nothing else: the marker on `req`
 * makes the audit row say `confirmed: false`, so a legacy publish is never filed as a confirmed
 * one. A body key would not do — the caller controls the body and could mislabel a real
 * confirmation.
 */
exports.setDocumentPublished = (req, res) => {
  const body = req.body || {};
  const published = body.isPublished === true || body.isPublished === 'true';
  logger.warn('[Document Controller] deprecated PUT /documents/:id/published — use PUT /:id/level', {
    documentId: req.params.id, isPublished: published
  });

  const reason = 'legacy PUT /documents/:id/published';
  req[LEGACY_PUBLISH] = true;
  req.body = published ? { level: 4, confirm: true, reason } : { level: 2, reason };
  return exports.setLevel(req, res);
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
// The four Eagle fields that are List ObjectId refs. eagle-api resolves the labels on its side
// and sends them by FIELD; transformDocument resolves by ObjectId, so the two are joined here.
const LIST_LABEL_FIELDS = ['type', 'milestone', 'projectPhase', 'documentAuthorType'];

function listLookupFrom(doc, labels) {
  const lookup = new Map();
  for (const field of LIST_LABEL_FIELDS) {
    if (doc[field] && labels && labels[field]) lookup.set(String(doc[field]), labels[field]);
  }
  return lookup;
}

/**
 * Receive one document pushed by eagle-api, keyed by its Eagle `_id`.
 *
 * The body carries the RAW Eagle record and `transformDocument` is the seed's own transform, so a
 * push and a re-seed produce the same row. Two things are NOT taken from the push: extraction
 * state, which is carried off the row already in Cosmos (an upsert replaces the item, and losing
 * it would orphan the chunks and re-queue the document through the GPU), and the ACL, which is
 * narrowed against the parent project's.
 */
exports.upsertFromEagle = async (req, res) => {
  try {
    const eagleId = String(req.params.eagleId);
    const doc = req.body && req.body.doc;
    if (!doc || String(doc._id || '') !== eagleId) {
      return res.status(400).json({ error: 'body.doc._id must match the :eagleId in the path' });
    }

    // systemAccess on both reads: the push is a mirror, so a private parent and a private existing
    // row must both be visible to it.
    const parentEagleId = String((doc.project && doc.project._id) || doc.project || '');
    const parent = parentEagleId
      ? await projects.getByEagleId(systemAccess(), parentEagleId)
      : null;
    if (!parent) {
      return res.status(404).json({ error: 'Parent project not found' });
    }

    const existing = await documents.getById(systemAccess(), eagleId);
    const row = transformDocument(
      doc, parent.id, listLookupFrom(doc, req.body.labels),
      { existing, projectRead: parent.read }
    );
    // The cascade restores a narrowed ACL from `ownRead` (documents.setAclForProject), so the
    // push must carry the unconstrained Eagle ACL. A re-seed drops it deliberately; this does not.
    row.ownRead = seedAcl(doc.read);
    const saved = await documents.upsert(row);

    // A document that moved project lands in a NEW partition and Cosmos leaves the old row behind,
    // still listable under the old project's ACL. The index key is the same id, so the next
    // indexer pass replaces that entry — only the stale Cosmos row needs removing. Chunks are
    // partitioned by documentId and do not move.
    if (existing && String(existing.projectId) !== saved.projectId) {
      await documents.deleteById(existing.id, existing.projectId);
    }

    auditEvent(req, {
      action: 'document.push',
      targetType: 'document',
      targetId: saved.id,
      projectId: saved.projectId,
      detail: {
        eagleId,
        isPublishedFrom: existing ? existing.isPublished : null,
        isPublishedTo: saved.isPublished
      }
    });

    // Same rule as setDocumentPublished: no document list is a live read (#148), so a row whose
    // visibility just changed stays listed under its old ACL until the indexer's next PT5M pass.
    // Only on a change, and only against an existing row — a document DEMI has never seen has no
    // index row to correct, and a metadata edit does not move the ACL.
    if (existing && saved.isPublished !== existing.isPublished) {
      await aiSearch.writeAcls(aiSearch.indexes().documents, [
        { id: saved.id, read: saved.read, isPublished: saved.isPublished }
      ]);
    }

    return res.json({ id: saved.id, projectId: saved.projectId, action: 'upsert' });
  } catch (err) {
    return serverError(res, err, 'document controller failed');
  }
};

exports.deleteDocument = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const existing = await documents.getById(access, req.params.id, req.query.project);
    if (!existing) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Chunks and both index entries go with the row — nothing sweeps them later.
    const {
      removedChunks, removedFromSearch, removedChunksFromSearch, storedFileRetained
    } = await purgeDocument(existing);

    // Recorded after the cleanup calls so the row carries what actually happened to the search
    // index and the chunks, not what was intended. The stored file survives the record, and the
    // audit row says so — that asymmetry is the thing someone will ask about later.
    auditEvent(req, {
      action: 'document.delete',
      targetType: 'document',
      targetId: existing.id,
      projectId: existing.projectId,
      detail: {
        displayName: existing.displayName,
        removedChunks,
        removedFromSearch,
        removedChunksFromSearch,
        storedFileRetained
      }
    });

    return res.json({
      message: 'Document deleted successfully',
      deleted: redactForAccess('documents', existing, access),
      removedChunks,
      removedChunksFromSearch,
      removedFromSearch,
      // Stated in the response so it is obvious the file survives the record.
      storedFileRetained
    });
  } catch (err) {
    return serverError(res, err, 'document controller failed');
  }
};

/** Paths the router can take. Anything else is recorded as 'unknown' rather than trusted. */
const EXTRACTION_PATHS = ['ocr', 'text'];

/**
 * Normalise the optional `extraction` provenance from the extraction host.
 *
 * Whitelisted and length-capped for the same reason the ACL is never taken from this payload: the
 * host is a separate, externally-run process, and this object is written verbatim onto a document
 * that the API then serves. An unbounded `options` blob would also be an unbounded write — Cosmos
 * bills by document size, and a runaway field would be paid for on every read of that document.
 *
 * Returns null when there is nothing usable, so callers can omit the field entirely rather than
 * writing an empty object that later reads as "provenance recorded".
 */
function sanitizeExtraction(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

  const out = {
    // An unrecognised path is 'unknown', NOT dropped: knowing the host claimed something we do not
    // understand is worth more than silently recording nothing.
    path: EXTRACTION_PATHS.includes(raw.path) ? raw.path : 'unknown',
    engine: str(raw.engine, 60),
    doclingVersion: str(raw.doclingVersion, 40),
    // Free-form knobs, but bounded. JSON.stringify so a nested object cannot smuggle in depth.
    options: raw.options === undefined ? undefined : String(JSON.stringify(raw.options)).slice(0, 500),
    at: str(raw.at, 40) || new Date().toISOString()
  };

  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key];
  }
  return out;
}

/**
 * Chunks per bulk call on the streaming path. The whole point is that peak memory follows chunk
 * size, not document size, so this is what actually bounds it: ~200 chunks of ~2500 characters is
 * roughly half a megabyte in flight regardless of whether the document is 1 MB or 600 MB.
 */
const STREAM_BATCH_CHUNKS = 200;

/**
 * Ingest extracted text as an NDJSON stream: POST /documents/:id/chunks
 * with `Content-Type: application/x-ndjson`.
 *
 *   {"extraction": {...}}          <- line 1, the same provenance object the JSON path takes
 *   "first markdown block\n..."    <- lines 2..n, JSON-ENCODED markdown blocks
 *
 * WHY THIS EXISTS. The JSON path buffers the whole document: a 63 MB markdown parses to a 63 MB JS
 * string plus parser buffer on a B1 Basic instance with 1.75 GB and a single worker, so
 * `express.json`'s 10 MB limit 413s it and raising that limit only moves the ceiling. Measured on
 * this corpus, 15 documents already exceed it — docling renders them as one enormous table, the
 * largest 2,198 lines averaging 28,817 characters — and the roadmap is ~300K documents, so this is
 * a class rather than an outlier. Here nothing larger than one batch is ever held.
 *
 * Blocks are JSON-encoded per line because a markdown paragraph contains newlines and an NDJSON
 * line cannot. The host splits on the SAME `/\n{2,}/` boundary `chunkMarkdown` uses, and both
 * paths share `createChunkAccumulator`, so a document chunks identically whichever door it came
 * through.
 *
 * Failure is deliberately not partial-success: a batch that fails records the error and 500s
 * WITHOUT patching `contentExtracted`, so the work list still offers the document. `bulkVerified`
 * reports partial failure rather than throwing — ignoring `failed` is the bug that once reported
 * 60,578 documents written when 56,317 landed — so it is checked per batch, not once at the end.
 */
async function ingestChunksStreaming(req, res, doc) {
  const readline = require('readline');

  const read = Array.isArray(doc.read) && doc.read.length > 0 ? doc.read : readForLevel(2);
  const acc = createChunkAccumulator();
  const keepIds = [];
  let provenance = null;
  let batch = [];
  let seenHeader = false;

  // Flushes INSIDE the loop, not after it. One markdown block can be megabytes — measured on this
  // corpus, a 30 MB document with only 5 blank lines splits into ~6 blocks of ~5 MB, and each one
  // emits well over a thousand chunks in a single call. Checking the batch bound between blocks
  // instead of between chunks made the bound follow BLOCK size, which is exactly the thing that
  // cannot be relied on, and the worker died on that document six times before this was found.
  // Returns an error string on partial failure, null on success.
  const collect = async (emitted) => {
    for (const { pageNumber, chunkIndex, content } of emitted) {
      const id = chunks.chunkId(doc.id, pageNumber, chunkIndex);
      keepIds.push(id);
      batch.push({
        id,
        documentId: String(doc.id),
        projectId: String(doc.projectId),
        pageNumber,
        chunkIndex,
        content,
        read,
        extractedAt: new Date().toISOString()
      });
      if (batch.length >= STREAM_BATCH_CHUNKS) {
        const err = await flush();
        if (err) return err;
      }
    }
    return null;
  };

  // Returns an error string on partial failure, null on success. Never throws on a bulk shortfall,
  // because the caller has to record it against the document before answering.
  const flush = async () => {
    if (batch.length === 0) return null;
    const sending = batch;
    batch = [];
    const result = await chunks.upsertBatch(systemAccess(), doc.id, sending);
    if (result && result.failed) {
      return `chunk write incomplete: ${result.failed} of ${sending.length} failed ` +
        `(${JSON.stringify(result.statusCounts)})`;
    }
    return null;
  };

  const fail = async (status, message) => {
    // Recorded on the document, not just returned: a 500 the host retries is fine, but a silent
    // shortfall that leaves the document looking extracted is the failure mode this guards.
    if (status >= 500) {
      await documents.patchExtraction(doc.id, doc.projectId, {
        contentExtractionError: message.slice(0, 500)
      });
    }
    return res.status(status).json({ error: message });
  };

  const rl = readline.createInterface({ input: req.stream, crlfDelay: Infinity });
  let lineNo = 0;

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      lineNo++;

      if (!seenHeader) {
        seenHeader = true;
        let header;
        try {
          header = JSON.parse(line);
        } catch {
          return fail(400, 'line 1 must be a JSON object of stream metadata');
        }
        if (!header || typeof header !== 'object' || Array.isArray(header)) {
          return fail(400, 'line 1 must be a JSON object of stream metadata');
        }
        provenance = sanitizeExtraction(header.extraction);
        continue;
      }

      let block;
      try {
        block = JSON.parse(line);
      } catch {
        return fail(400, `line ${lineNo} is not valid JSON`);
      }
      if (typeof block !== 'string') {
        return fail(400, `line ${lineNo} must be a JSON-encoded string`);
      }

      const batchErr = await collect(acc.push(block));
      if (batchErr) return fail(500, batchErr);
    }
  } finally {
    rl.close();
  }

  if (!seenHeader) {
    return fail(400, 'empty stream: expected a metadata line');
  }

  const tailErr = await collect(acc.end());
  if (tailErr) return fail(500, tailErr);
  const err = await flush();
  if (err) return fail(500, err);

  // Only now is the surviving set knowable. Without this a re-extraction yielding fewer chunks
  // leaves orphans, and AI Search never sees deletes.
  const surplus = await chunks.deleteSurplus(systemAccess(), doc.id, keepIds);
  if (surplus && surplus.failed) {
    return fail(500, `surplus chunk delete incomplete: ${surplus.failed} failed ` +
      `(${JSON.stringify(surplus.statusCounts)})`);
  }

  await documents.patchExtraction(doc.id, doc.projectId, {
    contentExtracted: true,
    contentExtractedAt: new Date().toISOString(),
    contentPageCount: keepIds.length,
    contentExtractionError: null,
    extractionMethod: 'docling',
    ...(provenance ? { extraction: provenance } : {})
  });

  // One row per document, never per chunk: a full corpus re-extraction is ~60k documents against
  // ~1.13M chunks, and the audit question is "who replaced this document's content", not "which
  // chunk". Duplicated in the JSON path rather than hoisted into ingestChunks — this function and
  // its fail() both hand the same `res` back to the caller, so the caller cannot tell a completed
  // stream from a 500.
  auditEvent(req, {
    action: 'document.ingest',
    targetType: 'document',
    targetId: doc.id,
    projectId: doc.projectId,
    detail: { chunks: keepIds.length, streamed: true }
  });

  return res.json({ id: doc.id, chunks: keepIds.length, extraction: provenance || null,
    streamed: true });
}

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
 *
 * `extraction` is OPTIONAL provenance describing how the text was produced. It exists because the
 * extraction host routes each document — a `pypdfium2` text-layer probe keeps digital PDFs on a
 * CPU path and only sends text-poor ones to OCR (wiki: Extraction-Pipeline) — and that decision used to be
 * discarded. Without it, a text-layer artefact and an OCR error are indistinguishable after the
 * fact, so "the OCR is bad" cannot be evidenced or disproved. Absent on every row written before
 * this existed, which is itself the honest signal for "unknown path".
 */
exports.ingestChunks = async (req, res) => {
  try {
    const access = resolveAccess(req);
    const doc = await documents.getById(access, req.params.id, req.query.project);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // `express.json` only parses `application/json`, so an NDJSON body arrives here with the
    // request stream unread. That is what makes this a content-type switch rather than a new route.
    //
    // Guarded on `req.is` existing rather than called bare: Express always supplies it, but the
    // outer catch turns a bare TypeError here into a 500 that reads as a database fault, and it
    // would fire on every JSON ingest. Cheaper to ask than to debug.
    if (typeof req.is === 'function' && req.is('application/x-ndjson')) {
      return await ingestChunksStreaming(req, res, doc);
    }

    const { markdown, error, extraction } = req.body || {};
    const provenance = sanitizeExtraction(extraction);

    // A failed extraction reports itself rather than going silent, so --retry-failed can find it.
    // Provenance is recorded for failures too: which path failed is exactly what a retry policy
    // needs to know.
    if (error) {
      await documents.patchExtraction(doc.id, doc.projectId, {
        contentExtracted: true,
        contentExtractedAt: new Date().toISOString(),
        contentPageCount: 0,
        contentExtractionError: String(error).slice(0, 500),
        extractionMethod: 'docling',
        ...(provenance ? { extraction: provenance } : {})
      });
      // Audited like the two success paths below, because this one succeeds: it answers 200 and
      // leaves the document marked extracted with zero chunks. `outcome: 'failure'` is about the
      // extraction the caller reported, not about the request, and it is the state someone later
      // has to attribute — a document that looks processed and has no text.
      auditEvent(req, {
        action: 'document.ingest',
        outcome: 'failure',
        targetType: 'document',
        targetId: doc.id,
        projectId: doc.projectId,
        detail: { chunks: 0, recordedError: true, streamed: false }
      });

      return res.json({ id: doc.id, chunks: 0, recordedError: true });
    }

    if (typeof markdown !== 'string') {
      return res.status(400).json({ error: 'markdown (string) or error (string) is required' });
    }

    const read = Array.isArray(doc.read) && doc.read.length > 0 ? doc.read : readForLevel(2);

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

    // RU is the variable cost on a serverless account and nothing in the app was reading it, against
    // ~1.13M chunks. One line per ingested document is the cheapest baseline that can be read back
    // out of the log later; `ru` includes retries, because a retried write is billed twice.
    logger.info(`[chunk-ingest] doc=${doc.id} chunks=${items.length} ` +
      `ru=${Math.round(result.requestCharge || 0)}`);

    await documents.patchExtraction(doc.id, doc.projectId, {
      contentExtracted: true,
      contentExtractedAt: new Date().toISOString(),
      contentPageCount: items.length,
      contentExtractionError: null,
      extractionMethod: 'docling',
      ...(provenance ? { extraction: provenance } : {})
    });

    auditEvent(req, {
      action: 'document.ingest',
      targetType: 'document',
      targetId: doc.id,
      projectId: doc.projectId,
      detail: { chunks: items.length, streamed: false }
    });

    return res.json({ id: doc.id, chunks: items.length, extraction: provenance || null });
  } catch (err) {
    logger.error(`[Document Controller] Chunk ingest failed: ${err.message}`);
    return serverError(res, err, 'document controller failed');
  }
};

exports.resolveDocumentAcl = resolveDocumentAcl;
// Shared with controllers/nosql/sealed.js's own download route, so both quote the same TTL.
exports.DOWNLOAD_URL_TTL_SECONDS = DOWNLOAD_URL_TTL_SECONDS;
