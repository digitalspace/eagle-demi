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
const { resolveAccess, systemAccess, SECURE_ROLES } = require('../../helpers/access-sql');
const aiSearch = require('../../search/ai-search');
const { logger } = require('../../utils/logger');

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

    // Best-effort, and the ONLY thing that removes this document from search: the indexer's
    // high-water mark never sees a delete, so without these two calls a deleted document stays
    // findable — by name, and by its text — indefinitely. A failure here must still not turn a
    // successful delete into a 500, so it is reported in the response instead.
    const removedFromSearch =
      await aiSearch.deleteFromIndex(aiSearch.indexes().documents, existing.id);

    // AI Search is NOT the same "best-effort" as Typesense above, and the difference matters.
    // Typesense has a nightly full sync that reconciles whatever this misses; the AI Search
    // indexer runs on a high-water mark over `_ts`, which cannot see deletes AT ALL (measured:
    // a run immediately after a hard delete processed 0 items). This call is the only thing that
    // removes the text of a deleted document from search. It still must not fail the request —
    // the record is already gone — so the client is told what happened instead.
    const removedChunksFromSearch = await aiSearch.deleteChunksForDocument(existing.id);

    return res.json({
      message: 'Document deleted successfully',
      deleted: existing,
      removedChunks,
      removedChunksFromSearch,
      removedFromSearch,
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
 *
 * `extraction` is OPTIONAL provenance describing how the text was produced. It exists because the
 * extraction host routes each document — a `pypdfium2` text-layer probe keeps digital PDFs on a
 * CPU path and only sends text-poor ones to OCR (MIGRATION.md §A) — and that decision used to be
 * discarded. Without it, a text-layer artefact and an OCR error are indistinguishable after the
 * fact, so "the OCR is bad" cannot be evidenced or disproved. Absent on every row written before
 * this existed, which is itself the honest signal for "unknown path".
 */
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

  const read = Array.isArray(doc.read) && doc.read.length > 0 ? doc.read : [...SECURE_ROLES];
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

  const rl = readline.createInterface({ input: req, crlfDelay: Infinity });
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

  return res.json({ id: doc.id, chunks: keepIds.length, extraction: provenance || null,
    streamed: true });
}

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

    return res.json({ id: doc.id, chunks: items.length, extraction: provenance || null });
  } catch (err) {
    console.error('[Document Controller] Chunk ingest failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

exports.resolveDocumentAcl = resolveDocumentAcl;
