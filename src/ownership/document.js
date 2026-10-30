'use strict';

// Document fields DEMI owns. Kept out of domain/ so repositories may import it (test/domain/layering.test.js).

const { SYNC_OUT_FIELDS } = require('./sync-out');

/** Extraction state, which belongs to DEMI and has no upstream counterpart. */
const EXTRACTION_FIELDS = [
  'contentExtracted', 'contentExtractedAt', 'contentPageCount', 'contentExtractionError',
  // Page provenance: a re-seed replaces the row, and a dropped flag renders "Passage N" over paged chunks.
  'pageNumbered', 'pageCount',
  // Dropping the failure count lets a document that keeps failing re-enter the GPU queue on every push.
  'extraction', 'extractionMethod', 'chunkIngestFailures', 'chunkIngestFailedAt'
];

/**
 * What a rebuild from upstream must carry forward. `pdfTitle` is the only record of the stored PDF's
 * original title; `levelHeldAt` marks a DEMI takedown the next Eagle push must not republish.
 */
const DEMI_OWNED_FIELDS = [...EXTRACTION_FIELDS, 'pdfTitle', 'levelHeldAt', ...SYNC_OUT_FIELDS];

const OWNERS = Object.freeze({ demi: DEMI_OWNED_FIELDS });

/** A row DEMI or ENGAGE owns: sync-out sends it to Eagle, and Eagle's echo writes only its raw copy. */
const ownedOutsideEagle = row => Boolean(row) && (row.sourceSystem === 'demi' || row.sourceSystem === 'engage');

module.exports = { EXTRACTION_FIELDS, DEMI_OWNED_FIELDS, OWNERS, ownedOutsideEagle };
