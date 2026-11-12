'use strict';

// A public container or a widened delete prefix both compile, so the works-import storage is
// checked here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MODULE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'azure', 'modules', 'api-function-flex.bicep'),
  'utf8',
);

function resourceBlock(symbol) {
  const start = MODULE.indexOf(`resource ${symbol} `);
  assert.ok(start >= 0, `resource ${symbol} is declared`);
  return MODULE.slice(start, MODULE.indexOf('\n}', start));
}

test('works-import is a private container on the API storage account', () => {
  const container = resourceBlock('worksImportContainer');
  assert.match(container, /^\s+parent: blobService$/m);
  assert.match(container, /^\s+name: 'works-import'$/m);
  assert.match(container, /^\s+publicAccess: 'None'$/m);
  assert.match(resourceBlock('apiStorage'), /^\s+allowBlobPublicAccess: false$/m);
});

test('the only lifecycle rule deletes works-import blobs after 7 days', () => {
  assert.strictEqual(MODULE.match(/managementPolicies@/g).length, 1, 'one management policy');
  const policy = resourceBlock('storageLifecycle');
  assert.match(policy, /^\s+parent: apiStorage$/m);
  assert.strictEqual(policy.match(/type: 'Lifecycle'/g).length, 1, 'one rule');
  assert.match(policy, /^\s+enabled: true$/m);
  assert.deepStrictEqual(
    [...MODULE.matchAll(/prefixMatch: (.*)$/gm)].map((m) => m[1]),
    ["['${worksImportContainer.name}/']"],
  );
  assert.match(policy, /^\s+daysAfterCreationGreaterThan: 7$/m);
});
