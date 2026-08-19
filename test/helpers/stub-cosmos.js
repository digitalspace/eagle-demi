'use strict';

/**
 * Preload stub for `src/db/cosmos-nosql`, used with `node -r`.
 *
 * The export script talks to a private-endpoint-only, keyless Cosmos account that exists in exactly
 * one place and holds the only extracted copy of the corpus. Nothing about a unit test should be
 * able to reach it, so the module is replaced in the require cache before the script under test can
 * load the real one.
 *
 * The rows served depend on the QUERY, deliberately: `SELECT *` returns the whole document —
 * `read[]`, `projectId`, `id` and the Cosmos system properties — while the narrow push projection
 * returns only its four fields. That is what lets a test prove the dump took the full row rather
 * than the ingest payload, instead of assuming it.
 */

const path = require('path');

const target = require.resolve(path.join(__dirname, '..', '..', 'src', 'db', 'cosmos-nosql.js'));

const FULL = [
  [
    {
      id: 'doc1::p1::c0',
      documentId: 'doc1',
      projectId: 'proj-7',
      read: ['public'],
      pageNumber: 1,
      chunkIndex: 0,
      content: 'first chunk',
      _rid: 'rid1',
      _ts: 1700000000,
    },
    {
      id: 'doc1::p1::c1',
      documentId: 'doc1',
      projectId: 'proj-7',
      read: ['public'],
      pageNumber: 1,
      chunkIndex: 1,
      content: 'second chunk',
      _rid: 'rid2',
      _ts: 1700000001,
    },
  ],
  [
    {
      id: 'doc2::p4::c0',
      documentId: 'doc2',
      projectId: 'proj-9',
      read: ['eao', 'admin'],
      pageNumber: 4,
      chunkIndex: 0,
      content: 'third chunk',
      _rid: 'rid3',
      _ts: 1700000002,
    },
    {
      id: 'doc2::p4::c1',
      documentId: 'doc2',
      projectId: 'proj-9',
      read: ['eao', 'admin'],
      pageNumber: 4,
      chunkIndex: 1,
      content: 'fourth chunk',
      _rid: 'rid4',
      _ts: 1700000003,
    },
  ],
];

const PROJECTED_FIELDS = ['documentId', 'pageNumber', 'chunkIndex', 'content'];

function project(row) {
  return Object.fromEntries(PROJECTED_FIELDS.map((f) => [f, row[f]]));
}

let call = 0;

require.cache[target] = {
  id: target,
  filename: target,
  loaded: true,
  exports: {
    async query(_container, spec, _options) {
      if (/COUNT\(1\)/.test(spec.query)) return { items: [4], requestCharge: 1 };

      const page = FULL[call++];
      if (!page) return { items: [], continuationToken: undefined, requestCharge: 0 };

      const whole = /SELECT\s+\*/i.test(spec.query);
      return {
        items: page.map((r) => (whole ? r : project(r))),
        continuationToken: call < FULL.length ? `TOKEN-${call + 1}` : undefined,
        requestCharge: 3,
      };
    },
  },
};
