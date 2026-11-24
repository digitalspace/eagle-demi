'use strict';

// The documents container answering a `SELECT c.a, c.b FROM c ...` read as Cosmos does: only the
// named columns come back, so a column the repository forgets to project is missing here too.

const cosmos = require('../../src/db/cosmos-nosql');

/** Mock `cosmos.query` over `rows`. WHERE is not run: pass the rows this caller's ACL admits. */
function storedDocuments(t, rows) {
  return t.mock.method(cosmos, 'query', async (container, spec) => {
    if (container !== 'documents') throw new Error(`stored-documents: unexpected container ${container}`);
    const select = /^SELECT (.+?) FROM c /s.exec(spec.query)[1];
    const columns = select.split(',').map(column => column.trim().replace(/^c\./, ''));
    if (!columns.every(column => /^\w+$/.test(column))) throw new Error(`stored-documents: cannot project ${select}`);
    return {
      items: rows.map(row => Object.fromEntries(columns
        .filter(column => Object.hasOwn(row, column))
        .map(column => [column, structuredClone(row[column])])))
    };
  });
}

/** A public document whose own dials keep its display name and milestone label to staff. */
const DIALLED_DOCUMENT = Object.freeze({
  id: 'd1', projectId: 'p1', read: ['public'], displayName: 'Water Plan', documentFileName: 'water-plan.pdf',
  type: 'Report', milestone: 'Application', milestoneId: 'm1', datePosted: '2024-05-01T00:00:00.000Z',
  vis: { displayName: 2, milestone: 2 }
});

module.exports = { storedDocuments, DIALLED_DOCUMENT };
