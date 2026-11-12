'use strict';

// A public container or a widened delete prefix both compile, so the works-import storage is
// checked here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { resourceBlock } = require('../helpers/bicep-resource');

const MODULE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'azure', 'modules', 'api-function-flex.bicep'),
  'utf8',
);

test('works-import is a private container on the API storage account', () => {
  const container = resourceBlock(MODULE, 'worksImportContainer');
  assert.match(container, /^\s+parent: blobService$/m);
  assert.match(container, /^\s+name: 'works-import'$/m);
  assert.match(container, /^\s+publicAccess: 'None'$/m);
  assert.match(resourceBlock(MODULE, 'apiStorage'), /^\s+allowBlobPublicAccess: false$/m);
});

test('the only lifecycle rule deletes every works-import blob after 7 days', () => {
  assert.strictEqual((MODULE.match(/managementPolicies@/g) || []).length, 1, 'one management policy');
  const policy = resourceBlock(MODULE, 'storageLifecycle');
  assert.match(policy, /^\s+parent: apiStorage$/m);
  assert.strictEqual((policy.match(/type: 'Lifecycle'/g) || []).length, 1, 'one rule');
  assert.match(policy, /name: 'works-import-expiry'\n\s+enabled: true\n/);
  assert.deepStrictEqual(
    [...MODULE.matchAll(/prefixMatch: (.*)$/gm)].map((m) => m[1]),
    ["['${worksImportContainer.name}/']"],
  );
  assert.match(policy, /^\s+blobTypes: \['blockBlob', 'appendBlob'\]$/m);
  for (const target of ['baseBlob', 'version', 'snapshot']) {
    assert.match(
      policy,
      new RegExp(`${target}: \\{\\s+delete: \\{\\s+daysAfterCreationGreaterThan: 7\\s+\\}\\s+\\}`),
      `${target} is deleted 7 days after creation`,
    );
  }
});
