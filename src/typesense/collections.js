'use strict';

/**
 * Typesense collection schemas for eagle-api & DEMI search data.
 */

const DOCUMENT_SCHEMA = {
  name: 'documents',
  default_sorting_field: 'popularity',
  token_separators: ['.', '_', '-'],
  fields: [
    { name: 'id',                 type: 'string' },
    { name: 'displayName',        type: 'string',  index: true,  sort: true,  optional: true },
    { name: 'documentFileName',   type: 'string',  index: true,  optional: true },
    { name: 'description',        type: 'string',  index: true,  optional: true },
    { name: 'projectName',        type: 'string',  index: true,  sort: true,  optional: true },
    { name: 'type',               type: 'string',  facet: true,  sort: true,  optional: true },
    { name: 'milestone',          type: 'string',  facet: true,  sort: true,  optional: true },
    { name: 'documentAuthorType', type: 'string',  facet: true,  optional: true },
    { name: 'projectPhase',       type: 'string',  facet: true,  optional: true },
    { name: 'legislation',        type: 'int32',   facet: true,  optional: true },
    { name: 'region',             type: 'string',  facet: true,  sort: true,  optional: true },
    { name: 'projectId',          type: 'string',  facet: true,  optional: true },
    { name: 'internalExt',        type: 'string',               optional: true },
    { name: 'datePosted',         type: 'int64',   sort: true,   range_index: true,  optional: true },
    { name: 'dateUploaded',       type: 'int64',   sort: true,   range_index: true,  optional: true },
    { name: 'isFeatured',         type: 'bool',                  optional: true },
    { name: 'documentSource',     type: 'string',  facet: true,  optional: true },
    { name: 'popularity',         type: 'int32',   sort: true },
    { name: 'allowed_roles',      type: 'string[]', facet: true,  optional: true },
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
    { name: 'region',           type: 'string',  facet: true,  sort: true,  optional: true },
    { name: 'status',           type: 'string',  facet: true,  optional: true },
    { name: 'currentPhaseName', type: 'string',  facet: true,  sort: true,  optional: true },
    { name: 'eacDecision',      type: 'string',  facet: true,  sort: true,  optional: true },
    { name: 'type',             type: 'string',  facet: true,  sort: true,  optional: true },
    { name: 'sector',           type: 'string',  facet: true,  optional: true },
    { name: 'location',         type: 'string',               optional: true },
    { name: 'proponent',        type: 'string',  index: true,  sort: true,  optional: true },
    { name: 'updatedDate',      type: 'int64',   sort: true,   range_index: true,  optional: true },
    { name: 'decisionDate',     type: 'int64',   sort: true,   range_index: true,  optional: true },
    { name: 'centroid',         type: 'geopoint',              optional: true },
    { name: 'regionalDistrict',  type: 'string',  facet: true,  optional: true },
    { name: 'electoralDistrict', type: 'string',  facet: true,  optional: true },
    { name: 'municipality',      type: 'string',  facet: true,  optional: true },
    { name: 'nrptiRecordCount',  type: 'int32',   sort: true,   optional: true },
    { name: 'popularity',       type: 'int32',   sort: true },
    { name: 'allowed_roles',    type: 'string[]', facet: true,  optional: true },
  ],
};

// Roughly 50 chunks per document, so this collection is ~3M rows against a ~60k-row `documents`
// collection — two orders of magnitude more. Typesense holds its index in RAM, so every `index`,
// `facet`, `sort` and `range_index` flag here is paid three million times over.
//
// Only `content` (query_by), `allowed_roles` (filter_by) and `documentId` (chunk cleanup on
// delete) are ever searched — see the DocumentChunk branch of src/controllers/search.js, which
// passes no sort_by and no facet_by. Everything else is display data the hit already carries, so
// it is stored and returned but not indexed. Re-adding a flag is one line and takes effect on the
// next full sync, so nothing here is a one-way door.
const DOCUMENT_CHUNKS_SCHEMA = {
  name: 'document_chunks',
  fields: [
    { name: 'id',           type: 'string' },
    { name: 'content',      type: 'string',  index: true },
    { name: 'documentId',   type: 'string',  facet: true },
    { name: 'projectId',    type: 'string',  index: false, optional: true },
    { name: 'pageNumber',   type: 'int32',   index: false, optional: true },
    { name: 'documentType', type: 'string',  index: false, optional: true },
    { name: 'milestone',    type: 'string',  index: false, optional: true },
    { name: 'datePosted',   type: 'int64',   index: false, optional: true },
    { name: 'region',       type: 'string',  index: false, optional: true },
    { name: 'chunkIndex',   type: 'int32',   index: false, optional: true },
    { name: 'documentName', type: 'string',  index: false, optional: true },
    { name: 'projectName',  type: 'string',  index: false, optional: true },
    { name: 'allowed_roles',  type: 'string[]', facet: true,  optional: true },
    // No `centroid` and no `embedding`: nothing geo-searches chunks, and an unpopulated
    // float[768] is a 3 KB/row liability the moment anyone fills it in — 9 GB across the corpus.
  ],
};

const RECORD_SCHEMA = {
  name: 'records',
  fields: [
    { name: 'id',               type: 'string' },
    { name: 'recordName',       type: 'string',  index: true,  sort: true },
    { name: 'recordType',       type: 'string',  facet: true,  optional: true },
    { name: 'nrptiSchemaName',  type: 'string',  facet: true,  optional: true },
    { name: 'issuingAgency',    type: 'string',  facet: true,  optional: true },
    { name: 'projectName',      type: 'string',  index: true,  optional: true },
    { name: 'issuedToName',     type: 'string',  index: true,  optional: true },
    { name: 'summary',          type: 'string',  index: true,  optional: true },
    { name: 'dateIssued',       type: 'int64',   sort: true,   range_index: true,  optional: true },
    { name: 'projectId',        type: 'string',  facet: true,  optional: true },
    { name: 'allowed_roles',    type: 'string[]', facet: true,  optional: true }
  ]
};

const SCHEMAS = {
  Document:            DOCUMENT_SCHEMA,
  Project:             PROJECT_SCHEMA,
  DocumentChunk:       DOCUMENT_CHUNKS_SCHEMA,
  Record:              RECORD_SCHEMA,
};

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
  Record: {
    fields:  'recordName,summary,projectName,issuedToName',
    weights: '9000,8000,5000,3000',
  }
};

const FACET_BY = {
  Document:            'type,milestone,documentAuthorType,projectPhase,legislation,documentSource,region',
  Project:             'region,status,currentPhaseName,eacDecision,type,sector,regionalDistrict,electoralDistrict,municipality',
  DocumentChunk:       'documentType,projectId,region',
  Record:              'nrptiSchemaName,issuingAgency,projectId',
};

module.exports = { SCHEMAS, QUERY_BY, FACET_BY };
