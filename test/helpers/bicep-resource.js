'use strict';

const assert = require('node:assert');

/** The body of a top-level resource declaration, up to its closing brace at column 0. */
function resourceBlock(source, symbol) {
  const start = source.indexOf(`resource ${symbol} `);
  assert.ok(start >= 0, `resource ${symbol} is declared`);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end);
}

module.exports = { resourceBlock };
