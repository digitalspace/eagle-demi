'use strict';

// Document downloads pipe object bytes to the client; without this flag the Functions host
// buffers the whole body first. Loaded against the recording `app` in test/helpers/load-index.js.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { loadIndex } = require('./helpers/load-index');

test('the app turns on HTTP response streaming once at startup', (t) => {
  const { registered } = loadIndex(t);

  assert.deepStrictEqual(registered.setups.map(o => o.enableHttpStream), [true]);
});
