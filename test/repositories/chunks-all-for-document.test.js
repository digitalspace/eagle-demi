'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const chunks = require('../../src/repositories/chunks');
const cosmos = require('../../src/db/cosmos-nosql');
const { systemAccess } = require('../../src/helpers/access-sql');

const row = (page) => ({
  id: `docB::p${page}::c0`, documentId: 'docB', projectId: '272',
  pageNumber: page, chunkIndex: 0, content: `page ${page} text`
});

test('chunks.allForDocument', async (t) => {
  await t.test('returns page order whatever order the container gave', async () => {
    // The container has no ORDER BY that survives paging, so the order is imposed after the fetch.
    // A shuffled document is invisible in the output and wrong in the extraction.
    t.mock.method(cosmos, 'query', async () =>
      ({ items: [row(7), row(1), row(3)], continuationToken: null }));

    const rows = await chunks.allForDocument(systemAccess(), 'docB');
    assert.deepStrictEqual(rows.map(r => r.pageNumber), [1, 3, 7]);
  });

  await t.test('follows the continuation token to the end of the partition', async () => {
    // Schedule B alone runs to hundreds of chunks against a 1,000-row page. Stopping at the first
    // page would summarise part of the document and report success.
    const pages = [
      { items: [row(1)], continuationToken: 'tok' },
      { items: [row(2)], continuationToken: null }
    ];
    t.mock.method(cosmos, 'query', async () => pages.shift());

    const rows = await chunks.allForDocument(systemAccess(), 'docB');
    assert.deepStrictEqual(rows.map(r => r.pageNumber), [1, 2]);
  });

  await t.test('reads one partition, pinned to the document', async () => {
    // Cross-partition would scan the whole 1.1M-chunk container to answer one document.
    let options = null;
    t.mock.method(cosmos, 'query', async (container, spec, opts) => {
      options = opts;
      return { items: [], continuationToken: null };
    });

    await chunks.allForDocument(systemAccess(), 'docB');
    assert.strictEqual(options.partitionKey, 'docB');
  });
});
