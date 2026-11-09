'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readWorkflow, block } = require('../helpers/workflow-yaml');

const PACKAGER = path.resolve(__dirname, '..', '..', 'scripts', 'package-api.py');

/** Repo-relative paths in one `name = {os.path.join(...), ...}` set literal of the packager. */
function packagerSet(source, name) {
  const literal = new RegExp(`${name} = \\{([^}]*)\\}`).exec(source);
  assert.ok(literal, `no ${name} set in scripts/package-api.py`);
  const joins = [...literal[1].matchAll(/os\.path\.join\(([^)]*)\)/g)];
  assert.ok(joins.length > 0, `${name} holds no os.path.join entries`);
  const items = literal[1].replace(/os\.path\.join\([^)]*\)/g, 'J').split(',').filter((item) => item.trim());
  assert.equal(items.length, joins.length, `${name} holds an entry that is not os.path.join(...)`);
  return joins.map((m) => m[1].split(',').map((part) => part.trim().replace(/^"|"$/g, '')).join('/'));
}

test('the API workflow fires on every path the packager re-includes', () => {
  const source = fs.readFileSync(PACKAGER, 'utf8');
  const paths = block(block(block(readWorkflow('azure-deploy-staging-api.yaml'), 0, 'on'), 2, 'push'), 4, 'paths')
    .map((l) => /^\s+- '(.+)'$/.exec(l))
    .filter(Boolean)
    .map((m) => m[1]);
  const packaged = [
    ...packagerSet(source, 'include_subpaths').map((dir) => `${dir}/**`),
    ...packagerSet(source, 'include_files'),
  ];
  assert.deepEqual(packaged.filter((p) => !paths.includes(p)), []);
});
