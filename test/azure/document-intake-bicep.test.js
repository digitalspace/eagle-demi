'use strict';

// The intake account is the only one Defender for Storage scans, and every value below is a choice
// `az bicep build` cannot judge: a wrong cap, a dropped filter or a missing topic all compile. Same
// text-structural limits as main-bicep-wiring.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const MODULE = read('azure', 'modules', 'document-intake.bicep');
const MAIN = read('azure', 'main.bicep');
const API_MODULE = read('azure', 'modules', 'api-function-flex.bicep');
const TEST_PARAMS = read('azure', 'main.test.bicepparam');
const PROD_PARAMS = read('azure', 'main.prod.bicepparam');
const DEPLOY = read('scripts', 'deploy-infra.sh');

/** The body of a top-level resource declaration, up to its closing brace at column 0. */
function resourceBlock(source, symbol) {
  const start = source.indexOf(`resource ${symbol} `);
  assert.ok(start >= 0, `resource ${symbol} is declared`);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end);
}

const DEFENDER = resourceBlock(MODULE, 'defenderForStorage');

test('Defender settings match the intake plan table', async (t) => {
  await t.test('uses the stable 2025-06-01 API on the intake account', () => {
    assert.match(DEFENDER, /'Microsoft\.Security\/defenderForStorageSettings@2025-06-01'/);
    assert.match(DEFENDER, /name: 'current'/);
    assert.match(DEFENDER, /scope: intakeStorage\n/);
  });

  await t.test('is on and overrides the subscription plan', () => {
    assert.match(DEFENDER, /properties: \{\n {4}isEnabled: true\n/);
    assert.match(DEFENDER, /overrideSubscriptionLevelSettings: true/);
  });

  await t.test('scans on upload under the per-environment cap', () => {
    assert.match(DEFENDER, /onUpload: \{\n {8}isEnabled: true\n {8}capGBPerMonth: capGBPerMonth\n/);
  });

  await t.test('skips quarantine and deadletter, so copies are not scanned again', () => {
    assert.match(DEFENDER, /excludeBlobsWithPrefix: \[ quarantineContainer, deadletterContainer \]/);
    assert.match(MODULE, /quarantine: 'quarantine'\n {2}deadletter: 'deadletter'\n/);
  });

  await t.test('skips files over 2 GB', () => {
    assert.match(DEFENDER, /excludeBlobsLargerThan: 2147483648\n/);
  });

  await t.test('writes the result as a blob index tag, which the ABAC condition reads', () => {
    assert.match(DEFENDER, /blobScanResultsOptions: 'blobIndexTags'/);
    assert.match(MODULE, /var scanResultTag = 'Malware Scanning scan result'/);
    assert.match(MODULE, /tags:\$\{scanResultTag\}<\$key_case_sensitive\$>\] StringEquals \\'No threats found\\'/);
  });

  await t.test('publishes results to the intake topic', () => {
    assert.match(DEFENDER, /scanResultsEventGridTopicResourceId: scanResultsTopic\.id/);
    const topic = resourceBlock(MODULE, 'scanResultsTopic');
    assert.match(topic, /publicNetworkAccess: 'Enabled'/, 'Defender cannot publish to a private-only topic');
    assert.match(topic, /disableLocalAuth: true/);
  });

  await t.test('leaves sensitive data discovery off', () => {
    assert.match(DEFENDER, /sensitiveDataDiscovery: \{\n {6}isEnabled: false\n/);
  });
});

test('the cap is 5 GB on test and 25 GB on prod', () => {
  assert.match(TEST_PARAMS, /^param intakeCapGBPerMonth = 5$/m);
  assert.match(PROD_PARAMS, /^param intakeCapGBPerMonth = 25$/m);
  assert.match(MAIN, /^\s+capGBPerMonth: intakeCapGBPerMonth$/m);
});

test('intake is on in test and off in prod', () => {
  assert.match(TEST_PARAMS, /^param deployDocumentIntake = true$/m);
  assert.match(PROD_PARAMS, /^param deployDocumentIntake = false$/m);
  assert.match(MAIN,
    /^module documentIntake '\.\/modules\/document-intake\.bicep' = if \(deployFoundation && deployDocumentIntake\) \{$/m);
});

test('the scan-result subscription', async (t) => {
  const sub = resourceBlock(MODULE, 'scanResultSubscription');

  await t.test('stops retrying after 5 attempts or 60 minutes', () => {
    assert.match(sub, /retryPolicy: \{\n {6}maxDeliveryAttempts: 5\n {6}eventTimeToLiveInMinutes: 60\n/);
  });

  await t.test('delivers only scan results to intakeScanResult in the API app', () => {
    assert.match(sub, /includedEventTypes: \[\n {8}'Microsoft\.Security\.MalwareScanningResult'\n {6}\]/);
    assert.match(sub, /endpointType: 'AzureFunction'/);
    assert.match(MODULE, /var scanResultFunctionName = 'intakeScanResult'/);
    assert.match(MAIN, /^\s+apiAppName: 'demi-api-fc-\$\{environmentName\}'$/m);
  });

  // The function has to exist first, so the first infra pass must be able to skip the subscription.
  await t.test('is skipped when DEPLOY_INTAKE_SUBSCRIPTION is false', () => {
    assert.match(sub, /= if \(deploySubscription\) \{/);
    assert.match(MAIN, /^\s+deploySubscription: deployIntakeSubscription$/m);
    const wired = /^param deployIntakeSubscription = bool\(readEnvironmentVariable\('DEPLOY_INTAKE_SUBSCRIPTION', 'true'\)\)$/m;
    assert.match(TEST_PARAMS, wired);
    assert.match(PROD_PARAMS, wired);
  });
});

test('the intake account is keyless and uploads stay private to the account', () => {
  const account = resourceBlock(MODULE, 'intakeStorage');
  assert.match(account, /allowSharedKeyAccess: false/, 'policy Deny-Storage-Shared-Key refuses the create otherwise');
  assert.match(account, /allowBlobPublicAccess: false/);
  assert.match(account, /minimumTlsVersion: 'TLS1_2'/);
  assert.match(account, /supportsHttpsTrafficOnly: true/);
  assert.match(resourceBlock(MODULE, 'blobService'), /deleteRetentionPolicy: \{\n {6}enabled: true/);
});

test('the API identity cannot read an unscanned blob or mark one clean', () => {
  const grant = resourceBlock(MODULE, 'apiBlobContributor');
  assert.match(grant, /condition: apiCondition\n {4}conditionVersion: '2\.0'/);
  // Without this clause an upload SAS carrying tag rights could set the result tag itself.
  assert.match(MODULE, /\/tags&\$keys\$&\] ForAllOfAllValues:StringNotEquals \{\\'\$\{scanResultTag\}\\'\}/);
  assert.match(resourceBlock(MODULE, 'apiBlobDelegator'), /principalId: apiPrincipalId/);
});

test('the API app carries every intake setting and the second identity', async (t) => {
  for (const name of [
    'INTAKE_STORAGE_ACCOUNT', 'INTAKE_INCOMING_CONTAINER', 'INTAKE_QUARANTINE_CONTAINER',
    'INTAKE_QUARANTINE_CLIENT_ID', 'INTAKE_SWEEP_SCHEDULE', 'INTAKE_PENDING_TIMEOUT_HOURS'
  ]) {
    // appSettings is a whole-collection PUT: an undeclared setting is deleted by the next deploy.
    await t.test(`declares ${name}`, () => {
      assert.match(API_MODULE, new RegExp(`name: '${name}'\\n`));
    });
  }

  await t.test('sweeps every 30 minutes and times out after 6 hours', () => {
    assert.match(API_MODULE, /value: empty\(intakeStorageAccount\) \? '' : '0 \*\/30 \* \* \* \*'/);
    assert.match(API_MODULE, /value: empty\(intakeStorageAccount\) \? '' : '6'/);
  });

  await t.test('attaches demi-intake-<env> when intake is deployed', () => {
    assert.match(API_MODULE, /empty\(intakeIdentityId\) \? \{\} : \{ '\$\{intakeIdentityId\}': \{\} \}/);
    assert.match(MAIN, /^\s+intakeIdentityId: intakeIdentityId$/m);
  });
});

test('a foundation-only edit to the module is caught by deploy-infra.sh', () => {
  const list = /FOUNDATION_MODULES=\(\n([\s\S]*?)\n\)/.exec(DEPLOY);
  assert.ok(list, 'FOUNDATION_MODULES is declared');
  assert.match(list[1], /^\s+azure\/modules\/document-intake\.bicep$/m);
});
