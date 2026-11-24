'use strict';

// Containers answering a `SELECT c.a, c.b FROM c ...` read as Cosmos does: only the named columns
// come back, so a column the repository forgets to project is missing here too.

const cosmos = require('../../src/db/cosmos-nosql');

/** `rows` cut down to the columns `spec` selects; a SELECT this cannot project throws. */
function projected(rows, spec, label) {
  const select = /^SELECT (.+?) FROM c(?: |$)/s.exec(spec.query)[1];
  const columns = select.split(',').map(column => column.trim().replace(/^c\./, ''));
  if (!columns.every(column => /^\w+$/.test(column))) throw new Error(`${label}: cannot project ${select}`);
  return rows.map(row => Object.fromEntries(columns
    .filter(column => Object.hasOwn(row, column))
    .map(column => [column, structuredClone(row[column])])));
}

/** Mock `cosmos.query` over `rows`. WHERE is not run: pass the rows this caller's ACL admits. */
function storedDocuments(t, rows) {
  return t.mock.method(cosmos, 'query', async (container, spec) => {
    if (container !== 'documents') throw new Error(`stored-documents: unexpected container ${container}`);
    return { items: projected(rows, spec, 'stored-documents') };
  });
}

/**
 * Mock the Cosmos reads over `rowsByContainer`. A `whole` container (a dataset's own read) answers
 * every row as stored; any other read is projected. WHERE is not run, as in `storedDocuments`.
 */
function storedContainers(t, rowsByContainer, { whole = [] } = {}) {
  // The credential lookup a keyed request makes reads `SELECT *`; no caller here holds one.
  const stored = { credentials: [], ...rowsByContainer };
  const answer = (container, spec) => {
    if (!Object.hasOwn(stored, container)) throw new Error(`stored-containers: unexpected container ${container}`);
    const rows = stored[container];
    if (/^SELECT VALUE COUNT\(1\) /.test(spec.query)) return { items: [rows.length] };
    const asStored = whole.includes(container) || container === 'credentials';
    return { items: asStored ? structuredClone(rows) : projected(rows, spec, 'stored-containers') };
  };
  t.mock.method(cosmos, 'query', async (container, spec) => answer(container, spec));
  t.mock.method(cosmos, 'queryFirst', async (container, spec) => answer(container, spec).items[0] ?? null);
  t.mock.method(cosmos, 'queryPage', async (container, spec) => answer(container, spec).items);
}

/** A public document whose own dials keep its display name and milestone label to staff. */
const DIALLED_DOCUMENT = Object.freeze({
  id: 'd1', projectId: 'p1', read: ['public'], displayName: 'Water Plan', documentFileName: 'water-plan.pdf',
  type: 'Report', milestone: 'Application', milestoneId: 'm1', datePosted: '2024-05-01T00:00:00.000Z',
  vis: { displayName: 2, milestone: 2 }
});

module.exports = { storedDocuments, storedContainers, DIALLED_DOCUMENT };
