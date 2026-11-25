'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { withoutLineComments } = require('./bicep-resource');

test('withoutLineComments', async (t) => {
  await t.test('drops a whole-line // comment, indented or not', () => {
    const source = "// header\nparam a string\n  // { name: 'Users', type: 'long' }\n  { name: 'Events', type: 'long' }";
    assert.strictEqual(withoutLineComments(source), "param a string\n  { name: 'Events', type: 'long' }");
  });

  await t.test('keeps a line whose // comes after code, as a URL in a string does', () => {
    const source = "var url = 'https://demi.example'\nvar b = 1 // why";
    assert.strictEqual(withoutLineComments(source), source);
  });

  await t.test('with the # marker drops shell comments and keeps // lines', () => {
    const source = "#!/bin/bash\n  # if [ \"$X\" != 'yes' ]; then\nexport X\n// not a shell comment";
    assert.strictEqual(withoutLineComments(source, '#'), 'export X\n// not a shell comment');
  });
});
