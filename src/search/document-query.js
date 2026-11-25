'use strict';

/**
 * Index clauses every `documents` index read shares, compat `/search` and native `/documents` alike.
 */

const { filterFor, quote } = require('../helpers/access-odata');
const documents = require('../repositories/documents');
const aiSearch = require('./ai-search');
const { logger } = require('../utils/logger');

const { UPDATE_SOURCE, isScanCleared } = documents;

// A partly loaded repository (a require cycle) would render `ne 'undefined'` and let update images through.
if (typeof UPDATE_SOURCE !== 'string') {
  throw new Error('[document-query] UPDATE_SOURCE did not load; check for a require cycle');
}

/**
 * The visibility clause for the `documents` index: a document-scoped credential's ids live in `id`
 * here and in `documentId` on chunks, so the two indexes never share one clause.
 */
const documentsAcl = access => filterFor(access, 'projectId', 'id');

/**
 * Leaves out images uploaded through the Update form: they show on their Update only. `ne` rather
 * than `eq 'PROJECT'`, because legacy rows hold '' or nothing and `null ne 'UPDATE'` is true.
 */
const NOT_UPDATE_IMAGE = `documentSource ne ${quote(UPDATE_SOURCE)}`;

/** Leaves out rows Eagle deleted. `null ne true` is true, so rows indexed before the field still match. */
const NOT_DELETED_DOCUMENT = 'isDeleted ne true';

// The columns `demi-documents-ds` selects as `c.<name>`, unchanged.
const PLAIN_COLUMNS = [
  'id', 'displayName', 'documentFileName', 'description', 'type', 'typeId', 'milestoneId', 'projectPhaseId',
  'documentAuthorTypeId', 'milestone', 'projectPhase', 'documentAuthorType', 'legislation', 'datePosted',
  'projectId', 'read', 'isPublished', 'documentSource', 'isFeatured', 'displayNameSort', 'sortOrder', 'fileSize'
];
const SEARCH_VIS_FIELDS = ['displayName', 'documentFileName', 'description'];

/** The SELECT's dial test: a missing dial allows every level, an integer allows up to its value. */
const dialAllows = (vis, field, level) => vis?.[field] === undefined || (Number.isInteger(vis[field]) && vis[field] >= level);

/**
 * The `documents` index row `demi-documents-ds` would project from this Cosmos row, or null when its
 * WHERE leaves the row out. A Cosmos projection drops an undefined property, so this does too.
 */
function documentIndexRow(row) {
  if (!row || !isScanCleared(row)) return null;
  const out = {};
  for (const name of PLAIN_COLUMNS) if (row[name] !== undefined) out[name] = row[name];
  if (row.documentFileName !== undefined) out.fileNameTokens = row.documentFileName;
  if (row.displayName !== undefined) out.displayNameTokens = row.displayName;
  if (row.description !== undefined) out.descriptionTokens = row.description;
  // Cosmos LOWER is proven equal to toLowerCase on ASCII only; any other author waits for the indexer.
  if (typeof row.documentAuthor === 'string' && /^[\x20-\x7e]*$/.test(row.documentAuthor)) {
    out.documentAuthorSort = row.documentAuthor.toLowerCase();
  }
  out.searchVis = [4, 3, 2, 1, 0].find(level => SEARCH_VIS_FIELDS.every(f => dialAllows(row.vis, f, level))) ?? -1;
  out.isDeleted = row.isDeleted === true;
  return out;
}

/**
 * Writes rows into the `documents` index now: staff lists page there, ahead of the indexer. Each is
 * read back first, so a write that landed after the caller's is not undone with an older read or ACL.
 */
async function indexDocumentsNow(rows) {
  if (!aiSearch.config().configured) return 0;
  try {
    const stored = await Promise.all(rows.map(row => documents.readForWrite(row.id, row.projectId)));
    const indexRows = stored.map(documentIndexRow).filter(Boolean);
    return indexRows.length ? await aiSearch.upsertIndexRows(aiSearch.indexes().documents, indexRows) : 0;
  } catch (err) {
    logger.error('[document-query] index write skipped; the indexer adds the rows', { error: err.message, stack: err.stack });
    return 0;
  }
}

module.exports = { documentsAcl, NOT_UPDATE_IMAGE, NOT_DELETED_DOCUMENT, documentIndexRow, indexDocumentsNow };
