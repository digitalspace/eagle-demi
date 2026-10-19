'use strict';

// Fake document storage for the Update image cascade: documents whose level moves when
// `setPublished` is called, and the published updates `listShowingDocuments` answers.

const documents = require('../../src/repositories/documents');
const chunks = require('../../src/repositories/chunks');
const updates = require('../../src/repositories/updates');
const aiSearch = require('../../src/search/ai-search');
const { readForLevel, levelOfRead } = require('../../src/helpers/access-sql');

/**
 * @param {object} t the test context, for `t.mock`
 * @param {object[]} docs stored documents `{ id, projectId, level, documentSource }`
 * @param {{showing?: object[]|function, failPublish?: string}} [options] `showing` is the published
 *   updates, or a function of the call count; `failPublish` is an id whose move throws
 * @returns {{level: (id: string) => number, copied: string[]}} `copied` lists every id whose read
 *   was copied to the search index or the chunks
 */
function fakeImages(t, docs, { showing = [], failPublish } = {}) {
  const stored = new Map(docs.map(({ level, ...doc }) => [doc.id, { ...doc, read: readForLevel(level) }]));
  const copied = [];
  let showingCalls = 0;
  t.mock.method(documents, 'getById', async (access, id) => (stored.has(id) ? { ...stored.get(id) } : null));
  t.mock.method(documents, 'setPublished', async (id, projectId, level) => {
    if (id === failPublish) throw new Error('patch failed');
    stored.set(id, { ...stored.get(id), read: readForLevel(level) });
    return { ...stored.get(id) };
  });
  t.mock.method(aiSearch, 'writeAcls', async (index, rows) => { copied.push(...rows.map(row => row.id)); return 1; });
  t.mock.method(chunks, 'setAclForDocument', async (access, id) => { copied.push(id); return { succeeded: 0, failed: 0 }; });
  t.mock.method(updates, 'listShowingDocuments', async () =>
    (typeof showing === 'function' ? showing(++showingCalls) : showing));
  return { level: (id) => levelOfRead(stored.get(id).read), copied };
}

module.exports = { fakeImages };
