'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'azure', 'main.bicep'), 'utf8');
const API_MODULE = fs.readFileSync(path.join(ROOT, 'azure', 'modules', 'api-web-app.bicep'), 'utf8');
const TEST_PARAMS = fs.readFileSync(path.join(ROOT, 'azure', 'main.test.bicepparam'), 'utf8');

// A STRUCTURAL GUARD, and it exists because everything else caught nothing. Deleting the one line
// that passes `rateLimitMaxRequests` into the module leaves the suite green AND `az bicep build`
// exiting 0 — it emits only a `no-unused-params` warning, and pr.yaml's job passes on warnings. The
// app setting would then silently take the module's 300 default while the param file still reads
// 6000: a value that looks configured and is not.
//
// It asserts TEXT, not behaviour, and that is the honest description. It fails on the deletion it is
// written for and proves nothing else; a real check would compile the template and read the emitted
// module parameters, which needs `az` in the test runner.
test('main.bicep passes rateLimitMaxRequests into the API module', () => {
  assert.match(MAIN, /^param rateLimitMaxRequests int = 300$/m,
    'declared with the direct-traffic default');
  assert.match(MAIN, /^\s+rateLimitMaxRequests: rateLimitMaxRequests$/m,
    'and passed to the module — without this line the param file is inert');
});

// Test reaches this API through rproxy, which collapses every visitor into one bucket. A revert to
// the default here is a 5 r/s ceiling for the whole site, not per caller.
test('the test environment raises the ceiling above the proxy-collapsed default', () => {
  const match = /^param rateLimitMaxRequests = (\d+)$/m.exec(TEST_PARAMS);
  assert.ok(match, 'test must set the ceiling explicitly, not inherit the direct-traffic default');
  assert.ok(Number(match[1]) >= 1000,
    `${match[1]}/min is ${(Number(match[1]) / 60).toFixed(1)} r/s for every visitor combined`);
});

// SCM basic auth is a public credential-guessing path onto the box holding the corpus, and this is
// the only thing in the repo that can catch it being re-enabled. `az bicep build` (pr.yaml:121)
// exits 0 whether these children are present, absent, or set to true — the same blind spot the
// rateLimitMaxRequests guard above exists for.
//
// Text-structural, and honestly so: it fails on the deletion and on the flip it is written for, and
// proves nothing about what Azure actually applied. The live reading is
// `az resource show .../basicPublishingCredentialsPolicies/scm --query properties.allow`, and only
// after someone runs deploy-infra.sh — merging this template applies nothing.
test('the API app refuses basic publishing credentials on both scm and ftp', () => {
  // Split into resource blocks and check each one's CONTENTS, rather than matching parent/name/allow
  // in a fixed order. The order-coupled version failed on a no-op reordering of `parent` and `name`
  // — the compiled ARM was identical, two policies with allow:false — while reporting that the
  // control was missing. A guard that cries deletion over formatting sends the next reader hunting
  // for a resource that is still there.
  const blocks = API_MODULE
    .split(/^resource /m)
    .filter(b => b.includes("'Microsoft.Web/sites/basicPublishingCredentialsPolicies@"));

  for (const name of ['scm', 'ftp']) {
    const block = blocks.find(b => new RegExp(`name: '${name}'`).test(b));
    assert.ok(block, `no basicPublishingCredentialsPolicies child named '${name}' — a missing ` +
      'child leaves that endpoint accepting passwords, and nothing else in CI would notice');
    assert.match(block, /parent: apiWebApp/,
      `the '${name}' policy must hang off apiWebApp, or it configures nothing`);
    assert.match(block, /allow: false/,
      `the '${name}' policy must set allow: false`);
  }
});
