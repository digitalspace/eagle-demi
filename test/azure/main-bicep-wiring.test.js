'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'azure', 'main.bicep'), 'utf8');
const API_MODULE = fs.readFileSync(path.join(ROOT, 'azure', 'modules', 'api-function-flex.bicep'), 'utf8');
const TEST_PARAMS = fs.readFileSync(path.join(ROOT, 'azure', 'main.test.bicepparam'), 'utf8');
const PROD_PARAMS = fs.readFileSync(path.join(ROOT, 'azure', 'main.prod.bicepparam'), 'utf8');
const SEARCH_EXISTING = fs.readFileSync(path.join(ROOT, 'azure', 'modules', 'search-existing.bicep'), 'utf8');
const COSMOS_MODULE = fs.readFileSync(path.join(ROOT, 'azure', 'modules', 'cosmos-nosql.bicep'), 'utf8');
const OBSERVABILITY = fs.readFileSync(path.join(ROOT, 'azure', 'modules', 'observability.bicep'), 'utf8');
const KEY_VAULT = fs.readFileSync(path.join(ROOT, 'azure', 'modules', 'key-vault.bicep'), 'utf8');
const DEPLOY = fs.readFileSync(path.join(ROOT, 'scripts', 'deploy-infra.sh'), 'utf8');

const { summaryLine } = require('../../src/scripts/reconcile-eagle');

// The availability probe has two ways to be green through a real outage, and `az bicep build`
// catches neither — it is a URL string either way. Both are text-structural, with the same honest
// limits as the guards above.
test('the prod availability probe goes through rproxy and reaches AI Search', () => {
  const match = /^param availabilityUrl = '([^']+)'$/m.exec(PROD_PARAMS);
  assert.ok(match, 'prod must set availabilityUrl, or the module gate deploys no test at all');
  const url = new URL(match[1]);

  // rproxy resolves the Front Door address ONCE at config load, so a moved edge breaks the public
  // path while demi-api-fc-prod.azurewebsites.net keeps answering. Probing the app directly would
  // stay green through exactly the outage this test exists to catch (TODO 4.6).
  assert.strictEqual(url.hostname, 'projects.eao.gov.bc.ca',
    'the probe must take the public path visitors take, not the app hostname behind it');
  assert.ok(url.pathname.startsWith('/demi-search/'),
    'that public path is what rproxy routes to demi-api-fc-prod');

  // `hasCriteria` is FALSE for a bare project list, and src/controllers/search.js then answers it
  // from Cosmos — an AI Search outage would not move a `dataset=Project&pageSize=1` probe. Every
  // document read goes to the index, so this is the parameter that makes the probe meaningful.
  assert.strictEqual(url.searchParams.get('dataset'), 'Document',
    'only a document read is guaranteed to reach aiSearch.searchDocuments');
});

// The prod parameters turn features OFF through switches, and every one of them has the same blind
// spot: delete the line that wires it and `az bicep build` still exits 0 with only a
// `no-unused-params` warning, so the param file reads one thing and the deployment does another —
// silently reverting to the module default, which is ON in every case.
// Text-structural, with the same honest limits as the guard below.
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
    'the API module call — without it LINK_BASE_URL is empty and short links resolve nowhere'],
  ['allowedClients', /^\s+allowedClients: allowedClients$/m,
    'the API module call — without it DEMI_ALLOWED_CLIENTS is empty and the app refuses to boot'],
  ['ssoAudience', /^\s+ssoAudience: ssoAudience$/m,
    'the API module call — without it SSO_AUDIENCE cannot be set once the aud claim is measured'],
  ['syncTeamsSchedule', /^\s+syncTeamsSchedule: syncTeamsSchedule$/m,
    'the API module call — without it SYNC_TEAMS_SCHEDULE is empty, no timer is registered and the ' +
    'nightly Track team sync never fires'],
  ['trackApiBase', /^\s+trackApiBase: trackApiBase$/m,
    'the API module call — without it the sync has no upstream to read team members from'],
  ['trackClientId', /^\s+trackClientId: trackClientId$/m,
    'the API module call — without it the sync cannot ask Keycloak for a Track token'],
  ['roleSyncClientId', /^\s+roleSyncClientId: roleSyncClientId$/m,
    'the API module call — without it the sync has no admin identity to grant roles with'],
  ['deployDevbox',
    /^module devbox '\.\/modules\/devbox\.bicep' = if \(deployDevbox && !empty\(devboxSubnetId\)\) \{$/m,
    'the devbox module gate — without it every environment builds a dev-access VM, prod included']
];

for (const [name, wiring, why] of WIRED) {
  test(`main.bicep declares and wires ${name} (${why.split(' —')[0]})`, () => {
    assert.match(MAIN, new RegExp(`^param ${name} `, 'm'),
      `${name} must be a main.bicep parameter, or no param file can set it`);
    assert.match(MAIN, wiring, `${name} is declared but not wired into ${why}`);
  });
}

// The devbox module's own parameters, which the WIRED entry above cannot cover: four of the six are
// module outputs and expressions rather than main.bicep params, so `^param <name>` does not apply.
// Every one is baked into demi-run at deploy time, and a blanked value is not a failed deploy — it
// is a VM whose scripts warn and no-op (an unset COSMOS_ENDPOINT returns a null container) or delete
// from Cosmos while silently skipping the index. `az bicep build` compiles all of them.
test('the devbox is fed the same endpoints the API app gets', () => {
  const block = MAIN.split(/^module /m).find(b => b.includes("'./modules/devbox.bicep'"));
  assert.ok(block, 'main.bicep must call the devbox module');

  const wiring = [
    ['cosmosEndpoint', /^\s+cosmosEndpoint: cosmos\.outputs\.cosmosEndpoint$/m],
    ['searchEndpoint',
      /^\s+searchEndpoint: deploySearch \? search!\.outputs\.searchEndpoint : existingSearchEndpoint$/m],
    ['eagleApiBase', /^\s+eagleApiBase: eagleApiBase$/m],
    ['identityId', /^\s+identityId: identity\.outputs\.identityId$/m],
    // Not identityId: the CLI needs the client id to name which identity IMDS should hand back.
    ['identityClientId', /^\s+identityClientId: identity\.outputs\.clientId$/m],
    ['subnetId', /^\s+subnetId: devboxSubnetId$/m],
    // Without this the VM takes an empty key and Microsoft.Compute refuses it mid-apply.
    ['sshPublicKey', /^\s+sshPublicKey: devboxSshPublicKey$/m]
  ];

  for (const [name, pattern] of wiring) {
    assert.match(block, pattern, `the devbox module's ${name} is not wired, or is wired to something else`);
  }
});

// src/config.js throws on an empty allowlist in test and prod, so a param file that omits this
// deploys an app that boot-loops. `az bicep build` says nothing: main.bicep's param has no default,
// but a `param allowedClients = ''` line satisfies the compiler and fails at runtime.
for (const [envName, params] of [['test', TEST_PARAMS], ['prod', PROD_PARAMS]]) {
  test(`the ${envName} param file sets a non-empty allowlist`, () => {
    const match = /^param allowedClients = '([^']+)'$/m.exec(params);
    assert.ok(match, `${envName} must name at least one client, or the app refuses to start`);
    assert.ok(match[1].length > 0, 'an empty allowlist admits every client in the realm');
  });
}

// Declared, not non-empty: a guessed value rejects every caller, so a realm ships '' until its `aud`
// is measured (test: 'account', 2026-08-28; prod: ''). The check only guards the line itself —
// delete it and the environment silently takes the module default.
for (const [envName, params] of [['test', TEST_PARAMS], ['prod', PROD_PARAMS]]) {
  test(`the ${envName} param file declares ssoAudience`, () => {
    assert.match(params, /^param ssoAudience = '[^']*'$/m,
      `${envName} must state the audience explicitly, empty or otherwise`);
  });
}

// The Track team sync's four plain settings. Every one is a whole-collection-PUT app setting, so a
// param file that omits one takes main.bicep's empty default and the live value is deleted on the
// next deploy — `az bicep build` says nothing, because an empty default compiles.
for (const [envName, params] of [['test', TEST_PARAMS], ['prod', PROD_PARAMS]]) {
  for (const name of ['trackApiBase', 'trackClientId', 'roleSyncClientId', 'syncTeamsSchedule']) {
    test(`the ${envName} param file declares ${name}`, () => {
      assert.match(params, new RegExp(`^param ${name} = '[^']*'$`, 'm'),
        `${envName} must state ${name} explicitly, empty or otherwise`);
    });
  }
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

// eagle-notify is two settings and the key is OPTIONAL, which is a shape three files have to agree
// on: an empty key writes no Key Vault secret, an empty secret URI leaves the app setting empty,
// and the deploy script demands the key only where a host is named. Break any one and either a
// prod deploy is blocked on a credential prod does not use, or a test environment goes dark while
// looking configured. `az bicep build` says nothing about either.
test('the eagle-notify key is demanded exactly where a host is named', () => {
  assert.match(KEY_VAULT, /var hasNotifyKey = !empty\(notifyApiKey\)/);
  assert.match(KEY_VAULT, /resource notifyApiKeySecret [^\n]+ = if \(hasNotifyKey\) \{/,
    'an empty key must write no secret — there is no empty secret value to write');
  assert.match(API_MODULE, /value: empty\(notifyApiKeySecretUri\) \?/,
    'without the empty branch a dark environment gets a Key Vault reference to no secret');

  const base = (params) => /^param notifyApiBase = '([^']*)'$/m.exec(params);
  assert.ok(base(TEST_PARAMS), 'test must state notifyApiBase');
  assert.ok(base(PROD_PARAMS), 'prod must state notifyApiBase, empty or otherwise');
  assert.strictEqual(base(PROD_PARAMS)[1], '', 'prod has no eagle-notify to announce to yet');

  assert.match(DEPLOY, /os_secret demi-app-secrets NOTIFY_API_KEY/,
    'the key comes from OpenShift, like every other secret this script sources');
  assert.match(DEPLOY, /notifyApiBase[^\n]*PARAM_FILE[\s\S]{0,120}required\+=\(NOTIFY_API_KEY\)/,
    'the key must be required only where the param file names a host — otherwise prod is blocked ' +
    'on a credential it does not use, or test deploys a host with no key and stays dark');
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

// ADMIN_API_KEY is the break-glass credential. As a plain app setting its value sat in the template
// parameters and in ARM deployment history; a revert to that is invisible to `az bicep build` and to
// a what-if diff, which masks @secure() values on both sides. Text-structural, same honest limits as
// the guards above.
const KEY_VAULT_MODULE = fs.readFileSync(path.join(ROOT, 'azure', 'modules', 'key-vault.bicep'), 'utf8');

test('the API app reads ADMIN_API_KEY through a Key Vault reference', () => {
  const setting = API_MODULE
    .split(/^\s+\{$/m)
    .find(b => /name: 'ADMIN_API_KEY'/.test(b));
  assert.ok(setting, 'no ADMIN_API_KEY app setting declared at all');
  assert.match(setting, /value: '@Microsoft\.KeyVault\(SecretUri=\$\{adminApiKeySecretUri\}\)'/,
    'the setting must be a Key Vault reference, not the credential itself');
  assert.doesNotMatch(API_MODULE, /value: adminApiKey$/m,
    'no app setting may carry the raw adminApiKey value');

  assert.match(MAIN, /^\s+adminApiKeySecretUri: keyVault\.outputs\.adminApiKeySecretUri$/m,
    'main.bicep must pass the vault URI into the API module — without it the reference names nothing');
  assert.match(MAIN, /^module keyVault '\.\/modules\/key-vault\.bicep' = \{$/m,
    'and the vault module must be instantiated');
});

// Without the grant the reference resolves to nothing, App Service leaves the literal
// `@Microsoft.KeyVault(...)` string in the setting, and every admin call 401s against a credential
// that looks configured. `az bicep build` exits 0 with the assignment deleted.
test('the app identity is granted Key Vault Secrets User', () => {
  assert.match(KEY_VAULT_MODULE, /'4633458b-17de-408a-b874-0445c86b69e6'/,
    'Key Vault Secrets User is the role that reads secret VALUES; no other built-in role does');
  assert.match(KEY_VAULT_MODULE, /principalId: identityPrincipalId/,
    'the assignment must target the identity the API runs as');
  assert.match(KEY_VAULT_MODULE, /enableRbacAuthorization: true/,
    'a role assignment grants nothing on a vault still using access policies');

  // Key Vault references resolve as the system-assigned identity by default, and this app has only
  // a user-assigned one — so the grant above is wired to a principal App Service would not use.
  assert.match(API_MODULE, /^\s+keyVaultReferenceIdentity: identityId$/m,
    'the app must resolve references as the identity that holds the grant');
});

// The team sync's two credentials, same reasoning as ADMIN_API_KEY above: as plain app settings
// their values would sit in the template parameters and in ARM deployment history, and a revert to
// that is invisible to both `az bicep build` and a what-if diff.
test('the API app reads both team-sync secrets through Key Vault references', () => {
  const cases = [
    ['TRACK_CLIENT_SECRET', 'trackClientSecret', 'track-client-secret'],
    ['KEYCLOAK_ADMIN_CLIENT_SECRET', 'roleSyncClientSecret', 'role-sync-client-secret']
  ];

  for (const [settingName, paramName, secretName] of cases) {
    const setting = API_MODULE
      .split(/^\s+\{$/m)
      .find(b => new RegExp(`name: '${settingName}'`).test(b));
    assert.ok(setting, `no ${settingName} app setting declared at all`);
    assert.match(setting, new RegExp(`value: '@Microsoft\\.KeyVault\\(SecretUri=\\$\\{${paramName}Uri\\}\\)'`),
      `${settingName} must be a Key Vault reference, not the credential itself`);
    assert.doesNotMatch(API_MODULE, new RegExp(`value: ${paramName}$`, 'm'),
      `no app setting may carry the raw ${paramName} value`);

    assert.match(MAIN, new RegExp(`^\\s+${paramName}Uri: keyVault\\.outputs\\.${paramName}Uri$`, 'm'),
      'main.bicep must pass the vault URI into the API module — without it the reference names nothing');
    assert.match(MAIN, new RegExp(`^\\s+${paramName}: ${paramName}$`, 'm'),
      'and the value into the vault module, or the secret is never written');
    assert.match(KEY_VAULT_MODULE, new RegExp(`name: '${secretName}'`),
      `key-vault.bicep must declare the ${secretName} secret`);
    assert.match(KEY_VAULT_MODULE, new RegExp(`^output ${paramName}Uri string = \\w+\\.properties\\.secretUri$`, 'm'),
      'and output its VERSIONLESS uri (secretUri, not secretUriWithVersion), so a rotation needs ' +
      'a new secret version and a restart rather than an infrastructure deploy');
  }
});

// The gateway secret is what makes the app trust an APIM-asserted subscription, and both halves of
// that trust are text-structural: a plain-value app setting would put the secret in the template
// and in ARM history, and a global policy that sets the two headers without deleting the client's
// copies first would let anyone reach the app directly and assert any subscription they like — the
// Function App host stays public, because Consumption APIM has no VNet. `az bicep build` exits 0
// either way. Same honest limits as the guards above.
const APIM_MODULE = fs.readFileSync(path.join(ROOT, 'azure', 'modules', 'apim.bicep'), 'utf8');

test('the Flex app reads APIM_GATEWAY_SECRET through a Key Vault reference', () => {
  const setting = API_MODULE
    .split(/^\s+\{$/m)
    .find(b => /name: 'APIM_GATEWAY_SECRET'/.test(b));
  assert.ok(setting, 'no APIM_GATEWAY_SECRET app setting declared at all');
  assert.match(setting, /value: apimGatewaySecretRef$/m,
    'the setting must carry the reference parameter, never a literal');

  assert.match(MAIN, /apimGatewaySecretRef: deployApim \? '@Microsoft\.KeyVault\(VaultName=\$\{keyVault\.outputs\.vaultName\};SecretName=\$\{apimGatewaySecretName\}\)' : ''/,
    'main.bicep must compose a Key Vault reference, and empty it when APIM is not deployed — an ' +
    'empty value is what disables the app trust branch');
  assert.match(MAIN, /^\s+gatewaySecretName: apimGatewaySecretName$/m,
    'the gateway and the app must name the SAME secret, or the app compares against another value');
  assert.match(API_MODULE, /^\s+keyVaultReferenceIdentity: identityId$/m,
    'the app must resolve references as the identity that holds the grant');
});

test('the gateway strips client-supplied trust headers before setting its own', () => {
  // The SERVICE-level policy, not the product one: only this scope sees every request, including
  // the anonymous browser traffic the strip has to protect against.
  const global = /service\/policies@[\s\S]*$/.exec(APIM_MODULE);
  assert.ok(global, 'apim.bicep must declare a service-level policy');
  const inbound = /<inbound>([\s\S]*?)<\/inbound>/.exec(global[0]);
  assert.ok(inbound, 'and it must have an inbound section');

  for (const header of ['X-Gateway-Secret', 'X-APIM-Subscription']) {
    const del = inbound[1].indexOf(`<set-header name="${header}" exists-action="delete" />`);
    const set = inbound[1].indexOf(`<set-header name="${header}" exists-action="override">`);
    assert.ok(del >= 0, `${header} must be deleted from the client request`);
    assert.ok(set > del, `${header} must be deleted BEFORE the gateway sets its own value`);
  }

  assert.match(APIM_MODULE, /<value>\{\{gateway-secret\}\}<\/value>/,
    'the secret must come from the named value, never a literal in this repository');
  assert.match(APIM_MODULE, /<value>@\(context\.Subscription\?\.Name \?\? ""\)<\/value>/,
    'and the subscription name from APIM itself, which is the only party that verified the key');
});

// Without operations APIM answers 404 for everything: an API with a backend but no exposed
// operation proxies nothing, and `az bicep build` cannot see the difference.
test('both APIM APIs expose wildcard operations over every method', () => {
  const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
  for (const method of methods) {
    assert.ok(APIM_MODULE.includes(`  '${method}'`), `proxyMethods must include ${method}`);
  }

  for (const parent of ['api', 'machineApi']) {
    const block = new RegExp(
      `apis/operations@[\\d-]+' = \\[for method in proxyMethods: \\{\\s+parent: ${parent}\\b[\\s\\S]*?urlTemplate: '/\\*'`
    );
    assert.match(APIM_MODULE, block, `${parent} must declare a wildcard operation per method`);
  }
});
