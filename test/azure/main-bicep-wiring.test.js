'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'azure', 'main.bicep'), 'utf8');
const API_MODULE = fs.readFileSync(path.join(ROOT, 'azure', 'modules', 'api-function-flex.bicep'), 'utf8');
const TEST_PARAMS = fs.readFileSync(path.join(ROOT, 'azure', 'main.test.bicepparam'), 'utf8');
const PROD_PARAMS = fs.readFileSync(path.join(ROOT, 'azure', 'main.prod.bicepparam'), 'utf8');
const SEARCH_EXISTING = fs.readFileSync(path.join(ROOT, 'azure', 'modules', 'search-existing.bicep'), 'utf8');
const COSMOS_MODULE = fs.readFileSync(path.join(ROOT, 'azure', 'modules', 'cosmos-nosql.bicep'), 'utf8');
const OBSERVABILITY = fs.readFileSync(path.join(ROOT, 'azure', 'modules', 'observability.bicep'), 'utf8');
const AVAILABILITY = fs.readFileSync(path.join(ROOT, 'azure', 'modules', 'availability.bicep'), 'utf8');
const SEARCH_CONTROLLER = fs.readFileSync(path.join(ROOT, 'src', 'controllers', 'search.js'), 'utf8');
const ROUTES = fs.readFileSync(path.join(ROOT, 'src', 'http', 'routes.js'), 'utf8');
const APIM_MODULE = fs.readFileSync(path.join(ROOT, 'azure', 'modules', 'apim.bicep'), 'utf8');
const DEVBOX_MODULE = fs.readFileSync(path.join(ROOT, 'azure', 'modules', 'devbox.bicep'), 'utf8');
const KEY_VAULT = fs.readFileSync(path.join(ROOT, 'azure', 'modules', 'key-vault.bicep'), 'utf8');
const DEPLOY = fs.readFileSync(path.join(ROOT, 'scripts', 'deploy-infra.sh'), 'utf8');
const AI_SEARCH_PROD_PARAMS = fs.readFileSync(path.join(ROOT, 'azure', 'ai-search.prod.bicepparam'), 'utf8');

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
  ['deploySearch', /^module search '\.\/modules\/ai-search\.bicep' = if \(deployFoundation && deploySearch\) \{$/m,
    'the ai-search module gate — without it prod re-PUTs a service it does not own'],
  ['deploySearch', /^module existingSearchRole '\.\/modules\/search-existing\.bicep' = if \(deployFoundation && !deploySearch\) \{$/m,
    'the search-existing module gate — without it prod gets no grant and no Cosmos link'],
  ['existingSearchEndpoint',
    /^var searchEndpoint = deploySearch \? 'https:\/\/demi-search-\$\{environmentName\}\.search\.windows\.net' : existingSearchEndpoint$/m,
    'the SEARCH_ENDPOINT fallback — a different fallback leaves prod pointing at nothing'],
  // The two keyword kill switches. Unwired they are not a failed deploy either: the module default
  // is the switch OFF, so a turn-on set anywhere else is reverted by the next whole-collection PUT.
  ['searchIndexActivities', /^\s+searchIndexActivities: searchIndexActivities$/m,
    'the API module call — without it no param file can turn RecentActivity keyword ranking on'],
  ['searchIndexProjectNotifications',
    /^\s+searchIndexProjectNotifications: searchIndexProjectNotifications$/m,
    'the API module call — without it no param file can turn ProjectNotification ranking on'],
  ['deployFoundry', /^module foundry '\.\/modules\/foundry\.bicep' = if \(deployFoundation && deployFoundry\) \{$/m,
    'the foundry module gate — without it prod creates a model account it never queries'],
  ['deployStaticSite', /^module staticSite '\.\/modules\/static-site\.bicep' = if \(deployFoundation && deployStaticSite\) \{$/m,
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
    'the devbox module gate — without it every environment builds a dev-access VM, prod included'],
  ['trustedProxyIps', /^\s+trustedProxyIps: trustedProxyIps$/m,
    'the API module call — without it TRUSTED_PROXY_IPS is empty and caller-ip trusts no proxy hop'],
  // eagle-analytics. Each of these is empty by default, so an unwired one is not a failed deploy:
  // it is an environment that looks configured and writes its audit rows to the old table anyway.
  ['analyticsBackendUrl', /^\s+analyticsBackendUrl: analyticsBackendUrl$/m,
    'the apim module call — without it no param file can publish the /analytics API'],
  // The two analytics header VALUES are no longer parameters — they are vault secrets APIM reads
  // by identifier, asserted below. What stays a parameter is the list of optional names and the
  // sync's namespaces.
  ['optionalSecretNames', /^\s+optionalSecretNames: optionalSecretNames$/m,
    'the key-vault module call — without it no environment can declare the optional secrets it ' +
    'holds, and every optional app setting reads empty'],
  ['syncNamespaces', /^\s+syncNamespaces: syncNamespaces$/m,
    'the secret-sync module call — without it SYNC_NAMESPACES is empty and the sync writes to no ' +
    'OpenShift namespace at all'],
  ['analyticsDcrEndpoint', /^\s+analyticsDcrEndpoint: analyticsDcrEndpoint$/m,
    'the API module call — without it audit rows stay on the DEMI DCR whatever the param file says'],
  ['analyticsDcrImmutableId', /^\s+analyticsDcrImmutableId: analyticsDcrImmutableId$/m,
    'the API module call — an endpoint with no immutable ID addresses no rule, so the app reads OFF'],
  ['analyticsWorkspaceCustomerId', /^\s+analyticsWorkspaceCustomerId: analyticsWorkspaceCustomerId$/m,
    'the API module call — without it GET /admin/audit never sees the rows written since the repoint'],
  ['searchDefinitionsQueue', /^\s+searchDefinitionsQueue: searchDefinitionsQueue$/m,
    'the API module call — without it the app setting reads empty and the apply route answers 503']
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
    ['cosmosEndpoint', /^\s+cosmosEndpoint: cosmosEndpoint$/m],
    ['searchEndpoint', /^\s+searchEndpoint: searchEndpoint$/m],
    ['eagleApiBase', /^\s+eagleApiBase: eagleApiBase$/m],
    ['identityId', /^\s+identityId: identityId$/m],
    // Not identityId: the CLI needs the client id to name which identity IMDS should hand back.
    ['identityClientId', /^\s+identityClientId: identityClientId$/m],
    ['subnetId', /^\s+subnetId: devboxSubnetId$/m],
    // Without this the VM takes an empty key and Microsoft.Compute refuses it mid-apply.
    ['sshPublicKey', /^\s+sshPublicKey: devboxSshPublicKey$/m]
  ];

  for (const [name, pattern] of wiring) {
    assert.match(block, pattern, `the devbox module's ${name} is not wired, or is wired to something else`);
  }
});

// The landing-zone identity is deliberately absent: listing it needs assign/action on an identity in
// a management subscription this deployer cannot see, so an apply would fail LinkedAuthorizationFailed.
// Policy Deploy-VM-Monitoring re-attaches it after every write, so the template only carries our own.
test('the devbox lists only the identity we own', () => {
  const identityBlock = /identity: \{[\s\S]*?\n {2}\}\n/.exec(DEVBOX_MODULE);
  assert.ok(identityBlock, 'devbox.bicep must declare an identity block');
  const IDENTITY_BLOCK = identityBlock[0];

  assert.match(IDENTITY_BLOCK, /^\s+type: 'SystemAssigned, UserAssigned'$/m,
    'the policy adds a system-assigned identity after creation; UserAssigned alone removes it again');

  const entries = IDENTITY_BLOCK.match(/^\s+'[^']+':\s*\{\}$/gm) || [];
  assert.strictEqual(entries.length, 1,
    'userAssignedIdentities must carry exactly one entry, the identity this template owns');
  assert.match(entries[0], /'\$\{identityId\}':\s*\{\}/,
    'the app identity is the one entry the template may attach');

  assert.doesNotMatch(IDENTITY_BLOCK, /union\(/,
    'union() would merge in an identity the deployer cannot see, and what-if reports the merge as a diff');
  assert.doesNotMatch(IDENTITY_BLOCK, /platformIdentityId/,
    'a cross-subscription identity in the payload fails the apply, it does not just quiet the what-if');

  // The Compute API returns no diskSizeGB for an image-default disk, so a value here is a
  // permanent what-if addition and a shrink risk against a disk that was grown by hand.
  assert.doesNotMatch(DEVBOX_MODULE, /^\s+diskSizeGB: /m,
    'the os disk size must come from the image, not from the template');
});

// customData is immutable once the VM exists, and it is base64(cloudInit) — a comment edit inside the
// template is a property change to Microsoft.Compute, which is how #325 broke the prod apply. This
// pins the text so an edit fails here instead of half way through a deploy.
test('the devbox cloud-init text is frozen', () => {
  const block = /var cloudInitTemplate = '''\n([\s\S]*?)\n'''\n/.exec(DEVBOX_MODULE);
  assert.ok(block, 'devbox.bicep must declare cloudInitTemplate as a multi-line string');

  const hash = crypto.createHash('sha256').update(block[1]).digest('hex');
  assert.strictEqual(hash, '4999c3a8b78d7ff0dc178a0734495e4604f9b472694acec4a61be33560995503',
    'cloudInitTemplate changed. customData cannot be altered on a VM that already exists: the next '
    + 'apply fails with PropertyChangeNotAllowed on osProfile.customData. Put the explanation in a '
    + 'bicep // comment outside the string, or recreate the VM and repin this hash.');
});

// That pin is not enough on its own: customData is base64(cloudInit), not of the template, so the
// deployed text also moves when a substituted value or the substitution chain moves — changing
// `param adminUsername string = 'demi'` or dropping one replace() leaves the template byte-identical
// and still ships different customData. The span covers every param declared between that default
// and the end of the chain, because each one is a module-local default that feeds the same string.
test('the devbox cloud-init inputs are frozen', () => {
  const span = /^param adminUsername string[\s\S]*?^var cloudInit = replace\([\s\S]*?^\)$/m
    .exec(DEVBOX_MODULE);
  assert.ok(span, 'devbox.bicep must declare adminUsername above the cloudInit substitution chain');

  const hash = crypto.createHash('sha256').update(span[0]).digest('hex');
  assert.strictEqual(hash, 'e4acd1105d1a4bfa524ece24b322e502117820d2888e0d38117496feb900927d',
    'a cloud-init input changed: a param default, or the replace() chain that builds cloudInit. '
    + 'customData is base64 of that result and cannot be altered on a VM that already exists: the '
    + 'next apply fails with PropertyChangeNotAllowed on osProfile.customData. Recreate the VM, or '
    + 'repin this hash if the substituted result is provably unchanged.');
});

// Entra SSH login for the devbox, off by default; see modules/devbox.bicep
test('the devbox Entra SSH extension and login role render only when enabled', () => {
  const extension = /resource aadSshLogin '([^']+)' = if \((.*)\) \{([\s\S]*?)\n\}\n/.exec(DEVBOX_MODULE);
  assert.ok(extension, 'devbox.bicep must declare the AAD SSH extension as a gated resource');
  assert.strictEqual(extension[2], 'enableEntraSsh',
    'the extension must be gated on enableEntraSsh alone, so a blank principal still installs nothing extra');
  assert.match(extension[3], /^\s+parent: devbox$/m,
    'a child of the VM, not a standalone resource with a slash-joined name');
  assert.match(extension[3], /^\s+publisher: 'Microsoft\.Azure\.ActiveDirectory'$/m);
  assert.match(extension[3], /^\s+type: 'AADSSHLoginForLinux'$/m);
  assert.match(extension[3], /^\s+typeHandlerVersion: '1\.0'$/m);
  assert.match(extension[3], /^\s+autoUpgradeMinorVersion: true$/m);

  const role = /resource entraSshUserLogin '([^']+)' = if \((.*)\) \{([\s\S]*?)\n\}\n/.exec(DEVBOX_MODULE);
  assert.ok(role, 'devbox.bicep must declare the VM login role assignment as a gated resource');
  assert.strictEqual(role[2], 'enableEntraSsh && !empty(entraSshPrincipalId)',
    'an empty principal id in a roleAssignment fails the apply, so the gate must cover both');
  assert.match(role[3], /^\s+scope: devbox$/m,
    'VM scope only — at resource group scope this would grant login on every VM in the group');
  assert.match(role[3], /^\s+name: guid\(devbox\.id, entraSshPrincipalId, virtualMachineUserLoginRoleId\)$/m,
    'the name must be deterministic, or a second apply creates a duplicate assignment');

  // Virtual Machine User Login. Administrator Login (1c0163c0-…) would carry sudo, which no one
  // needs: work on the box runs through demi-run or `sudo -u demi`.
  assert.match(DEVBOX_MODULE, /^var virtualMachineUserLoginRoleId = 'fb879df8-f326-4884-b1cf-06f3ad86be52'$/m,
    'the role id must stay Virtual Machine User Login');

  // Both default to off, so an environment that has not asked for this gets nothing.
  assert.match(DEVBOX_MODULE, /^param enableEntraSsh bool = false$/m);
  assert.match(DEVBOX_MODULE, /^param entraSshPrincipalId string = ''$/m);

  // main.bicep must pass them through, or the param files above set a value that never arrives.
  const call = MAIN.split(/^module /m).find(b => b.includes("'./modules/devbox.bicep'"));
  assert.match(call, /^\s+enableEntraSsh: devboxEnableEntraSsh$/m,
    'the devbox module gate is not wired to the main.bicep param');
  assert.match(call, /^\s+entraSshPrincipalId: devboxEntraSshPrincipalId$/m,
    'the devbox principal id is not wired to the main.bicep param');
  for (const [name, params] of [['test', TEST_PARAMS], ['prod', PROD_PARAMS]]) {
    assert.match(params, /^param devboxEnableEntraSsh = false$/m,
      `${name} must state the switch explicitly rather than inherit a default that can move`);
    assert.match(params, /^param devboxEntraSshPrincipalId = ''$/m,
      `${name} must state the principal explicitly`);
  }
});

// The two new params must sit BELOW the substitution chain the test above pins. Declared between
// `param adminUsername` and `var cloudInit = replace(`, they land inside that span, its hash moves,
// and the frozen-inputs test fails for a reason that has nothing to do with cloud-init.
test('the Entra SSH params stay outside the frozen cloud-init span', () => {
  const chainEnd = DEVBOX_MODULE.indexOf('\nvar cloudInit = replace(');
  assert.ok(chainEnd > 0, 'devbox.bicep must build cloudInit through a replace() chain');
  for (const name of ['enableEntraSsh', 'entraSshPrincipalId']) {
    const at = DEVBOX_MODULE.search(new RegExp(`^param ${name} `, 'm'));
    assert.ok(at > chainEnd,
      `param ${name} is declared above the cloudInit chain, which makes it a customData input`);
  }
});

// Read off demi-apim-test and demi-apim-prod, both Disabled (2026-09-06). Omitted, the API version's
// default is Enabled, so every apply proposes switching the deprecated portal back on.
test('the gateway pins the legacy developer portal off', () => {
  assert.match(APIM_MODULE, /^\s+legacyPortalStatus: 'Disabled'$/m,
    'legacyPortalStatus must be set on the service, or the apply turns the legacy portal on');
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

// The four plain eagle-analytics settings. Empty is the correct value until that estate exists, but
// the LINE has to be there: these are whole-collection-PUT app settings, so a param file that stops
// naming one takes main.bicep's empty default and a live value is deleted on the next deploy —
// silently repointing audit rows back at the old table. `az bicep build` says nothing either way.
for (const [envName, params] of [['test', TEST_PARAMS], ['prod', PROD_PARAMS]]) {
  for (const name of ['analyticsBackendUrl', 'analyticsDcrEndpoint', 'analyticsDcrImmutableId',
    'analyticsWorkspaceCustomerId']) {
    test(`the ${envName} param file declares ${name}`, () => {
      assert.match(params, new RegExp(`^param ${name} = '[^']*'$`, 'm'),
        `${envName} must state ${name} explicitly, empty or otherwise`);
    });
  }
}

// The audit stream has to travel with the DCR it is sent to. Each rule declares one of the two
// tables and rejects the other, so a deploy that takes the endpoint from one side and the stream
// name from the other loses every audit row to a 400 the app can only log. Nothing in
// `az bicep build` or a what-if diff pairs them; both branches were mutable with the suite green.
test('the audit stream name is decided by the same gate as the audit DCR endpoint', () => {
  const setting = (name) => new RegExp(`name: '${name}'\\n\\s+value: ([^\\n]+)`).exec(API_MODULE);

  const endpoint = setting('AUDIT_DCR_ENDPOINT');
  assert.ok(endpoint, 'api-function-flex.bicep must set AUDIT_DCR_ENDPOINT');
  assert.strictEqual(endpoint[1], 'analyticsAuditConfigured ? analyticsDcrEndpoint : auditDcrEndpoint');

  const stream = setting('AUDIT_STREAM_NAME');
  assert.ok(stream, 'without AUDIT_STREAM_NAME the app writes DemiAudit_CL to whatever rule it holds');
  assert.strictEqual(stream[1],
    'analyticsAuditConfigured ? \'Custom-EagleAudit_CL\' : \'Custom-DemiAudit_CL\'',
    'the stream must be chosen by the same gate as the endpoint, or the pair can be crossed');

  // Usage counters do NOT move: DemiEvents_CL exists only in the DEMI rule, and its hourly rollup
  // is what GET /admin/analytics reads.
  const events = setting('EVENTS_DCR_ENDPOINT');
  assert.ok(events, 'api-function-flex.bicep must set EVENTS_DCR_ENDPOINT');
  assert.strictEqual(events[1], 'auditDcrEndpoint');

  assert.match(API_MODULE,
    /^var analyticsAuditConfigured = !empty\(analyticsDcrEndpoint\) && !empty\(analyticsDcrImmutableId\)$/m,
    'a half-set pair must read as OFF, not as a rule with no id');
});

// Which analytics routes need a subscription key. A browser cannot hold one, so moving a read route
// under the keyed API breaks the DEMI admin screens with a 401 the gateway issues before any policy
// runs — and moving `/audit` the other way opens a write path to anyone. `az bicep build` compiles
// both arrangements. Text-structural, with the same honest limits as the guards above.
test('the analytics read routes are anonymous and only /audit takes a key', () => {
  const blocks = APIM_MODULE.split(/^resource /m);
  const block = (name) => blocks.find((b) => b.startsWith(`${name} `));
  const isOperation = (b) => /Microsoft\.ApiManagement\/service\/apis\/operations@/.test(b.split('\n')[0]);

  const bearer = block('analyticsBearerOperationResources');
  assert.ok(bearer, 'apim.bicep must declare the bearer operations');
  assert.match(bearer, /^\s+parent: analyticsApi$/m,
    'the read routes belong to the anonymous API — the app authorises them on the Keycloak bearer');

  const keyed = blocks.filter((b) => isOperation(b) && /^\s+parent: analyticsMachineApi$/m.test(b));
  assert.strictEqual(keyed.length, 1, 'the keyed API must carry exactly one operation');
  assert.match(keyed[0], /urlTemplate: '\/audit'$/m, 'and that operation is POST /audit');
  assert.match(keyed[0], /method: 'POST'$/m);

  for (const urlTemplate of ["'/query'", "'/query/schema'", "'/dashboards'", "'/dashboards/*'"]) {
    assert.ok(APIM_MODULE.includes(`urlTemplate: ${urlTemplate}`),
      `${urlTemplate} must still be declared, or the gateway 404s it`);
  }
});

// The read routes carry a bearer, so their CORS list is named rather than `*`, and the browser cannot
// send that header at all unless it is allowed by name. Neither is visible in a what-if diff.
test('the analytics read routes allow the admin origins and the Authorization header', () => {
  const policy = /var analyticsBearerCorsPolicy = replace\('''([\s\S]*?)''',/.exec(APIM_MODULE);
  assert.ok(policy, 'apim.bicep must build a CORS policy for the bearer operations');

  assert.match(policy[1], /<header>Authorization<\/header>/,
    'without this the browser cannot send the token the app authorises on');
  assert.match(policy[1], /<header>Content-Type<\/header>/);
  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
    assert.match(policy[1], new RegExp(`<method>${method}</method>`), `${method} must be allowed`);
  }
  assert.doesNotMatch(policy[1], /<origin>\*<\/origin>/,
    'a wildcard origin is the wrong answer for a request carrying a bearer');
  assert.match(policy[1], /^__ORIGINS__$/m, 'the origins are substituted in, one element each');

  // Empty list, no policy: an <allowed-origins> with no child is invalid XML and APIM rejects the PUT.
  assert.match(APIM_MODULE,
    /resource analyticsBearerOperationPolicies [^\n]*\[for \(operation, index\) in analyticsBearerOperations: if \(analyticsDeployed && !empty\(analyticsBrowserOrigins\)\) \{/,
    'the policy must be gated on there being at least one origin');

  // Built from frontendHostNames, not listed a second time: those hostnames carry a deploy-time hash.
  assert.match(MAIN, /^var analyticsAdminOrigins = concat\($/m,
    'main.bicep must derive the origins rather than take them as a parameter');
  assert.match(MAIN, /filter\(frontendHostNames, host => startsWith\(host, 'demi-admin'\)\)/,
    'the admin app is the only frontend that builds a query');
  // Unconditionally appended, this would sit alongside the real admin host below and give a
  // developer's machine the same standing as the deployed prod frontend.
  assert.match(MAIN, /environmentName == 'prod' \? \[\] : \[ 'http:\/\/localhost:4200' \]/,
    'localhost is a developer origin and must never be appended in prod');

  // Prod now has one DEMI frontend, the admin console on eagle-edge-prod. Its origin list holds
  // exactly that host and nothing else — no eagle-public entry, no leftover eagle-search host.
  const frontendMatch = /^param frontendHostNames = \[([\s\S]*?)\]$/m.exec(PROD_PARAMS);
  assert.ok(frontendMatch, 'prod must declare frontendHostNames explicitly');
  const prodFrontendHosts = [...frontendMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.strictEqual(prodFrontendHosts.length, 1,
    'prod has exactly one DEMI frontend, the admin console — a second entry is undocumented');
  assert.match(prodFrontendHosts[0], /^demi-admin-/,
    'the one prod frontend host is the DEMI admin console');
  assert.match(prodFrontendHosts[0], /\.azurefd\.net$/,
    'the admin console is served from Front Door, not composed by hand');

  assert.match(MAIN, /^\s+analyticsBrowserOrigins: analyticsAdminOrigins$/m,
    'declared but unwired means every browser request is refused at the gateway');
});

// The shape of the trusted-proxy list, which nothing else guards: a typo passes lint,
// `az bicep build-params` and the whole suite, and only surfaces as a config.js throw when the app
// next starts. Fed through the real validator rather than a copy of its regex.
for (const [envName, params] of [['test', TEST_PARAMS], ['prod', PROD_PARAMS]]) {
  test(`the ${envName} param file's trustedProxyIps is a value the app can boot on`, () => {
    const match = /^param trustedProxyIps = '([^']*)'$/m.exec(params);
    assert.ok(match, `${envName} must state trustedProxyIps explicitly, empty or otherwise`);

    const CONFIG = path.join(ROOT, 'src', 'config');
    const previous = process.env.TRUSTED_PROXY_IPS;
    process.env.TRUSTED_PROXY_IPS = match[1];
    delete require.cache[require.resolve(CONFIG)];
    try {
      assert.deepStrictEqual(require(CONFIG).trustedProxyIps,
        match[1].split(',').map((s) => s.trim()).filter(Boolean),
        'every entry must survive src/config.js as an address the proxy check can compare');
    } finally {
      if (previous === undefined) delete process.env.TRUSTED_PROXY_IPS;
      else process.env.TRUSTED_PROXY_IPS = previous;
      delete require.cache[require.resolve(CONFIG)];
    }
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
  assert.match(block, /^\s+cosmosAccountId: cosmosAccountId$/m,
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
// on: a vault that was never given the secret must produce no URI, an empty URI must leave the app
// setting empty rather than pointing at nothing, and an environment that names a host must name the
// secret. Break any one and either the app setting carries an unresolvable
// `@Microsoft.KeyVault(...)` literal, or a test environment goes dark while looking configured.
// `az bicep build` says nothing about either.
test('the eagle-notify key is optional in the vault and empty where it was never set', () => {
  assert.match(KEY_VAULT,
    /^output notifyApiKeySecretUri string = contains\(optionalSecretNames, 'notify-api-key'\) \? '\$\{secretUriBase\}notify-api-key' : ''$/m,
    'an environment that did not name the secret must get an empty URI — there is nothing in the ' +
    'vault for a reference to resolve against');
  assert.match(API_MODULE,
    /value: empty\(notifyApiKeySecretUri\) \? '' : '@Microsoft\.KeyVault\(SecretUri=\$\{notifyApiKeySecretUri\}\)'/,
    'without the empty branch a dark environment gets a Key Vault reference to no secret, which ' +
    'App Service leaves in the setting verbatim');
  assert.match(MAIN, /^\s+notifyApiKeySecretUri: notifyApiKeySecretUri$/m,
    'main.bicep must pass the vault URI into the API module — without it the reference names nothing');

  // No value for the key anywhere in the templates: it is set by hand in the vault.
  assert.doesNotMatch(MAIN, /^param notifyApiKey /m,
    'the key must not be a parameter again — a parameter is a value in ARM deployment history');
});

// The host and the secret name are set in the same file and mean nothing apart: a named host with
// no secret is an environment that looks configured and pushes nothing, and a named secret with no
// host is a credential nobody reads.
test('test names both the eagle-notify host and its vault secret', () => {
  const base = /^param notifyApiBase = '([^']*)'$/m.exec(TEST_PARAMS);
  assert.ok(base, 'test must state notifyApiBase');
  assert.notStrictEqual(base[1], '', 'test announces to eagle-notify, so it must name the host');
  assert.match(TEST_PARAMS, /^\s+'notify-api-key'$/m,
    'and name notify-api-key in optionalSecretNames, or NOTIFY_API_KEY deploys empty and the push ' +
    'is dark while the host says otherwise');
});

test('prod names neither the eagle-notify host nor its vault secret', () => {
  const base = /^param notifyApiBase = '([^']*)'$/m.exec(PROD_PARAMS);
  assert.ok(base, 'prod must state notifyApiBase, empty or otherwise');
  assert.strictEqual(base[1], '', 'prod has no eagle-notify to announce to yet');
  assert.doesNotMatch(PROD_PARAMS, /'notify-api-key'/,
    'naming the secret prod never set makes the deploy check demand a credential prod does not use');
});

// Reader links point update emails at /updates/:id, which only eagle-public's React line serves.
// Prod and test still serve the Angular site there, so turning it on sends every email to a 404.
test('update reader links reach the app setting and stay off in test and prod', () => {
  assert.match(MAIN, /^\s+notifyUpdateReaderLinks: notifyUpdateReaderLinks$/m,
    'main.bicep must pass the flag to the API module, or a bicepparam value never lands');
  assert.match(API_MODULE,
    /name: 'NOTIFY_UPDATE_READER_LINKS'\s+value: notifyUpdateReaderLinks \? 'true' : 'false'/,
    'src/config.js reads exactly the string true');
  assert.doesNotMatch(TEST_PARAMS, /^param notifyUpdateReaderLinks = true/m,
    'test.projects.eao.gov.bc.ca serves the Angular site, which has no /updates route');
  assert.doesNotMatch(PROD_PARAMS, /^param notifyUpdateReaderLinks = true/m,
    'projects.eao.gov.bc.ca serves the Angular site, which has no /updates route');
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
test('the API app reads ADMIN_API_KEY through a Key Vault reference', () => {
  const setting = API_MODULE
    .split(/^\s+\{$/m)
    .find(b => /name: 'ADMIN_API_KEY'/.test(b));
  assert.ok(setting, 'no ADMIN_API_KEY app setting declared at all');
  assert.match(setting, /value: '@Microsoft\.KeyVault\(SecretUri=\$\{adminApiKeySecretUri\}\)'/,
    'the setting must be a Key Vault reference, not the credential itself');
  assert.doesNotMatch(API_MODULE, /value: adminApiKey$/m,
    'no app setting may carry the raw adminApiKey value');

  assert.match(MAIN, /^\s+adminApiKeySecretUri: adminApiKeySecretUri$/m,
    'main.bicep must pass the vault URI into the API module — without it the reference names nothing');
  assert.match(MAIN, /^module keyVault '\.\/modules\/key-vault\.bicep' = if \(deployFoundation\) \{$/m,
    'and the vault module must be instantiated');
});

// Without the grant the reference resolves to nothing, App Service leaves the literal
// `@Microsoft.KeyVault(...)` string in the setting, and every admin call 401s against a credential
// that looks configured. `az bicep build` exits 0 with the assignment deleted.
test('the app identity is granted Key Vault Secrets User', () => {
  assert.match(KEY_VAULT, /'4633458b-17de-408a-b874-0445c86b69e6'/,
    'Key Vault Secrets User is the role that reads secret VALUES; no other built-in role does');
  assert.match(KEY_VAULT, /principalId: identityPrincipalId/,
    'the assignment must target the identity the API runs as');
  assert.match(KEY_VAULT, /enableRbacAuthorization: true/,
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

    assert.match(MAIN, new RegExp(`^\\s+${paramName}Uri: ${paramName}Uri$`, 'm'),
      'main.bicep must pass the vault URI into the API module — without it the reference names nothing');
    assert.doesNotMatch(MAIN, new RegExp(`^param ${paramName} `, 'm'),
      `${paramName} must not be a parameter again — the value would sit in ARM deployment history, ` +
      'and a deploy that forgot it would blank the live credential');
    assert.match(KEY_VAULT, new RegExp(`^\\s+'${secretName}'$`, 'm'),
      `key-vault.bicep must list ${secretName} among the names the vault has to hold, or ` +
      'deploy-infra.sh never checks for it');
    assert.match(KEY_VAULT, new RegExp(`^output ${paramName}Uri string = '\\$\\{secretUriBase\\}${secretName}'$`, 'm'),
      'and compose its VERSIONLESS uri from the vault uri, so a rotation needs a new secret ' +
      'version and a restart rather than an infrastructure deploy');
  }
});

// The edge secret is what makes the app believe X-Azure-SocketIP, and it is optional in the same
// three-file shape the notify key is: an empty value writes no Key Vault secret, an empty URI
// leaves the app setting empty, and the deploy script sources it without demanding it. Delete the
// app-setting block or rename the variable and `az bicep build` still exits 0 — the app would then
// silently key every Front Door visitor on one shared anonymous quota row.
test('the API app reads EDGE_SECRET through a Key Vault reference', () => {
  const setting = API_MODULE
    .split(/^\s+\{$/m)
    .find(b => /name: 'EDGE_SECRET'/.test(b));
  assert.ok(setting, 'no EDGE_SECRET app setting declared at all — src/config.js would read nothing');
  assert.match(setting, /value: empty\(edgeSecretUri\) \? '' : '@Microsoft\.KeyVault\(SecretUri=\$\{edgeSecretUri\}\)'/,
    'the setting must be a Key Vault reference bound to edgeSecretUri, never the secret itself, ' +
    'and empty where no secret was written — a reference to no secret resolves to the literal');
  assert.doesNotMatch(API_MODULE, /value: edgeSecret$/m,
    'no app setting may carry the raw edgeSecret value');

  assert.doesNotMatch(MAIN, /^param edgeSecret /m,
    'the secret must not be a parameter again — a parameter is a value in ARM deployment history, ' +
    'and a forgotten export would blank the live one');
  assert.match(MAIN, /^\s+edgeSecretUri: edgeSecretUri$/m,
    'main.bicep must pass the vault URI into the API module — without it the reference names nothing');

  assert.match(KEY_VAULT,
    /^output edgeSecretUri string = contains\(optionalSecretNames, 'edge-secret'\) \? '\$\{secretUriBase\}edge-secret' : ''$/m,
    'an environment that did not name the secret must get an empty URI, and the URI must be the ' +
    'VERSIONLESS one, so a rotation is a new secret version plus a recycle');

  // Both environments have a Front Door in front of them, so both must name the secret. Dropping
  // the name from either param file blanks EDGE_SECRET on the next infrastructure deploy, and the
  // app stops trusting the edge's forwarded caller address.
  assert.match(TEST_PARAMS, /^\s+'edge-secret'$/m,
    'test sits behind eagle-edge-test, so an unnamed edge-secret puts every visitor arriving ' +
    'through Front Door on one shared anonymous quota key');
  assert.match(PROD_PARAMS, /^\s+'edge-secret'$/m,
    'prod sits behind eagle-edge-prod and the vault holds the value, so an unnamed edge-secret ' +
    'puts every visitor arriving through Front Door on one shared anonymous quota key');

  assert.doesNotMatch(DEPLOY, /EDGE_SECRET/,
    'the deploy script must not source the value at all any more — the vault holds it and the ' +
    'script checks names only');
});

// The object-store pair and the extraction host key, the three credentials that used to arrive as
// @secure() parameters and land in app settings verbatim. A revert is invisible twice over: `az
// bicep build` compiles a plain value, and what-if masks a @secure() one in BOTH before and after,
// so a deploy that blanked a live credential renders as no change at all.
const VAULT_SETTINGS = [
  ['MINIO_ACCESS_KEY', 'minioAccessKeySecretUri', 'minio-access-key'],
  ['MINIO_SECRET_KEY', 'minioSecretKeySecretUri', 'minio-secret-key'],
  ['DOCLING_API_KEY', 'doclingApiKeySecretUri', 'docling-api-key']
];

for (const [settingName, paramName, secretName] of VAULT_SETTINGS) {
  test(`the API app reads ${settingName} through a Key Vault reference`, () => {
    const setting = API_MODULE
      .split(/^\s+\{$/m)
      .find(b => new RegExp(`name: '${settingName}'`).test(b));
    assert.ok(setting, `no ${settingName} app setting declared at all`);
    assert.match(setting, new RegExp(`value: '@Microsoft\\.KeyVault\\(SecretUri=\\$\\{${paramName}\\}\\)'`),
      `${settingName} must be a Key Vault reference, not the credential itself`);

    assert.match(MAIN, new RegExp(`^\\s+${paramName}: ${paramName}$`, 'm'),
      'main.bicep must pass the vault URI into the API module — without it the reference names nothing');
    assert.match(KEY_VAULT, new RegExp(`^\\s+'${secretName}'$`, 'm'),
      `key-vault.bicep must list ${secretName} among the names the vault has to hold, or ` +
      'deploy-infra.sh never checks for it and the setting resolves to nothing');
    assert.match(KEY_VAULT, new RegExp(`^output ${paramName} string = '\\$\\{secretUriBase\\}${secretName}'$`, 'm'),
      'and compose its VERSIONLESS uri from the vault uri, so a rotation is a new secret version ' +
      'plus a recycle rather than an infrastructure deploy');
  });
}

// The single statement that makes the whole estate safe: with no @secure() parameter left, there is
// no credential a deploy can carry, and therefore none it can blank. Every one is set by hand in the
// vault and read by reference. A re-added parameter compiles, deploys, and reads as no change in
// what-if — which is exactly the failure this change exists to remove.
test('main.bicep carries no credential values at all', () => {
  assert.doesNotMatch(MAIN, /^@secure\(\)$/m,
    'a @secure() parameter is a credential in the deployment inputs and in ARM history — the vault ' +
    'holds the values now, and main.bicep passes only secret URIs');

  // The vault URI is composed once, so a missing slash cannot differ between names, and versionless
  // so App Service re-reads a rotation on its own.
  assert.match(KEY_VAULT, /^var secretUriBase = '\$\{vault\.properties\.vaultUri\}secrets\/'$/m,
    'every secret URI must be composed from the live vault uri, not from a name pattern');
  assert.doesNotMatch(KEY_VAULT, /secretUriWithVersion/,
    'a versioned identifier pins the app to one version, so a rotation becomes an infrastructure ' +
    'deploy instead of a recycle');
});

// The sync app is what copies vault secrets into OpenShift, and every part of its gate matters: the
// environment has to ask for it, it needs the namespaces it owns, and it needs a subnet to reach the
// vault's private endpoint from. Deployed with an empty namespace list it runs and writes nowhere;
// `az bicep build` compiles that.
test('the secret sync is deployed only where it is asked for and namespaces are named', () => {
  const block = MAIN.split(/^module /m).find(b => b.includes("'./modules/secret-sync.bicep'"));
  assert.ok(block, 'main.bicep must call the secret-sync module');
  assert.match(block.split('\n')[0],
    /= if \(deploySecretSync && !empty\(syncNamespaces\) && !empty\(apiFlexSubnetId\)\)/,
    'an environment that asks for no sync app or names no namespace must get none, and one with ' +
    'no subnet cannot reach the vault private endpoint at all');

  assert.match(block, /^\s+keyVaultName: vaultName$/m,
    'the sync must be told which vault to read, or it has nothing to copy');
  assert.match(block, /^\s+syncNamespaces: syncNamespaces$/m,
    'and which namespaces it owns — empty writes to none while the app still runs');
  assert.match(block, /^\s+identityPrincipalId: identityPrincipalId$/m,
    'it reads the vault as the identity that holds the Secrets User grant');

  // Prod runs no sync app: its spoke has no route table, so the app could not reach the OpenShift
  // API, and prod OpenShift secrets are set by hand instead.
  assert.match(PROD_PARAMS, /^param deploySecretSync = false$/m,
    'a prod deploy must create no sync app');
  assert.doesNotMatch(PROD_PARAMS, /^param syncNamespaces =/m,
    'naming prod namespaces would say a prod sync app owns them');
  assert.match(TEST_PARAMS, /^param syncNamespaces = '6cdc9e-dev,6cdc9e-test'$/m,
    'the nonprod vault serves both nonprod namespaces, and neither is prod');

  // The output that names the sync app to the caller must gate on the exact same condition as the
  // module itself — a looser output would report an app name for an environment the module never
  // deployed.
  assert.match(MAIN, /^output secretSyncAppName string = \(deploySecretSync && /m,
    'the output must gate on deploySecretSync too, or a caller reads a sync app name for an ' +
    'environment that asked for none');
});

// The access curtain's password, same shape as EDGE_SECRET above and the same reason for a
// text-structural guard: `az bicep build` exits 0 with the app setting deleted, and the failure is
// silent in the wrong direction — an empty ACCESS_GATE_PASSWORD makes POST /api/gate answer 404, so
// an environment that means to be gated would serve the whole site to anyone who asked.
test('the API app reads ACCESS_GATE_PASSWORD through a Key Vault reference', () => {
  const setting = API_MODULE
    .split(/^\s+\{$/m)
    .find(b => /name: 'ACCESS_GATE_PASSWORD'/.test(b));
  assert.ok(setting, 'no ACCESS_GATE_PASSWORD app setting declared at all — the curtain would 404');
  assert.match(setting, /value: empty\(accessGateSecretUri\) \? '' : '@Microsoft\.KeyVault\(SecretUri=\$\{accessGateSecretUri\}\)'/,
    'the setting must be a Key Vault reference bound to accessGateSecretUri, never the ' +
    'password itself, and empty where no secret was written');
  assert.doesNotMatch(API_MODULE, /value: accessGatePassword$/m,
    'no app setting may carry the raw password value');

  assert.doesNotMatch(MAIN, /^param accessGatePassword /m,
    'the password must not be a parameter again — a parameter is a value in ARM deployment ' +
    'history, and a forgotten export would blank the live one');
  assert.match(MAIN, /^\s+accessGateSecretUri: accessGateSecretUri$/m,
    'main.bicep must pass the vault URI into the API module — without it the reference names nothing');

  assert.doesNotMatch(KEY_VAULT, /value: accessGatePassword/,
    'the vault template must not write the password value — it carries no secret value at all');
  assert.match(KEY_VAULT,
    /^output accessGateSecretUri string = contains\(optionalSecretNames, 'access-gate-password'\) \? '\$\{secretUriBase\}access-gate-password' : ''$/m,
    'an environment that did not name the secret must get an empty URI, and the URI must be the ' +
    'VERSIONLESS one, so a rotation is a new secret version plus a recycle');

  // Test runs the curtain and prod runs ungated, so the name is on exactly one of them.
  assert.match(TEST_PARAMS, /^\s+'access-gate-password'$/m,
    'test runs the curtain, so an unnamed access-gate-password leaves POST /api/gate answering ' +
    '404 for everyone');
  assert.doesNotMatch(PROD_PARAMS, /'access-gate-password'/,
    'prod runs ungated — naming the secret there would gate the public site on a value nobody set');

  assert.doesNotMatch(DEPLOY, /ACCESS_GATE_PASSWORD/,
    'the deploy script must not source the value at all any more — the vault holds it and the ' +
    'script checks names only');
});

// The gateway secret is what makes the app trust an APIM-asserted subscription, and both halves of
// that trust are text-structural: a plain-value app setting would put the secret in the template
// and in ARM history, and a global policy that sets the two headers without deleting the client's
// copies first would let anyone reach the app directly and assert any subscription they like — the
// Function App host stays public, because Consumption APIM has no VNet. `az bicep build` exits 0
// either way. Same honest limits as the guards above. APIM_MODULE is read at the top of this file.

test('the Flex app reads APIM_GATEWAY_SECRET through a Key Vault reference', () => {
  const setting = API_MODULE
    .split(/^\s+\{$/m)
    .find(b => /name: 'APIM_GATEWAY_SECRET'/.test(b));
  assert.ok(setting, 'no APIM_GATEWAY_SECRET app setting declared at all');
  assert.match(setting, /value: apimGatewaySecretRef$/m,
    'the setting must carry the reference parameter, never a literal');

  assert.match(MAIN, /apimGatewaySecretRef: deployApim \? '@Microsoft\.KeyVault\(VaultName=\$\{vaultName\};SecretName=\$\{apimGatewaySecretName\}\)' : ''/,
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

// The analytics APIs get their own trust header, and the same ordering rule applies: a client copy
// left in place would let anyone reach that Function's public host directly. DEMI's own gateway
// secret has to come OFF, too — it proves nothing to another app's backend and would otherwise sit
// in its request logs. `az bicep build` compiles every arrangement of these lines.
//
// The policies are composed from fragments, so the test resolves them the way apim.bicep does and
// asserts on the finished XML — asserting on a fragment would pass a stamp that moved to the wrong
// API. `analytics` is anonymous, so a client-sent X-Analytics-Audit reaching the backend there is
// the whole attack; only `analytics-machine` may ever stamp one.
function analyticsPolicies() {
  const fragment = (name) => {
    const hit = new RegExp(`var ${name} = '''([\\s\\S]*?)'''`).exec(APIM_MODULE);
    assert.ok(hit, `apim.bicep must declare ${name}`);
    return hit[1];
  };
  const head = fragment('analyticsInboundHead');
  const tail = fragment('analyticsInboundTail');
  const stamp = fragment('analyticsAuditStamp');

  // The compositions, read from the file rather than assumed: a stamp added to the anonymous one is
  // exactly the mistake this test exists to catch.
  assert.match(APIM_MODULE,
    /^var analyticsPolicyXml = '\$\{analyticsInboundHead\}\$\{analyticsInboundTail\}'$/m,
    'the anonymous policy is head + tail, with no audit stamp between them');
  assert.match(APIM_MODULE,
    /^var analyticsMachinePolicyXml = '\$\{analyticsInboundHead\}\$\{analyticsAuditStamp\}\$\{analyticsInboundTail\}'$/m,
    'the keyed policy is the same head plus the audit stamp');

  return { anonymous: head + tail, machine: head + stamp + tail };
}

test('the analytics APIs strip every client-sent trust header before stamping their own', () => {
  const { anonymous, machine } = analyticsPolicies();

  for (const [apiName, xml] of [['analytics', anonymous], ['analytics-machine', machine]]) {
    const inbound = /<inbound>([\s\S]*?)<\/inbound>/.exec(xml);
    assert.ok(inbound, `${apiName} must have an inbound section`);

    assert.match(inbound[1], /<set-header name="X-Gateway-Secret" exists-action="delete" \/>/,
      "DEMI's gateway secret must come off before the request leaves for eagle-analytics");

    // Both trust headers are deleted on both APIs: a client copy left in place is attacker input.
    for (const header of ['X-Analytics-Gateway', 'X-Analytics-Audit']) {
      assert.ok(inbound[1].includes(`<set-header name="${header}" exists-action="delete" />`),
        `${apiName} must delete a client-supplied ${header}`);
    }

    const del = inbound[1].indexOf('<set-header name="X-Analytics-Gateway" exists-action="delete" />');
    const set = inbound[1].indexOf('<set-header name="X-Analytics-Gateway" exists-action="override">');
    assert.ok(set > del, `${apiName} must delete X-Analytics-Gateway BEFORE setting its own value`);
    assert.match(inbound[1], /<value>\{\{analytics-shared-header\}\}<\/value>/,
      'the value must come from the named value, never a literal in this repository');
  }

  // The audit credential, on the keyed API only. /audit carries both guards; nothing else does.
  const auditSet = '<set-header name="X-Analytics-Audit" exists-action="override">';
  const auditDel = '<set-header name="X-Analytics-Audit" exists-action="delete" />';
  assert.ok(machine.indexOf(auditSet) > machine.indexOf(auditDel),
    'analytics-machine must delete the client copy of X-Analytics-Audit before stamping its own');
  assert.match(machine, /<value>\{\{analytics-audit-header\}\}<\/value>/,
    'and take the value from the named value, never a literal in this repository');
  assert.ok(!anonymous.includes(auditSet),
    'the anonymous API must NEVER stamp an audit credential — POST /audit is served keyed only');
  assert.ok(!anonymous.includes('{{analytics-audit-header}}'),
    'and must not reference that named value at all');

  // Each policy attached to the API it was built for, and each named value it reads created first.
  const block = (name) => {
    const hit = APIM_MODULE.split(/^resource /m).find((b) => b.startsWith(`${name} `));
    assert.ok(hit, `apim.bicep must declare ${name}`);
    return hit;
  };
  assert.match(block('analyticsApiPolicy'), /^\s+value: analyticsPolicyXml$/m,
    'the anonymous API must carry the policy with no audit stamp');
  assert.match(block('analyticsMachineApiPolicy'), /^\s+value: analyticsMachinePolicyXml$/m,
    'the keyed API must carry the policy that stamps both credentials');
  assert.match(block('analyticsMachineApiPolicy'), /^\s+analyticsAuditHeader$/m,
    'and depend on the audit named value, or the policy PUT references one that does not exist yet');

  for (const named of ['analytics-shared-header', 'analytics-audit-header']) {
    assert.match(APIM_MODULE, new RegExp(`name: '${named}'\\n\\s+properties: \\{[\\s\\S]*?secret: true`),
      `${named} must be a secret named value, or its value is readable in the portal and in ARM`);
  }

  // A URL with either secret identifier missing publishes a gateway that 502s what it forwards.
  assert.match(APIM_MODULE,
    /^var analyticsDeployed = !empty\(analyticsBackendUrl\) && !empty\(analyticsSharedHeaderSecretUri\) && !empty\(analyticsAuditHeaderSecretUri\)$/m,
    'a half-set trio must read as not deployed');
});

// The two header values APIM stamps are the same pair eagle-analytics reads, and the vault is the
// one copy either side sees. A named value carrying a literal `value:` compiles just as well, puts
// the secret in this repository's deploy inputs and in ARM history, and makes a rotation a redeploy
// of two repositories instead of a new secret version.
test('the analytics named values are Key Vault-backed, not literals', () => {
  const named = (name) => {
    const hit = APIM_MODULE.split(/^resource /m).find((b) => new RegExp(`\\n  name: '${name}'\\n`).test(b));
    assert.ok(hit, `apim.bicep must declare the ${name} named value`);
    return hit;
  };

  const shared = named('analytics-shared-header');
  assert.match(shared, /^\s+secretIdentifier: analyticsSharedHeaderSecretUri$/m,
    'the gateway must read the value from the vault by identifier');
  assert.doesNotMatch(shared, /^\s+value: /m,
    'a literal value is a second copy of a secret another repository also holds');

  const audit = named('analytics-audit-header');
  assert.match(audit, /^\s+secretIdentifier: analyticsAuditHeaderSecretUri$/m,
    'and the audit credential the same way — a DIFFERENT secret, so the write path rotates alone');
  assert.doesNotMatch(audit, /^\s+value: /m,
    'a literal value is a second copy of a secret another repository also holds');

  // APIM resolves the secret while it creates the named value: without the grant already in place
  // that create fails, and the ordering is invisible to `az bicep build`.
  assert.match(shared, /dependsOn: \[\n\s+secretsUser\n\s+\]/,
    'the named value must be created after the read grant, or its first deploy fails to resolve');
  assert.match(audit, /dependsOn: \[\n\s+secretsUser\n\s+\]/,
    'the named value must be created after the read grant, or its first deploy fails to resolve');

  // The identifiers come from the vault module, and the values are nobody's parameter any more.
  assert.match(MAIN, /^\s+analyticsSharedHeaderSecretUri: keyVault!\.outputs\.analyticsSharedHeaderSecretUri$/m,
    'main.bicep must pass the vault URI into the apim module — without it the named value is empty ' +
    'and analyticsDeployed reads false, which publishes no analytics API at all');
  assert.match(MAIN, /^\s+analyticsAuditHeaderSecretUri: keyVault!\.outputs\.analyticsAuditHeaderSecretUri$/m,
    'and the audit one, same consequence');
  assert.doesNotMatch(MAIN, /^param analyticsSharedHeaderValue /m,
    'the value must not be a parameter again');
  assert.doesNotMatch(MAIN, /^param analyticsAuditHeaderValue /m,
    'the value must not be a parameter again');

  // Required, not optional: both environments that deploy this vault publish the analytics API, and
  // deploy-infra.sh only checks the names these lists carry. A gateway stamping an unresolved named
  // value deploys clean and 401s everything it forwards.
  assert.match(KEY_VAULT, /^\s+'analytics-shared-header'$/m,
    'analytics-shared-header must be a required vault name');
  assert.match(KEY_VAULT, /^\s+'analytics-audit-header'$/m,
    'analytics-audit-header must be a required vault name');
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

// The two search alerts are the answer to the 2026-09-08 outage: 65 minutes of `dataset=Document`
// 502s that only a log line recorded. Both halves are strings in different languages in different
// files, and every way of getting it wrong is silent — a rule that matches nothing keeps evaluating
// and keeps finding nothing, which reads exactly like a healthy service. Text-structural, with the
// same honest limits as the drift guard above.
// Every `logger.<level>` message under the request path, rendered the way the runtime renders it:
// interpolations stand in as `x`, and a message split across concatenated literals is rejoined.
const LOG_SOURCES = ['controllers', 'search'].flatMap((dir) => {
  const base = path.join(ROOT, 'src', dir);
  return fs.readdirSync(base, { recursive: true })
    .filter(f => f.endsWith('.js'))
    .map(f => ({ file: path.join('src', dir, f), source: fs.readFileSync(path.join(base, f), 'utf8') }));
});

const LITERAL = /`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'/;

const logLines = (level) => LOG_SOURCES.flatMap(({ file, source }) =>
  [...source.matchAll(new RegExp(
    `logger\\.${level}\\(\\s*((?:${LITERAL.source})(?:\\s*\\+\\s*(?:${LITERAL.source}))*)`, 'g'))]
    .map(m => [...m[1].matchAll(new RegExp(LITERAL.source, 'g'))].map(s => s[0].slice(1, -1)).join(''))
    .map(line => ({ file, line: line.replace(/\$\{[^}]+\}/g, 'x').replace(/\\(.)/g, '$1') })));

const rule = (name) => OBSERVABILITY
  .split(/^resource /m)
  .find(b => b.includes(`name: '${name}-\${environmentName}'`));

const ruleQuery = (name) => {
  const block = rule(name);
  assert.ok(block, `no ${name} rule in observability.bicep`);
  const query = /query: '([^']+)'/.exec(block);
  assert.ok(query, `${name} declares no query`);
  return { block, query: query[1] };
};

test('the search failure alert matches every search failure and nothing else', () => {
  const { block, query } = ruleQuery('demi-search-failures');

  assert.match(query, /^AppTraces \|/,
    'AppTraces, not traces — the classic table does not exist in this workspace, and a rule ' +
    'against it returns no rows rather than an error');

  // The query is a disjunction of parenthesised conjunctions — one alternative per log tag it
  // covers. Each clause is tested the way its operator means it, so swapping startswith for
  // contains cannot pass by accident.
  const groups = [...query.matchAll(/\(([^()]*)\)/g)].map(m => m[1]);
  const alternatives = (groups.length ? groups : [query]).map(
    g => [...g.matchAll(/(startswith|contains) "([^"]+)"/g)].map(m => ({ op: m[1], needle: m[2] })));
  assert.ok(alternatives.every(clauses => clauses.length >= 2),
    'an alternative filtering on one literal is broader than it looks');
  assert.ok(!/\bhas "\[/.test(query),
    '`has` tokenises on brackets — a bracketed tag has to be matched with startswith or contains');
  const carries = (line, clauses) => clauses.every(
    ({ op, needle }) => (op === 'startswith' ? line.startsWith(needle) : line.includes(needle)));
  const matches = (line) => alternatives.some(clauses => carries(line, clauses));

  // EVERY error line the request path can write, not just search.js's: the tag namespace is shared,
  // and a rule that pages on somebody else's tag is a rule people learn to ignore. Lines are
  // concatenated across several string literals, so the pieces are joined before a clause is read
  // against them.
  const logged = logLines('error');
  assert.ok(logged.some(({ line }) => line.startsWith('[search]')),
    'search.js logs no [search] error lines at all any more');

  // Every alternative, not just one: a disjunct whose literals match nothing anybody logs would
  // pass unseen behind the others — and a rule that matches nothing keeps evaluating and keeps
  // finding nothing, which reads exactly like a healthy service.
  for (const clauses of alternatives) {
    assert.ok(logged.some(({ line }) => carries(line, clauses)),
      `nothing under src/controllers or src/search logs a line carrying every literal of ${JSON.stringify(clauses)}`);
  }

  // The tags that mean a REQUEST WAS SERVED BADLY. `[search-schema]` is deliberately not one:
  // GET /health/search-schema is anonymous and unthrottled, it serves no page, and its probe
  // failures are a caller's business rather than an outage. An unclosed `[search` prefix swallows
  // it, which is what this enumerates the whole tree to catch.
  const SERVING_TAGS = new Set(['[search]', '[search/summary]', '[ai-search]', '[demi-api search]']);
  for (const { file, line } of logged) {
    if (!matches(line)) continue;
    const tag = (/^\[[^\]]+\]/.exec(line) || [''])[0];
    assert.ok(SERVING_TAGS.has(tag),
      `the rule pages on ${JSON.stringify(tag)} from ${file}: ${JSON.stringify(line)}`);
  }

  // GET /search/summary answers 200 on failure — see the catch in search.js — so no 5xx ratio can
  // ever see a summary outage and this rule is the only thing that covers it.
  const summary = logged.filter(({ line }) => line.startsWith('[search/summary]'));
  assert.ok(summary.length, 'search.js logs no [search/summary] error line any more');
  for (const { line } of summary) {
    assert.ok(matches(line), `the rule misses ${JSON.stringify(line)}, which nothing else can see`);
  }

  // The other half: the warn lines carrying the same tags are not failures, and a rule that counted
  // them would page on a query nobody could express.
  for (const { line } of logLines('warn')) {
    assert.ok(!matches(line), `the rule also matches the warn line ${JSON.stringify(line)}`);
  }

  assert.match(block, /severity: 1$/m, 'a search that cannot answer is an error, not a warning');
  assert.match(block, /actionGroups: \[ alertGroup\.id \]/,
    'the rule must mail the shared action group, not one of its own');
});

test('the search 5xx rule matches the paths the search routes are mounted at', () => {
  const { block, query } = ruleQuery('demi-search-5xx-ratio');

  assert.match(query, /^AppRequests \|/, 'the ratio is over requests, not traces');

  // api/index.js registers ONE catch-all function, so every request in this workspace shares an
  // operation name and only the URL separates search from everything else.
  const paths = [...query.matchAll(/endswith "([^"]+)"/g)].map(m => m[1]);
  assert.ok(paths.length, 'the rule filters on no path at all — it would measure the whole API');

  const declared = [...ROUTES.matchAll(/path: '(\/search[^']*)'/g)].map(m => m[1]);
  assert.ok(declared.length, 'routes.js declares no /search route any more');
  for (const p of paths) {
    assert.ok(declared.includes(p), `the rule watches ${p}, which routes.js does not serve`);
  }
  for (const d of declared) {
    assert.ok(paths.includes(d), `routes.js serves ${d}, which the rule does not watch`);
  }

  // ResultCode is a STRING column: without toint, ">= 500" is a lexicographic comparison and "50"
  // sorts above "500".
  assert.match(query, /toint\(ResultCode\) >= 500/,
    'ResultCode has to be converted before it can be compared as a number');
  assert.match(query, /total >= 5/,
    'without a floor, one failed request in an idle five minutes reads as 100% broken');
  assert.match(query, /todouble\(failed\) \/ total > 0\.2/,
    'integer division would floor every ratio under 1 to 0 and the rule could never fire');

  assert.match(block, /severity: 1$/m, 'same severity as the trace rule — it is the same outage');
  assert.match(block, /actionGroups: \[ alertGroup\.id \]/,
    'the rule must mail the shared action group, not one of its own');
});

// A content match against a key the API stopped emitting fails every probe run, which is an outage
// that is not one. `searchResultsTotal` is attached only where a total was measured, so it is a
// stronger check than a status code and a more fragile one than a corpus-independent string looks.
test('the availability probe matches on a key the search response still carries', () => {
  const match = /ContentMatch: '([^']+)'/.exec(AVAILABILITY);
  assert.ok(match, 'the web test validates no content — a 200 that is not an answer stays green');
  assert.ok(SEARCH_CONTROLLER.includes(match[1]),
    `the probe requires ${JSON.stringify(match[1])}, which search.js no longer emits`);
  assert.match(AVAILABILITY, /PassIfTextFound: true/,
    'the match has to mean "present", not "absent"');
});

// The search definition apply needs four settings and a queue, and `az bicep build` compiles an app
// that is missing any of them. Each one fails quietly in its own way: no queue name and the route
// answers 503; no DS_* and put-search-datasources.js writes the literal string "undefined" into a
// data source, which the service accepts and the indexer then fails on. Text-structural, with the
// same limits as the guards above.
test('the API app is given the search definition queue and the data source env', () => {
  const setting = (name, value) =>
    new RegExp(`name: '${name}'\\n\\s+value: ${value}$`, 'm');

  assert.match(API_MODULE, setting('SEARCH_DEFINITIONS_QUEUE', 'searchDefinitionsQueue'),
    'the queue name the worker triggers on must come from the parameter, not a literal');
  assert.match(API_MODULE, setting('DS_SUB', 'subscription\\(\\).subscriptionId'));
  assert.match(API_MODULE, setting('DS_RG', 'resourceGroup\\(\\).name'),
    'DS_RG names the Cosmos account\'s group, which is the group this template deploys into');
  assert.match(API_MODULE, setting('DS_IDENTITY_ID', 'dataSourceIdentityId'),
    'the data source identity is the SEARCH service\'s, so it cannot be hardcoded to ours');

  // The identity differs by environment: ours when we deployed the service, the existing service's
  // own when we did not. Hardcoding either half breaks the other environment's indexers.
  assert.match(MAIN,
    /^\s+dataSourceIdentityId: deploySearch \? identityId : existingSearchIndexerIdentityId$/m,
    'main.bicep must choose the data source identity by whether it owns the search service');
});

test('the search definition queue is declared where the worker will look for it', () => {
  assert.match(API_MODULE,
    /queueServices\/queues@[\d-]+' = if \(!empty\(searchDefinitionsQueue\)\) \{\n\s+parent: queueService\n\s+name: searchDefinitionsQueue$/m,
    'the queue must be named from the param, or the worker triggers on a queue nothing declared');
  assert.match(API_MODULE, /name: '\$\{searchDefinitionsQueue\}-poison'$/m,
    'a job that burns its attempts left the search service part-way through a definition change');

  // The queue service is shared, and its condition is the OR of every queue's. Left out, the queue
  // above has no parent in an environment that runs only this feature.
  const queueService = /^resource queueService '[^']+' = if \((.+)\) \{$/m.exec(API_MODULE);
  assert.ok(queueService, 'api-function-flex.bicep must declare the queue service');
  assert.ok(queueService[1].includes('!empty(searchDefinitionsQueue)'),
    'the queue service must deploy for an environment that sets only the search definition queue');

  assert.match(TEST_PARAMS, /^param searchDefinitionsQueue = 'search-definitions'$/m,
    'test is where an apply is rehearsed; without the queue it falls back to the devbox');
  assert.match(PROD_PARAMS, /^param searchDefinitionsQueue = ''$/m,
    'prod stays explicitly off until test has rehearsed the route');
});

// One identity, two spellings: search-existing.bicep grants Cosmos Data Reader to the PRINCIPAL,
// and a data source names the same identity by RESOURCE ID. They are set in different files, so
// nothing but this stops prod granting one identity and PUTting another.
test('the prod data source identity is the identity demi-search-prod runs indexers as', () => {
  const owner = /^param identityId = '([^']+)'$/m.exec(AI_SEARCH_PROD_PARAMS);
  const used = /^param existingSearchIndexerIdentityId = '([^']+)'$/m.exec(PROD_PARAMS);
  assert.ok(owner, 'ai-search.prod.bicepparam must name the identity the service runs as');
  assert.ok(used, 'main.prod.bicepparam must name the identity data sources authenticate as');
  assert.strictEqual(used[1], owner[1],
    'a data source PUT naming an identity the service does not hold leaves the indexer at 403');
});

// ── The foundation / application split ────────────────────────────────────────────────────────
//
// `deployFoundation = false` deploys the application layer alone and reads the rest of the estate
// by name. `az bicep build` compiles every wrong version of that: a foundation module left ungated
// is re-PUT on every application deploy, an app module still reading a module output takes a value
// that only exists in the other mode, and a lookup pointed at the wrong name or apiVersion reads a
// different resource — or a different property shape — and writes the difference into a
// whole-collection appSettings PUT.
//
// Text-structural, with the same honest limits as the guards above.

const FOUNDATION_MODULES = [
  ['identity', './modules/identity.bicep'],
  ['keyVault', './modules/key-vault.bicep'],
  ['cosmos', './modules/cosmos-nosql.bicep'],
  ['observability', './modules/observability.bicep'],
  ['auditLogs', './modules/audit-logs.bicep'],
  ['foundry', './modules/foundry.bicep'],
  ['search', './modules/ai-search.bicep'],
  ['existingSearchRole', './modules/search-existing.bicep'],
  ['apim', './modules/apim.bicep'],
  ['staticSite', './modules/static-site.bicep'],
  ['documentStorage', './modules/document-storage.bicep'],
  ['costBudget', './modules/cost-budget.bicep']
];

const APP_MODULES = [
  ['apiFunctionFlex', './modules/api-function-flex.bicep'],
  ['secretSync', './modules/secret-sync.bicep'],
  ['availability', './modules/availability.bicep'],
  ['devbox', './modules/devbox.bicep']
];

const moduleBlock = (modulePath) => MAIN.split(/^module /m).find(b => b.includes(`'${modulePath}'`));

test('every foundation module is gated on deployFoundation', () => {
  assert.match(MAIN, /^param deployFoundation bool = false$/m,
    'the switch must default to the cheap mode — a param file that forgets it deploys the ' +
    'application layer only, not a full re-PUT');

  for (const [symbol, modulePath] of FOUNDATION_MODULES) {
    const block = moduleBlock(modulePath);
    assert.ok(block, `main.bicep must call ${modulePath}`);
    assert.match(block.split('\n')[0],
      new RegExp(`^${symbol} '${modulePath.replace(/[./]/g, '\\$&')}' = if \\(deployFoundation`),
      `${modulePath} is not gated on deployFoundation — an application-only deploy would re-PUT ` +
      'it, which is the 293 s of ARM time this split exists to skip');
  }
});

test('no application module reads the deployFoundation switch', () => {
  for (const [, modulePath] of APP_MODULES) {
    const block = moduleBlock(modulePath);
    assert.ok(block, `main.bicep must call ${modulePath}`);
    assert.doesNotMatch(block, /deployFoundation/,
      `${modulePath} must deploy in BOTH modes and read the same values in both — a mention of ` +
      'the switch here is either a gate that skips the app layer or a value that differs by mode');
  }
});

test('the application modules read the lookup vars, not foundation module outputs', () => {
  for (const [, modulePath] of APP_MODULES) {
    const block = moduleBlock(modulePath);
    for (const [symbol] of FOUNDATION_MODULES) {
      assert.doesNotMatch(block, new RegExp(`\\b${symbol}!?\\.outputs\\b`),
        `${modulePath} reads ${symbol}.outputs — that value exists only when deployFoundation is ` +
        'true, so an application-only deploy writes a different one');
    }
  }

  // The inline role assignment is application-side too, and it is not a module block.
  const costReader = /resource costReaderAssignment [\s\S]*?\n\}/.exec(MAIN);
  assert.ok(costReader, 'main.bicep must declare the Cost Management Reader assignment');
  assert.match(costReader[0], /^\s+principalId: identityPrincipalId$/m,
    'the assignment must name the identity through the lookup var like every other app-side use');
});

// A lookup at the wrong name reads another resource; at the wrong apiVersion it can read another
// PROPERTY SHAPE for the same one, and both land in app settings without failing a deploy. The
// owning module is the source of truth for both, so this compares the two files rather than
// restating what the lookup should be.
const LOOKUPS = [
  ['identityExisting', 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31', 'identity.bicep'],
  ['vaultExisting', 'Microsoft.KeyVault/vaults@2023-07-01', 'key-vault.bicep'],
  ['cosmosExisting', 'Microsoft.DocumentDB/databaseAccounts@2024-11-15', 'cosmos-nosql.bicep'],
  ['logsWorkspaceExisting', 'Microsoft.OperationalInsights/workspaces@2023-09-01', 'observability.bicep'],
  ['auditWorkspaceExisting', 'Microsoft.OperationalInsights/workspaces@2023-09-01', 'audit-logs.bicep'],
  ['appInsightsExisting', 'Microsoft.Insights/components@2020-02-02', 'observability.bicep'],
  ['actionGroupExisting', 'Microsoft.Insights/actionGroups@2023-01-01', 'observability.bicep'],
  ['auditDcrExisting', 'Microsoft.Insights/dataCollectionRules@2023-03-11', 'audit-logs.bicep'],
  ['foundryExisting', 'Microsoft.CognitiveServices/accounts@2025-06-01', 'foundry.bicep']
];

test('every foundation lookup names what the owning module declares', () => {
  // The name a module gives the resource of that type, with a `var` indirection resolved.
  const declaredName = (text, type) => {
    const at = text.indexOf(`'${type}' = {`);
    if (at === -1) return null;
    const name = /\n\s+name: (.+)/.exec(text.slice(at));
    if (!name) return null;
    const literal = /^'(.*)'$/.exec(name[1].trim());
    if (literal) return literal[1];
    const fromVar = new RegExp(`^var ${name[1].trim()} = '(.*)'$`, 'm').exec(text);
    return fromVar ? fromVar[1] : null;
  };

  for (const [symbol, type, moduleFile] of LOOKUPS) {
    const moduleText = fs.readFileSync(path.join(ROOT, 'azure', 'modules', moduleFile), 'utf8');

    const lookup = new RegExp(`^resource ${symbol} '([^']+)' existing = \\{\\n\\s+name: '([^']*)'`, 'm').exec(MAIN);
    assert.ok(lookup, `main.bicep must declare the ${symbol} lookup`);
    assert.strictEqual(lookup[1], type,
      `${symbol} must read ${moduleFile}'s type and apiVersion — another version can hand back ` +
      'another property shape for the same resource');

    const owned = declaredName(moduleText, type);
    assert.ok(owned, `${moduleFile} must declare a ${type} resource for the lookup to mirror`);
    assert.strictEqual(lookup[2], owned,
      `${symbol} reads '${lookup[2]}' while ${moduleFile} deploys '${owned}' — an ` +
      'application-only deploy would then write the wrong resource into the app settings');
  }
});

// The three optional secrets are the one place the two modes could legitimately disagree: the vault
// module decides them from `optionalSecretNames`, and main.bicep has to make the same decision the
// same way. A live reference where prod wants '' goes straight into the whole-collection PUT.
test('the optional secret URIs are decided identically in both modes', () => {
  const OPTIONAL = [
    ['notifyApiKeySecretUri', 'notify-api-key'],
    ['edgeSecretUri', 'edge-secret'],
    ['accessGateSecretUri', 'access-gate-password']
  ];

  for (const [varName, secretName] of OPTIONAL) {
    const decision = `contains(optionalSecretNames, '${secretName}') ? '\${secretUriBase}${secretName}' : ''`;

    assert.ok(KEY_VAULT.includes(`output ${varName} string = ${decision}`),
      `key-vault.bicep must decide ${varName} from optionalSecretNames`);

    const block = new RegExp(`^var ${varName} = deployFoundation\\n(?:  .*\\n)+`, 'm').exec(MAIN);
    assert.ok(block, `main.bicep must carry a ${varName} var with a branch per mode`);
    assert.ok(block[0].includes(`keyVault!.outputs.${varName}`),
      `the foundation branch of ${varName} must come from the vault module`);
    assert.ok(block[0].includes(decision),
      `the application branch of ${varName} must apply the SAME contains() test as ` +
      'key-vault.bicep, or an application-only deploy writes a reference where a full deploy ' +
      'writes an empty string');
  }
});

test('both param files pin deployFoundation to the environment variable', () => {
  const pin = /^param deployFoundation = bool\(readEnvironmentVariable\('DEPLOY_FOUNDATION', 'false'\)\)$/m;
  assert.match(TEST_PARAMS, pin,
    'test must read the switch from the environment — `az` refuses a second --parameters beside a ' +
    '.bicepparam, so there is no other way to pass it');
  assert.match(PROD_PARAMS, pin,
    'and prod the same, defaulting to the application layer when the variable is unset');
});

test('deploy-infra.sh sets DEPLOY_FOUNDATION only under --foundation', () => {
  assert.match(DEPLOY, /^DEPLOY_FOUNDATION='false'$/m,
    'the default must be application-only, and must not be inherited from the caller');
  assert.match(DEPLOY, /^\s+--foundation\) DEPLOY_FOUNDATION='true' ;;$/m,
    'the flag is the only thing that turns the foundation on');
  assert.strictEqual((DEPLOY.match(/DEPLOY_FOUNDATION=/g) || []).length, 2,
    'two assignments exactly: the default and the flag — a third is a mode nothing on the command ' +
    'line explains');
  assert.match(DEPLOY, /^export DEPLOY_FOUNDATION$/m,
    'the bicepparam reads it with readEnvironmentVariable, so it has to be exported');

  // The deployment name is the only record of which layer a run applied, and the currency check
  // reads it back.
  assert.match(DEPLOY, /^\s+local prefix='infra-app-'$/m);
  assert.match(DEPLOY, /^\s+\[ "\$DEPLOY_FOUNDATION" = 'true' \] && prefix='infra-fnd-'$/m,
    'a foundation run must be named infra-fnd-<sha>-<hhmmss>, an application run infra-app-');

  assert.match(DEPLOY, /^\[ "\$DEPLOY_FOUNDATION" = 'true' \] \|\| require_foundation_current$/m,
    'the currency check runs in application mode only — a --foundation run is the fix for it');
  assert.match(DEPLOY, /starts_with\(name, 'infra-fnd-'\) && properties\.provisioningState=='Succeeded'/,
    'it has to read the last SUCCESSFUL foundation deployment, not the last attempt');

  // The list the check walks is the same set of modules the template gates.
  for (const [, modulePath] of FOUNDATION_MODULES) {
    assert.ok(DEPLOY.includes(`  azure/${modulePath.replace('./', '')}\n`),
      `${modulePath} is gated on deployFoundation but not in FOUNDATION_MODULES — an edit to it ` +
      'would pass the currency check and never be applied');
  }

  // The guards that predate the split run in both modes: none of them is about which layer is
  // being deployed.
  assert.match(DEPLOY, /^require_vault_secrets$/m);
  assert.match(DEPLOY, /^require_secrets$/m);
  assert.match(DEPLOY, /^assert_secrets_survived$/m);
  assert.match(DEPLOY, /\[ "\$\{CONFIRM_PROD:-\}" != 'yes' \]/,
    'the prod apply guard is not conditional on the layer either');
});

// The currency check is the only thing standing between an application-only apply and a foundation
// edit that is never PUT, so what it can SEE is the whole guard. `az` deploys the working tree;
// git history is a different set of facts, and main.bicep plus the param files are foundation
// inputs the module list does not name.
test('the currency check reads the working tree, not just the commit history', () => {
  assert.match(DEPLOY, /dirty=\$\(git -C "\$REPO_ROOT" status --porcelain -- "\$\{FOUNDATION_MODULES\[@\]\}"/,
    'an uncommitted edit to a foundation module is as unapplied as a committed one — git log ' +
    'cannot see it, so the check has to ask git status too');

  const dirtyBlock = /if \[ -n "\$dirty" \]; then[\s\S]*?\n {2}fi\n/.exec(DEPLOY);
  assert.ok(dirtyBlock, 'the uncommitted-module finding needs its own branch');
  assert.match(dirtyBlock[0], /^\s+refuse_or_warn$/m,
    'an uncommitted foundation edit takes the same route as a committed one: refuse on --live, ' +
    'warn on what-if');

  assert.strictEqual((DEPLOY.match(/^\s+refuse_or_warn$/gm) || []).length, 3,
    'exactly three findings refuse: no recorded foundation deploy, committed module changes, and ' +
    'uncommitted module changes — a fourth means the advisory input warning started refusing');
});

test('the currency check also watches main.bicep and both param files', () => {
  for (const input of ['azure/main.bicep', 'azure/main.test.bicepparam', 'azure/main.prod.bicepparam']) {
    assert.ok(DEPLOY.includes(`  ${input}\n`),
      `${input} decides what the foundation deploys — a budget bump or a re-pointed module call ` +
      'there is invisible to a check that only walks the module files');
  }

  assert.match(DEPLOY, /inputs_dirty=\$\(git -C "\$REPO_ROOT" status --porcelain -- "\$\{FOUNDATION_INPUTS\[@\]\}"/,
    'uncommitted input edits count the same as committed ones');
  assert.match(DEPLOY, /inputs_changed=\$\(git -C "\$REPO_ROOT" log --oneline "\$\{sha\}\.\.HEAD" -- "\$\{FOUNDATION_INPUTS\[@\]\}"/,
    'committed input edits are measured from the recorded foundation deployment, like the modules');

  // These three files change for application-only work as often as for foundation work, so they
  // can only ever advise. A refusal here would block every ordinary app deploy.
  const inputsBlock = /if \[ -n "\$inputs_dirty" \] \|\| \[ -n "\$inputs_changed" \]; then[\s\S]*?\n {2}fi\n/.exec(DEPLOY);
  assert.ok(inputsBlock, 'the input warning needs its own branch');
  assert.doesNotMatch(inputsBlock[0], /refuse_or_warn|exit 3/,
    'a change to main.bicep or a param file warns in BOTH modes — it never refuses');
  assert.match(inputsBlock[0], /run --foundation first/,
    'the warning has to say what to do about it');
});
