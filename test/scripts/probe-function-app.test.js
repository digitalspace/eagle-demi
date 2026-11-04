'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runWithFakeAz } = require('../helpers/workflow-yaml');

const PROBE = './scripts/probe-function-app.sh rg-demi-test demi-x-test "Create it first."';

test('found when the app exists', () => {
  const r = runWithFakeAz(PROBE, { azOut: 'demi-x-test' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.found, 'found=true');
});

test('skips with a notice and the hint when the app does not exist yet', () => {
  const r = runWithFakeAz(PROBE, { azErr: '(ResourceNotFound) The Resource was not found.' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.found, 'found=false');
  assert.match(r.stdout, /^::notice::demi-x-test does not exist yet\. Create it first\. Skipping the deploy\.$/m);
  assert.match(r.summary, /does not exist yet/);
});

test('skips when CI cannot see the app', () => {
  const r = runWithFakeAz(PROBE, { azErr: '(AuthorizationFailed) no access' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.found, 'found=false');
  assert.match(r.stdout, /lacks Website Contributor/);
});

test('any other Azure error fails', () => {
  const r = runWithFakeAz(PROBE, { azErr: '(InternalServerError) boom' });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.found, '');
  assert.match(r.stdout, /^::error::az functionapp show failed for demi-x-test: \(InternalServerError\) boom$/m);
});

test('a marker that is present lets the probe ask Azure; a missing one skips without asking', () => {
  const marker = `${PROBE} release/app/index.js`;
  assert.strictEqual(runWithFakeAz(marker, { files: ['release/app/index.js'], azOut: 'demi-x-test' }).found, 'found=true');
  const r = runWithFakeAz(marker, { azErr: 'az must not be called' });
  assert.strictEqual(r.found, 'found=false');
  assert.match(r.stdout, /The tag has no app\/index\.js/);
});

test('wrong arguments print usage to stderr and fail', () => {
  const r = runWithFakeAz('./scripts/probe-function-app.sh rg-demi-test demi-x-test');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /^Usage:/);
  assert.strictEqual(r.stdout, '');
});
