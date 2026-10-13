'use strict';

/**
 * Index clauses every `documents` index read shares, compat `/search` and native `/documents` alike.
 */

const { filterFor, quote } = require('../helpers/access-odata');
const { UPDATE_SOURCE } = require('../repositories/documents');

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

module.exports = { documentsAcl, NOT_UPDATE_IMAGE };
