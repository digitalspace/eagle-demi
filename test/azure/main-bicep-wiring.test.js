'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'azure', 'main.bicep'), 'utf8');
const API_MODULE = fs.readFileSync(path.join(ROOT, 'azure', 'modules', 'api-web-app.bicep'), 'utf8');
const TEST_PARAMS = fs.readFileSync(path.join(ROOT, 'azure', 'main.test.bicepparam'), 'utf8');
const PROD_PARAMS = fs.readFileSync(path.join(ROOT, 'azure', 'main.prod.bicepparam'), 'utf8');
const SEARCH_EXISTING = fs.readFileSync(path.join(ROOT, 'azure', 'modules', 'search-existing.bicep'), 'utf8');

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

// Prod reaches this API the same way test does — through rproxy, one bucket for everyone.
test('the prod environment raises the ceiling above the proxy-collapsed default', () => {
  const match = /^param rateLimitMaxRequests = (\d+)$/m.exec(PROD_PARAMS);
  assert.ok(match, 'prod must set the ceiling explicitly, not inherit the direct-traffic default');
  assert.ok(Number(match[1]) >= 1000,
    `${match[1]}/min is ${(Number(match[1]) / 60).toFixed(1)} r/s for every visitor combined`);
});

// The prod parameters turn features OFF through switches, and every one of them has the same blind
// spot as `rateLimitMaxRequests` above: delete the line that wires it and `az bicep build` still
// exits 0 with only a `no-unused-params` warning, so the param file reads one thing and the
// deployment does another — silently reverting to the module default, which is ON in every case.
// Text-structural, with the same honest limits as the guard above.
const WIRED = [
  ['deployEnrichment', /^\s+deployEnrichment: deployEnrichment$/m,
    'the cosmos module call — without it prod declares the wildfires container'],
  ['deploySearch', /^module search '\.\/modules\/ai-search\.bicep' = if \(deploySearch\) \{$/m,
    'the ai-search module gate — without it prod re-PUTs a service it does not own'],
  ['deploySearch', /^module existingSearchRole '\.\/modules\/search-existing\.bicep' = if \(!deploySearch\) \{$/m,
    'the search-existing module gate — without it prod gets no grant and no Cosmos link'],
  ['existingSearchEndpoint',
    /^\s+searchEndpoint: deploySearch \? search!\.outputs\.searchEndpoint : existingSearchEndpoint$/m,
    'the SEARCH_ENDPOINT fallback — a different fallback leaves prod pointing at nothing'],
  ['deployFoundry', /^module foundry '\.\/modules\/foundry\.bicep' = if \(deployFoundry\) \{$/m,
    'the foundry module gate — without it prod creates a model account it never queries'],
  ['deployStaticSite', /^module staticSite '\.\/modules\/static-site\.bicep' = if \(deployStaticSite\) \{$/m,
    'the static-site module gate — without it prod creates a $web nothing publishes to'],
  ['existingServerFarmId', /^\s+existingServerFarmId: existingServerFarmId$/m,
    'the API module call — without it prod creates demi-plan-prod instead of joining the shared plan'],
  ['keycloakClientId', /^\s+keycloakClientId: keycloakClientId$/m,
    'the API module call — without it no param file can set which client the API trusts']
];

for (const [name, wiring, why] of WIRED) {
  test(`main.bicep declares and wires ${name} (${why.split(' —')[0]})`, () => {
    assert.match(MAIN, new RegExp(`^param ${name} `, 'm'),
      `${name} must be a main.bicep parameter, or no param file can set it`);
    assert.match(MAIN, wiring, `${name} is declared but not wired into ${why}`);
  });
}

// deploySearch=false means ai-search.bicep never runs, so the ONE thing that gives the indexer a
// route to a publicNetworkAccess: Disabled Cosmos account has to come from search-existing.bicep
// instead. Missing, the deployment succeeds and every indexer then fails with a connection error.
test('the not-ours search path still creates the shared private link to Cosmos', () => {
  assert.match(SEARCH_EXISTING, /sharedPrivateLinkResources@/,
    'search-existing.bicep must declare the shared private link');
  assert.match(SEARCH_EXISTING, /groupId: 'Sql'/,
    "groupId must be 'Sql' — the NoSQL API, not the legacy MongoDB account");

  const block = MAIN.split(/^module /m).find(b => b.includes("'./modules/search-existing.bicep'"));
  assert.ok(block, 'main.bicep must call the search-existing module');
  assert.match(block, /^\s+cosmosAccountId: cosmos\.outputs\.cosmosAccountId$/m,
    'without cosmosAccountId the module\'s own !empty() gate skips the link silently');
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
