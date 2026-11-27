'use strict';

// An Eagle push replaces the row, so the backlog's retry clock must ride along or the sweep re-sends
// every pushed row the next day.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { transformDocument } = require('../../src/seed/transform');

const EAGLE_DOC = {
  _id: '58868f2be036fb0105767ea5',
  project: '588511a0aaecd9001b82316d',
  displayName: 'Hearing schedule',
  documentFileName: 'hearing.pdf',
  documentSource: 'PROJECT',
  read: ['public'],
  contentExtracted: false
};

test('an Eagle push of an extracted row keeps extractionQueuedAt', () => {
  const existing = {
    id: EAGLE_DOC._id,
    contentExtracted: true,
    contentExtractedAt: '2026-11-01T00:00:00.000Z',
    extractionQueuedAt: '2026-10-31T11:00:00.000Z'
  };
  const out = transformDocument(EAGLE_DOC, '207', new Map(), { now: '2026-11-27T00:00:00.000Z', existing });

  assert.strictEqual(out.extractionQueuedAt, '2026-10-31T11:00:00.000Z');
  assert.strictEqual(out.contentExtracted, true);
});
