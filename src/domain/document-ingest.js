'use strict';

const documents = require('../repositories/documents');
const chunks = require('../repositories/chunks');
const { systemAccess } = require('../helpers/access-sql');
const aiSearch = require('../search/ai-search');
const { logger } = require('../utils/logger');
const config = require('../config');

/** Paths the router can take. Anything else is recorded as 'unknown' rather than trusted. */
const EXTRACTION_PATHS = ['ocr', 'text'];

/**
 * The extraction host's optional provenance, allow-listed and length-capped: it comes from an
 * external process and is served back verbatim. Null when nothing is usable.
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

// Alerts match these two strings; keep them verbatim.
const CAP_REJECTED = 'chunk ingest rejected: chunk cap exceeded';
const REPEATED_REJECTED = 'chunk ingest rejected: repeated failures';

const INDEX_DELETE_INCOMPLETE = 'chunk ingest incomplete: search index delete failed, retry';

// A successful ingest also clears a failed purge's stamp: the chunks it described were replaced.
const INGEST_FAILURES_CLEARED = { chunkIngestFailures: 0, chunkIngestFailedAt: null, chunkPurgeFailedAt: null };

function capExceededMessage() {
  return `${CAP_REJECTED} (limit ${config.maxChunksPerDocument} chunks per document)`;
}

/** Consecutive chunk-ingest failures still inside the window; 0 once the last one has aged out. */
function recentIngestFailures(document) {
  const age = Date.now() - Date.parse(document.chunkIngestFailedAt);
  return age < config.chunkIngestFailureWindowMs ? (document.chunkIngestFailures || 0) : 0;
}

/**
 * Record a failed ingest on the document and count it toward the repeated-failure guard. Never
 * throws: a failure that cannot be recorded must not change the answer the caller gets.
 */
async function tryRecordIngestFailure(document, message, fields = {}) {
  try {
    // Read-then-write: overlapping failed requests can undercount, which only delays the lockout.
    await documents.patchExtraction(document.id, document.projectId, {
      ...fields,
      contentExtractionError: message.slice(0, 500),
      chunkIngestFailures: recentIngestFailures(document) + 1,
      chunkIngestFailedAt: new Date().toISOString()
    });
  } catch (err) {
    logger.warn('[Document Controller] chunk ingest failure not recorded', {
      documentId: document.id, error: err.message, stack: err.stack
    });
  }
}

/** Logged, never thrown: the ingest-failure alert matches this line. */
function logIngestFailure(document, message) {
  logger.error(`[Document Controller] Chunk ingest failed: ${message}`, { documentId: document.id });
}

/**
 * The success patch as two, since Cosmos caps a patch at ten operations. The done half goes last, so
 * a failed second patch leaves the document on the work list.
 */
async function recordIngested(ingest, document, found, done) {
  await documents.patchExtraction(document.id, document.projectId, found);
  await documents.patchExtraction(document.id, document.projectId, {
    contentExtracted: true,
    contentExtractedAt: new Date().toISOString(),
    contentExtractionError: null,
    ...INGEST_FAILURES_CLEARED,
    ...done
  });
  ingest.recorded = true;
}

/**
 * Undo an over-cap stream's batches, index rows first so a short index delete keeps the Cosmos
 * chunks for the retry to find (`{ indexIncomplete }`). Else returns the patch and any shortfall.
 */
async function removeOverCapChunks(document) {
  try {
    await aiSearch.deleteChunksForDocument(document.id, { strict: true });
  } catch (err) {
    logger.warn('[Document Controller] over-cap index delete incomplete', {
      documentId: document.id, error: err.message, stack: err.stack
    });
    return { indexIncomplete: err.message };
  }
  const shortfall = [];
  try {
    const removed = await chunks.removeForDocument(systemAccess(), document.id);
    if (removed && removed.failed) {
      logger.warn('[Document Controller] over-cap chunks not fully removed', {
        documentId: document.id, failed: removed.failed, statusCounts: removed.statusCounts
      });
      shortfall.push(`${removed.failed} chunks not removed`);
    }
  } catch (err) {
    logger.warn('[Document Controller] over-cap chunk removal failed', {
      documentId: document.id, error: err.message, stack: err.stack
    });
    shortfall.push('chunk removal failed');
  }
  return {
    stored: shortfall.join('; '),
    fields: { contentExtracted: false, contentPageCount: 0 }
  };
}

/**
 * The token a NEW chunk's parent values carry, so a walk running behind this ingest cannot overwrite
 * them: the row's pending token when it has one, else the ingest's start.
 */
function parentStampedAt(document, startedAt) {
  const token = document && document.parentFieldsPendingAt;
  return typeof token === 'string' ? token : startedAt;
}

module.exports = {
  sanitizeExtraction,
  CAP_REJECTED,
  REPEATED_REJECTED,
  INDEX_DELETE_INCOMPLETE,
  capExceededMessage,
  recentIngestFailures,
  tryRecordIngestFailure,
  logIngestFailure,
  recordIngested,
  removeOverCapChunks,
  parentStampedAt
};
