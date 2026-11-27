'use strict';

// The extraction queue's reads and stamps on `documents`, kept out of documents.js, which the size
// freeze (scripts/eslint-size-freeze.api.json) holds at its length.

const cosmos = require('../db/cosmos-nosql');
const { systemAccess } = require('../helpers/access-sql');
const { selectWhere, fetchAll, NOT_DELETED } = require('./_sql');
const {
  CONTAINER, PARTITION_FIELD, scanCleared, notUpdateImage, partitionKeyFor
} = require('./documents');

/** What `enqueueExtraction` checks its skip rules on, so a listed row passes them as a full one would. */
const EXTRACTION_BACKLOG_FIELDS = [
  'id', 'projectId', 'documentSource', 'scanStatus', 'isDeleted', 's3Key', 'contentExtracted'
];

/**
 * Each filter mirrors an enqueue skip rule, so a skipped row cannot hold a slot in every run. `_ts`:
 * ORDER BY drops rows lacking the field, and `_ts` is always present and indexed.
 */
async function listExtractionBacklog({ queuedBefore, max }) {
  const spec = selectWhere({
    access: systemAccess(),
    partitionField: PARTITION_FIELD,
    criteria: [
      scanCleared(), notUpdateImage(), NOT_DELETED,
      { clause: 'NOT (IS_BOOL(c.contentExtracted) AND c.contentExtracted = true)', params: [] },
      { clause: "IS_STRING(c.s3Key) AND c.s3Key != ''", params: [] },
      // A row with no `projectId` at all sits in no partition a patch can name.
      { clause: 'IS_DEFINED(c.projectId)', params: [] },
      {
        clause: '(NOT IS_STRING(c.extractionQueuedAt) OR c.extractionQueuedAt < @queuedBefore)',
        params: [{ name: '@queuedBefore', value: queuedBefore }]
      }
    ],
    select: `TOP @max ${EXTRACTION_BACKLOG_FIELDS.map(field => `c.${field}`).join(', ')}`,
    orderBy: 'c._ts ASC'
  });
  spec.parameters.push({ name: '@max', value: max });
  return fetchAll(CONTAINER, spec);
}

/** Stamp when the row was last sent to the extraction queue; src/scripts/extraction-backlog.js waits a week on it. */
async function markExtractionQueued(id, projectId, queuedAt) {
  const partitionKey = partitionKeyFor(projectId);
  if (partitionKey === undefined) throw new TypeError(`[documents] ${id}: markExtractionQueued needs one projectId`);
  return cosmos.patch(CONTAINER, String(id), partitionKey, [
    { op: 'set', path: '/extractionQueuedAt', value: queuedAt }
  ]);
}

module.exports = { listExtractionBacklog, markExtractionQueued };
