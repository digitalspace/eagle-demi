'use strict';

/**
 * Typesense collection schemas for eagle-api search data.
 *
 * - Field weights mirror the MongoDB searchIndex_1 text index weights.
 * - Facet fields match the filter lists used by eagle-public's search UI.
 * - All non-id fields are optional so partial documents don't fail import.
 * - Dates are stored as int64 Unix timestamps (seconds) for range filtering.
 *
 * Schema names are used as both the Typesense collection name and the alias.
 * The alias is what the search controller queries — the nightly re-index
 * creates a new collection with a timestamp suffix and swaps the alias.
 */

const DOCUMENT_SCHEMA = {
  name: 'documents',
  default_sorting_field: 'popularity',
  token_separators: ['.', '_', '-'],
  fields: [
    { name: 'id',                 type: 'string' },
    // Search fields
    { name: 'displayName',        type: 'string',  index: true,  sort: true,  optional: true },
    { name: 'documentFileName',   type: 'string',  index: true,  optional: true },
    { name: 'description',        type: 'string',  index: true,  optional: true },
    { name: 'projectName',        type: 'string',  index: true,  sort: true,  optional: true },
    // Facet / filter fields
    { name: 'type',               type: 'string',  facet: true,  sort: true,  optional: true },
    { name: 'milestone',          type: 'string',  facet: true,  sort: true,  optional: true },
    { name: 'documentAuthorType', type: 'string',  facet: true,  optional: true },
    { name: 'projectPhase',       type: 'string',  facet: true,  optional: true },
    { name: 'legislation',        type: 'int32',   facet: true,  optional: true },
    { name: 'region',             type: 'string',  facet: true,  sort: true,  optional: true },
    // Metadata
    { name: 'projectId',          type: 'string',  facet: true,  optional: true },
    { name: 'internalExt',        type: 'string',               optional: true },
    { name: 'datePosted',         type: 'int64',   sort: true,   range_index: true,  optional: true },
    { name: 'dateUploaded',       type: 'int64',   sort: true,   range_index: true,  optional: true },
    // Featured flag — shown on project's Featured Documents tab
    { name: 'isFeatured',         type: 'bool',                  optional: true },
    // Source of the document (e.g. 'COMMENT', 'DOCUMENT') — used as a filter
    { name: 'documentSource',     type: 'string',  facet: true,  optional: true },
    // 30-day click/download score — updated nightly by popularity-sync.js (0 = unscored)
    { name: 'popularity',         type: 'int32',   sort: true },  // must be non-optional for default_sorting_field
    // Access control — roles that may see this document (mirrors MongoDB read array)
    { name: 'allowed_roles',      type: 'string[]', facet: true,  optional: true },
    // [lat, lng] centroid geopoint inherited from parent project
    { name: 'centroid',           type: 'geopoint',              optional: true },
  ],
};

const PROJECT_SCHEMA = {
  name: 'projects',
  default_sorting_field: 'popularity',
  fields: [
    { name: 'id',               type: 'string' },
    { name: 'name',             type: 'string',  index: true,  sort: true,  optional: true },
    { name: 'displayName',      type: 'string',  index: true,  optional: true },
    { name: 'description',      type: 'string',  index: true,  optional: true },
    { name: 'epicProjectId',    type: 'string',  index: true,  optional: true },
    // Filter + facet fields
    { name: 'region',           type: 'string',  facet: true,  sort: true,  optional: true },
    { name: 'status',           type: 'string',  facet: true,  optional: true },
    { name: 'currentPhaseName', type: 'string',  facet: true,  sort: true,  optional: true },
    { name: 'eacDecision',      type: 'string',  facet: true,  sort: true,  optional: true },
    { name: 'type',             type: 'string',  facet: true,  sort: true,  optional: true },
    { name: 'sector',           type: 'string',  facet: true,  optional: true },
    { name: 'location',         type: 'string',               optional: true },
    // Proponent name stored for display / search
    { name: 'proponent',        type: 'string',  index: true,  sort: true,  optional: true },
    { name: 'updatedDate',      type: 'int64',   sort: true,   range_index: true,  optional: true },
    { name: 'decisionDate',     type: 'int64',   sort: true,   range_index: true,  optional: true },
    // [lat, lng] centroid geopoint for map and proximity search
    { name: 'centroid',         type: 'geopoint',              optional: true },
    // Administrative boundaries fields
    { name: 'regionalDistrict',  type: 'string',  facet: true,  optional: true },
    { name: 'electoralDistrict', type: 'string',  facet: true,  optional: true },
    { name: 'municipality',      type: 'string',  facet: true,  optional: true },
    // 30-day click score — updated nightly by popularity-sync.js (0 = unscored)
    { name: 'popularity',       type: 'int32',   sort: true },  // must be non-optional for default_sorting_field
    // Access control — roles that may see this project (mirrors MongoDB read array)
    { name: 'allowed_roles',    type: 'string[]', facet: true,  optional: true },
  ],
};

const DOCUMENT_CHUNKS_SCHEMA = {
  name: 'document_chunks',
  fields: [
    { name: 'id',           type: 'string' },
    // Search field — indexed for full-text search
    { name: 'content',      type: 'string',  index: true },
    // Grouping / filtering — indexed
    { name: 'documentId',   type: 'string',  facet: true },
    { name: 'projectId',    type: 'string',  facet: true },
    { name: 'pageNumber',   type: 'int32',   sort: true },
    // Facet / filter fields — searched by queryBy weights
    { name: 'documentType', type: 'string',  facet: true,  index: true,  optional: true },
    { name: 'milestone',    type: 'string',  facet: true,  index: true,  optional: true },
    { name: 'datePosted',   type: 'int64',   sort: true,   range_index: true,  optional: true },
    { name: 'region',       type: 'string',  facet: true,  optional: true },
    // Display + search fields
    { name: 'chunkIndex',   type: 'int32',   index: false, optional: true },
    { name: 'documentName', type: 'string',  index: true,  sort: true,   optional: true },
    { name: 'projectName',  type: 'string',  index: true,  optional: true },
    // Access control — inherited from parent document's read array
    { name: 'allowed_roles',  type: 'string[]', facet: true,  optional: true },
    // [lat, lng] centroid geopoint inherited from parent project
    { name: 'centroid',       type: 'geopoint',              optional: true },
    // Future: embedding field for vector/AI search
    // { name: 'embedding', type: 'float[]', num_dim: 768, optional: true },
  ],
};

/** Map _schemaName → Typesense schema */
const SCHEMAS = {
  Document:            DOCUMENT_SCHEMA,
  Project:             PROJECT_SCHEMA,
  DocumentChunk:       DOCUMENT_CHUNKS_SCHEMA,
};

/**
 * Query_by fields and their weights for each schema, used in search requests.
 * Weights mirror the MongoDB searchIndex_1 weights.
 */
const QUERY_BY = {
  Document: {
    fields:  'displayName,documentFileName,description,projectName',
    weights: '8500,5000,8000,3000',
  },
  Project: {
    fields:  'name,displayName,description,epicProjectId,proponent',
    weights: '9000,8500,8000,3000,1000',
  },
  DocumentChunk: {
    fields:  'content',
    weights: '9000',
  },
};

/**
 * Facet fields to include in every search response, keyed by schemaName.
 */
const FACET_BY = {
  Document:            'type,milestone,documentAuthorType,projectPhase,legislation,documentSource,region',
  Project:             'region,status,currentPhaseName,eacDecision,type,sector,regionalDistrict,electoralDistrict,municipality',
  DocumentChunk:       'documentType,projectId,region',
};

module.exports = { SCHEMAS, QUERY_BY, FACET_BY };
