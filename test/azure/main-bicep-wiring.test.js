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
const COSMOS_MODULE = fs.readFileSync(path.join(ROOT, 'azure', 'modules', 'cosmos-nosql.bicep'), 'utf8');
const OBSERVABILITY = fs.readFileSync(path.join(ROOT, 'azure', 'modules', 'observability.bicep'), 'utf8');

const { summaryLine } = require('../../src/scripts/reconcile-eagle');

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

// The availability probe has two ways to be green through a real outage, and `az bicep build`
// catches neither — it is a URL string either way. Both are text-structural, with the same honest
// limits as the guards above.
test('the prod availability probe goes through rproxy and reaches AI Search', () => {
  const match = /^param availabilityUrl = '([^']+)'$/m.exec(PROD_PARAMS);
  assert.ok(match, 'prod must set availabilityUrl, or the module gate deploys no test at all');
  const url = new URL(match[1]);

  // rproxy resolves the Front Door address ONCE at config load, so a moved edge breaks the public
  // path while demi-api-prod.azurewebsites.net keeps answering. Probing the app directly would
  // stay green through exactly the outage this test exists to catch (TODO 4.6).
  assert.strictEqual(url.hostname, 'projects.eao.gov.bc.ca',
    'the probe must take the public path visitors take, not the app hostname behind it');
  assert.ok(url.pathname.startsWith('/demi-search/'),
    'that public path is what rproxy routes to demi-api-prod');

  // `hasCriteria` is FALSE for a bare project list, and src/controllers/search.js then answers it
  // from Cosmos — an AI Search outage would not move a `dataset=Project&pageSize=1` probe. Every
  // document read goes to the index, so this is the parameter that makes the probe meaningful.
  assert.strictEqual(url.searchParams.get('dataset'), 'Document',
    'only a document read is guaranteed to reach aiSearch.searchDocuments');
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
    'the API module call — without it no param file can set which client the API trusts'],
  ['availabilityUrl',
    /^module availability '\.\/modules\/availability\.bicep' = if \(!empty\(availabilityUrl\)\) \{$/m,
    'the availability module gate — without it every environment gets a prod-only web test'],
  ['reconcileSchedule', /^\s+reconcileSchedule: reconcileSchedule$/m,
    'the API module call — without it RECONCILE_SCHEDULE is empty, no timer is registered and the ' +
    'nightly run never fires'],
  ['deployReconcileDriftAlert', /^\s+deployReconcileDriftAlert: deployReconcileDriftAlert$/m,
    'the observability module call — without it the drift alert is never created'],
  ['linkBaseUrl', /^\s+linkBaseUrl: linkBaseUrl$/m,
    'the API module call — without it LINK_BASE_URL is empty and short links resolve nowhere']
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

// `deployEnrichment` decides ONE container. Prod skips `wildfires` and keeps `boundaries`, which is
// reference data `GET /boundaries` and `GET /db/stats` read unconditionally — gate it too and prod
// answers those from a container that does not exist. Nothing else in the suite reads this module,
// so both halves of the switch were mutable with the whole suite staying green.
//
// Text-structural, same honest limits as the guards above: it fails on the gate moving and proves
// nothing about what Azure applied.
test('deployEnrichment gates the wildfires container and only that one', () => {
  const container = (name) => COSMOS_MODULE
    .split(/^resource /m)
    .find(b => new RegExp(`^\\w+ 'Microsoft\\.DocumentDB/databaseAccounts/sqlDatabases/containers@`).test(b)
      && new RegExp(`\\n\\s+name: '${name}'`).test(b));

  const wildfires = container('wildfires');
  assert.ok(wildfires, 'no wildfires container declared in cosmos-nosql.bicep');
  assert.match(wildfires.split('\n')[0], /= if \(deployEnrichment\)/,
    'wildfires must be gated on deployEnrichment — prod publishes no enrichment');

  const boundaries = container('boundaries');
  assert.ok(boundaries, 'no boundaries container declared in cosmos-nosql.bicep');
  assert.doesNotMatch(boundaries.split('\n')[0], /= if \(/,
    'boundaries must NOT be gated — every environment serves it, empty in prod');
});

// Two params, one feature, and each is useless alone: the schedule is what writes the drift line,
// the bool is what watches for it. An environment with the alert and no run has an alarm that can
// never fire; one with the run and no alert writes a line nobody reads. Nothing in `az bicep build`
// or in a what-if diff would say either.
test('prod runs the nightly reconcile and alerts on its drift', () => {
  const cron = /^param reconcileSchedule = '([^']+)'$/m.exec(PROD_PARAMS);
  assert.ok(cron, 'prod must set reconcileSchedule, or no timer is registered at all');
  // SIX fields. NCRONTAB leads with seconds, and a five-field crontab pasted in here is accepted
  // by bicep, deployed, and then read by the host as `minute hour day month weekday` shifted one
  // place — `0 9 * * *` is 09:00 every minute of the hour, not once a day.
  assert.strictEqual(cron[1].trim().split(/\s+/).length, 6,
    `${cron[1]} is not NCRONTAB — six fields, seconds first`);
  assert.match(cron[1], /^0 0 ([01]?\d|2[0-3]) \* \* \*$/,
    'once a night on the hour is the only shape this job is written for');
  assert.match(PROD_PARAMS, /^param deployReconcileDriftAlert = true$/m,
    'the run without the alert is a log line nobody reads');
});

// TEST IS OFF ON PURPOSE, and it is the pair that has to stay off: `eagleApiBase` there is
// eagle-test while the test corpus was seeded from PROD Eagle, so a nightly diff compares two
// unrelated corpora and alerts every night on the difference. Turning either half on is only
// correct in the same edit that repoints eagleApiBase — which this fails on, since nothing else
// would.
test('test schedules no reconcile and deploys no drift alert', () => {
  assert.match(TEST_PARAMS, /^param reconcileSchedule = ''$/m,
    'a schedule here diffs the test corpus against an upstream it did not come from');
  assert.match(TEST_PARAMS, /^param deployReconcileDriftAlert = false$/m,
    'and the alert on that diff would fire every night');
  assert.match(TEST_PARAMS, /^param eagleApiBase = 'https:\/\/eagle-test\./m,
    'this is the reason for both — turn them on in the edit that changes this line, not before');
});

// The alert reads a number out of a log line this repo formats. Both halves are strings in
// different languages in different files, and every way of getting it wrong is silent: `traces` is
// the classic-schema table name and does not exist in a workspace-based component, `has` tokenises
// on brackets, and any change to summaryLine's wording stops the match. The rule would keep
// evaluating and keep finding nothing, which reads exactly like no drift.
test('the drift alert query matches the line the reconcile actually logs', () => {
  const block = OBSERVABILITY
    .split(/^resource /m)
    .find(b => b.includes("name: 'demi-reconcile-drift-${environmentName}'"));
  assert.ok(block, 'no demi-reconcile-drift rule in observability.bicep');

  const query = /query: '([^']+)'/.exec(block);
  assert.ok(query, 'the rule declares no query');

  assert.match(query[1], /^AppTraces \|/,
    'AppTraces, not traces — the classic table does not exist in this workspace, and a rule ' +
    'against it returns no rows rather than an error');

  const drifting = summaryLine({
    projects: { unpublishedOrDeleted: [{ id: 'p1' }], eagleOnly: [] },
    documents: { unpublishedOrDeleted: [], eagleOnly: ['d1', 'd2'], unresolvedParent: [] },
    drift: 3
  });

  const needle = /contains "([^"]+)"/.exec(query[1]);
  assert.ok(needle, 'the rule filters on no literal at all');
  assert.ok(drifting.includes(needle[1]),
    `the rule looks for ${JSON.stringify(needle[1])}, which is not in ${JSON.stringify(drifting)}`);

  const extract = /extract\("([^"]+)", 1, Message\)/.exec(query[1]);
  assert.ok(extract, 'the rule extracts no drift count');
  assert.strictEqual(new RegExp(extract[1]).exec(drifting)[1], '3',
    'the extracted group must be the drift total itself, or the > 0 test reads the wrong number');

  const clean = summaryLine({
    projects: { unpublishedOrDeleted: [], eagleOnly: [] },
    documents: { unpublishedOrDeleted: [], eagleOnly: [], unresolvedParent: [] },
    drift: 0
  });
  assert.strictEqual(new RegExp(extract[1]).exec(clean)[1], '0', 'a clean night must read 0');
  assert.match(query[1], /where drift > 0/, 'and 0 must not alert');
});
