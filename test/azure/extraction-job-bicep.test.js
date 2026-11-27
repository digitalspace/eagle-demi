'use strict';

// An account-scoped grant, a GPU job on by default or a reachable job all compile, so they are
// checked here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { resourceBlock, withoutLineComments } = require('../helpers/bicep-resource');

const MODULE = withoutLineComments(fs.readFileSync(
  path.join(__dirname, '..', '..', 'azure', 'modules', 'extraction-job.bicep'), 'utf8'));

/** The ARM type of the resource declared as `symbol`, without its API version. */
function typeOf(symbol) {
  const m = new RegExp(`^resource ${symbol} '([^@']+)@`, 'm').exec(MODULE);
  assert.ok(m, `resource ${symbol} is declared`);
  return m[1];
}

test('every role the job identity holds is scoped to one queue or one secret', () => {
  const grants = [...MODULE.matchAll(/^resource (\w+) 'Microsoft\.Authorization\/roleAssignments@/gm)]
    .map(([, symbol]) => resourceBlock(MODULE, symbol));
  const scopes = grants.map(block => typeOf(/^\s+scope: (\w+)/m.exec(block)[1]));
  assert.deepStrictEqual(scopes.sort(), [
    'Microsoft.KeyVault/vaults/secrets',
    'Microsoft.Storage/storageAccounts/queueServices/queues',
  ]);
});

test('the GPU job is off unless a param file turns it on', () => {
  assert.match(MODULE, /^param deployExtractionGpu bool = false$/m);
});

test('nothing outside the VNet can reach the job', () => {
  assert.doesNotMatch(resourceBlock(MODULE, 'extractJob'), /\bingress\b/);
  const env = resourceBlock(MODULE, 'extractEnvironment');
  assert.match(env, /^\s+internal: true$/m);
  assert.match(env, /^\s+publicNetworkAccess: 'Disabled'$/m);
});
