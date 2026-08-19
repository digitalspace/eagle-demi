'use strict';

/**
 * Preload stub for `src/db/cosmos-nosql`, used with `node -r`.
 *
 * The export script talks to a private-endpoint-only, keyless Cosmos account that exists in exactly
 * one place. Nothing about a unit test should be able to reach it, so the module is replaced in the
 * require cache before the script under test can load the real one.
 *
 * Serves two fixed pages so the paging loop, the continuation token and `--limit` are all exercised.
 */

const path = require('path');

const target = require.resolve(path.join(__dirname, '..', '..', 'src', 'db', 'cosmos-nosql.js'));

const PAGES = [
  {
    items: [
      { documentId: 'doc1', pageNumber: 1, chunkIndex: 0, content: 'first chunk' },
      { documentId: 'doc1', pageNumber: 1, chunkIndex: 1, content: 'second chunk' },
    ],
    continuationToken: 'TOKEN-2',
    requestCharge: 3,
  },
  {
    items: [
      { documentId: 'doc2', pageNumber: 4, chunkIndex: 0, content: 'third chunk' },
      { documentId: 'doc2', pageNumber: 4, chunkIndex: 1, content: 'fourth chunk' },
    ],
    continuationToken: undefined,
    requestCharge: 3,
  },
];

let call = 0;

require.cache[target] = {
  id: target,
  filename: target,
  loaded: true,
  exports: {
    async query(_container, spec, _options) {
      if (/COUNT\(1\)/.test(spec.query)) return { items: [4], requestCharge: 1 };
      return PAGES[call++] || { items: [], continuationToken: undefined, requestCharge: 0 };
    },
  },
};
