'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { queueBody } = require('../../src/utils/queue-message');

test('queueBody decodes a Buffer as UTF-8 and a string as JSON', () => {
  assert.deepStrictEqual(queueBody(Buffer.from('{"name":"Kitimat Ł"}', 'utf8'), 'x'), { name: 'Kitimat Ł' });
  assert.deepStrictEqual(queueBody('{"id":"1"}', 'x'), { id: '1' });
});

test('queueBody names the queue and keeps the parse error as the cause', () => {
  assert.throws(() => queueBody('not json', 'chunk restamp'), (err) => {
    assert.match(err.message, /^chunk restamp message is not JSON: /);
    assert.ok(err.cause instanceof SyntaxError);
    return true;
  });
});
