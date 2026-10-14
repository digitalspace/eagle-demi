'use strict';

// The intake account is the only one Defender for Storage scans, and every value below is a choice
// `az bicep build` cannot judge: a wrong cap, a dropped filter or a lost tag-write deny all compile. Same
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
const COSMOS_MODULE = read('azure', 'modules', 'cosmos-nosql.bicep');
const BLOBS = 'Microsoft.Storage/storageAccounts/blobServices/containers/blobs';

/** The body of a top-level resource declaration, up to its closing brace at column 0. */
function resourceBlock(source, symbol) {
  const start = source.indexOf(`resource ${symbol} `);
  assert.ok(start >= 0, `resource ${symbol} is declared`);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end);
}

const DEFENDER = resourceBlock(MODULE, 'defenderForStorage');

/** The string value of `var <name> = '...'` in the module. */
function moduleString(name) {
  const m = new RegExp(`^var ${name} = '([^']*)'$`, 'm').exec(MODULE);
  assert.ok(m, `var ${name} is a string literal`);
  return m[1];
}

/** A container var resolved through the exported intakeContainers object. */
function containerName(name) {
  const key = new RegExp(`^var ${name} = intakeContainers\\.(\\w+)$`, 'm').exec(MODULE);
  assert.ok(key, `var ${name} reads intakeContainers`);
  const value = new RegExp(`^ {2}${key[1]}: '([^']*)'$`, 'm').exec(MODULE);
  assert.ok(value, `intakeContainers.${key[1]} is declared`);
  return value[1];
}

/** The lines of `var <name> = join([...], '\n')`, unquoted; a bare var name on a line expands to that var's lines. */
function conditionLines(name) {
  const body = new RegExp(`^var ${name} = join\\(\\[\\n([\\s\\S]*?)\\n\\], '\\\\n'\\)$`, 'm').exec(MODULE);
  assert.ok(body, `${name} is a join() of string lines`);
  return body[1].split('\n').flatMap((line) => {
    const trimmed = line.trim();
    return /^\w+$/.test(trimmed)
      ? conditionLines(trimmed)
      : [trimmed.replace(/^'|'$/g, '').replace(/\\'/g, "'")];
  });
}

/**
 * An ABAC condition var as Azure receives it, with top-level `AND` lines kept on their own line.
 * Each `${var}` is resolved from the module, so a container swap shows up.
 */
function conditionText(name) {
  const vars = {
    blobsAction: moduleString('blobsAction'),
    containerNameAttr: moduleString('containerNameAttr'),
    scanResultTag: moduleString('scanResultTag'),
    incomingContainer: containerName('incomingContainer'),
    quarantineContainer: containerName('quarantineContainer'),
    deadletterContainer: containerName('deadletterContainer')
  };
  return conditionLines(name).join('\n').replace(/\$\{(\w+)\}/g, (_, v) => {
    assert.ok(v in vars, `condition var ${v} is resolved by the test`);
    return vars[v];
  });
}

const collapse = (text) => text.replace(/\s+/g, ' ').trim();

/** The API identity's condition split into its top-level AND clauses, whitespace collapsed. */
function apiConditionClauses() {
  return conditionText('apiCondition').split('\nAND\n').map(collapse);
}

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

  await t.test('writes the result as a blob index tag, which the sweep and the ABAC condition read', () => {
    assert.match(DEFENDER, /blobScanResultsOptions: 'blobIndexTags'/);
    assert.match(MODULE, /var scanResultTag = 'Malware scanning scan result'/);
    assert.match(MODULE, /tags:\$\{scanResultTag\}<\$key_case_sensitive\$>\] StringEquals \\'No threats found\\'/);
  });

  await t.test('leaves sensitive data discovery off', () => {
    assert.match(DEFENDER, /sensitiveDataDiscovery: \{\n {6}isEnabled: false\n/);
  });
});

// Policy Deny-PublicPaaSEndpoints refuses a public custom topic, and Defender cannot deliver to a private one.
test('the module declares no Event Grid resource; the sweep polls the tag instead', () => {
  // Covers Microsoft.EventGrid/* and Defender's topic property.
  assert.doesNotMatch(MODULE, /EventGrid/);
});

test('the cap is 5 GB on test and 25 GB on prod', () => {
  assert.match(TEST_PARAMS, /^param intakeCapGBPerMonth = 5$/m);
  assert.match(PROD_PARAMS, /^param intakeCapGBPerMonth = 25$/m);
  assert.match(MAIN, /^\s+capGBPerMonth: intakeCapGBPerMonth$/m);
});

test('intake is parked on both test and prod', () => {
  assert.match(TEST_PARAMS, /^param deployDocumentIntake = false$/m);
  assert.match(PROD_PARAMS, /^param deployDocumentIntake = false$/m);
  assert.match(MAIN,
    /^module documentIntake '\.\/modules\/document-intake\.bicep' = if \(deployFoundation && deployDocumentIntake\) \{$/m);
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

test('the API identity ABAC condition', async (t) => {
  const CONTAINER = '@Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name]';
  const clauses = apiConditionClauses();

  await t.test('has exactly three AND clauses', () => {
    assert.strictEqual(clauses.length, 3);
  });

  // Listing is excluded so the API can still enumerate incoming; the blob read itself stays gated.
  await t.test('clause 1 gates blob reads but not Blob.List', () => {
    assert.ok(clauses[0].startsWith(
      `( ( !(ActionMatches{'${BLOBS}/read'} AND NOT SubOperationMatches{'Blob.List'}) ) OR (`), clauses[0]);
  });

  await t.test('clause 1 allows a read only in incoming and only once tagged clean', () => {
    assert.ok(clauses[0].endsWith(
      `OR ( ${CONTAINER} StringEquals 'incoming' AND ` +
      `@Resource[${BLOBS}/tags:Malware scanning scan result<$key_case_sensitive$>] StringEquals 'No threats found' ) )`),
      clauses[0]);
  });

  await t.test('clause 2 gates writes, creates and deletes', () => {
    assert.ok(clauses[1].startsWith(
      `( ( !(ActionMatches{'${BLOBS}/write'}) AND !(ActionMatches{'${BLOBS}/add/action'}) ` +
      `AND !(ActionMatches{'${BLOBS}/delete'}) ) OR (`), clauses[1]);
  });

  await t.test('clause 2 allows them only in incoming', () => {
    assert.ok(clauses[1].endsWith(`OR ( ${CONTAINER} StringEquals 'incoming' ) )`), clauses[1]);
  });

  await t.test('clause 3 denies tag writes unless none of them sets the scan-result tag', () => {
    assert.strictEqual(clauses[2],
      `( ${collapse(conditionText('tagHeaderDeny'))} OR ` +
      `( @Request[${BLOBS}/tags&$keys$&] ForAllOfAllValues:StringNotEquals {'Malware scanning scan result'} ) )`);
  });

  // The quarantine copy runs as demi-intake-<env>, which is the only identity that may touch these.
  await t.test('names neither quarantine nor deadletter', () => {
    assert.doesNotMatch(clauses.join(' '), /quarantine|deadletter/);
  });
});

// demi-intake-<env> reads the tag the API identity's read gate trusts. If it could write one, a wrong
// sweep decision could mark an unscanned file clean and the API would release it.
test('demi-intake-<env> reads tags but can never write one', async (t) => {
  const HEADER_DENY =
    `( !(ActionMatches{'${BLOBS}/write'} AND SubOperationMatches{'Blob.Write.WithTagHeaders'}) ` +
    `AND !(ActionMatches{'${BLOBS}/add/action'} AND SubOperationMatches{'Blob.Write.WithTagHeaders'}) )`;

  await t.test('the Contributor deny covers both tag-header writes, with no OR branch', () => {
    const deny = collapse(conditionText('tagHeaderDeny'));
    assert.strictEqual(deny, HEADER_DENY);
    assert.doesNotMatch(deny, /\bOR\b/);
  });

  await t.test('the Owner deny adds Set Blob Tags, with no OR branch', () => {
    const deny = collapse(conditionText('tagWriteDeny'));
    assert.strictEqual(deny, `( ${HEADER_DENY} AND !(ActionMatches{'${BLOBS}/tags/write'}) )`);
    assert.doesNotMatch(deny, /\bOR\b/);
  });

  const grants = { intakeBlobContributor: 'tagHeaderDeny', intakeTagReader: 'tagWriteDeny' };
  for (const [symbol, deny] of Object.entries(grants)) {
    await t.test(`${symbol} carries ${deny}`, () => {
      const grant = resourceBlock(MODULE, symbol);
      assert.match(grant, /principalId: intakeIdentity\.properties\.principalId\n/);
      assert.match(grant, new RegExp(`condition: ${deny}\\n {4}conditionVersion: '2\\.0'`));
    });
  }

  // Data Contributor has no blobs/tags/read, so Owner is the grant that lets the sweep read the tag.
  await t.test('Owner is granted on incoming only', () => {
    const grant = resourceBlock(MODULE, 'intakeTagReader');
    assert.match(grant, /scope: containers\[0\]\n/);
    assert.match(MODULE, /^resource containers '[^']+' = \[for name in \[incomingContainer, /m);
    assert.strictEqual(moduleString('blobDataOwnerRoleId'), 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b');
    assert.match(grant, /roleDefinitions', blobDataOwnerRoleId\)/);
  });
});

/** Every role assignment in the module with the given role id var, as { symbol, condition text }. */
function conditionsForRole(roleVar) {
  const symbols = [...MODULE.matchAll(/^resource (\w+) 'Microsoft\.Authorization\/roleAssignments@/gm)].map((m) => m[1]);
  return symbols
    .map((symbol) => ({ symbol, block: resourceBlock(MODULE, symbol) }))
    .filter(({ block }) => block.includes(`roleDefinitions', ${roleVar})`))
    .map(({ symbol, block }) => {
      const cond = /condition: (\w+)\n/.exec(block);
      assert.ok(cond, `${symbol} carries a condition`);
      return { symbol, text: conditionText(cond[1]) };
    });
}

// Azure rejects a condition that names an action its role does not grant (InvalidRoleAssignmentCondition).
test('each tag-write deny names only actions its role grants', async (t) => {
  await t.test('no Data Contributor condition names blobs/tags/write', () => {
    assert.strictEqual(moduleString('blobDataContributorRoleId'), 'ba92f5b4-2d11-453d-a403-e96b0029c9fe');
    const grants = conditionsForRole('blobDataContributorRoleId');
    assert.deepStrictEqual(grants.map((g) => g.symbol).sort(), ['apiBlobContributor', 'intakeBlobContributor']);
    for (const { symbol, text } of grants) {
      assert.doesNotMatch(text, /blobs\/tags\/write/, symbol);
    }
  });

  await t.test('the Data Owner condition denies blobs/tags/write', () => {
    const grants = conditionsForRole('blobDataOwnerRoleId');
    assert.deepStrictEqual(grants.map((g) => g.symbol), ['intakeTagReader']);
    assert.ok(grants[0].text.includes(`!(ActionMatches{'${BLOBS}/tags/write'})`), grants[0].text);
  });
});

// listPending filters on scanStatus and orders by createdAt; the month-to-date sum filters on scannedAt.
// The container excludes /* and Cosmos rejects an ORDER BY on a path with no range index.
test('the documents container indexes the fields the intake sweep queries', async (t) => {
  const docs = resourceBlock(COSMOS_MODULE, 'documentsContainer');
  const included = docs.slice(docs.indexOf('includedPaths:'), docs.indexOf('excludedPaths:'));
  assert.ok(included.length > 0, 'documents declares includedPaths before excludedPaths');
  for (const field of ['scanStatus', 'createdAt', 'scannedAt']) {
    await t.test(`includes /${field}/?`, () => {
      assert.match(included, new RegExp(`path: '/${field}/\\?'\n`));
    });
  }
});

test('the API app carries every intake setting and the second identity', async (t) => {
  for (const name of [
    'INTAKE_STORAGE_ACCOUNT', 'INTAKE_INCOMING_CONTAINER', 'INTAKE_QUARANTINE_CONTAINER',
    'INTAKE_QUARANTINE_CLIENT_ID', 'INTAKE_CAP_GB_PER_MONTH', 'INTAKE_SWEEP_SCHEDULE',
    'INTAKE_PENDING_TIMEOUT_HOURS'
  ]) {
    // appSettings is a whole-collection PUT: an undeclared setting is deleted by the next deploy.
    await t.test(`declares ${name}`, () => {
      assert.match(API_MODULE, new RegExp(`name: '${name}'\\n`));
    });
  }

  await t.test('sweeps every 5 minutes and times out after 6 hours', () => {
    assert.match(API_MODULE, /name: 'INTAKE_SWEEP_SCHEDULE'\n\s+value: empty\(intakeStorageAccount\) \? '' : '0 \*\/5 \* \* \* \*'\n/);
    assert.match(API_MODULE, /value: empty\(intakeStorageAccount\) \? '' : '6'/);
  });

  // The sweep prints capBytes from this, and the cap alerts compare against that value.
  await t.test('passes the same cap Defender enforces', () => {
    assert.match(API_MODULE, /value: empty\(intakeStorageAccount\) \? '' : string\(intakeCapGBPerMonth\)/);
    assert.match(MAIN, /^\s+intakeCapGBPerMonth: intakeCapGBPerMonth$/m);
  });

  // The quarantine copy picks its credential by this client id; a resource id or '' leaves it on the API identity.
  await t.test('sets INTAKE_QUARANTINE_CLIENT_ID to the intake identity client id', () => {
    assert.match(API_MODULE, /name: 'INTAKE_QUARANTINE_CLIENT_ID'\n\s+value: intakeIdentityClientId\n/);
    assert.match(MAIN, /^\s+intakeIdentityClientId: intakeIdentityClientId$/m);
    assert.match(MODULE, /^output intakeIdentityClientId string = intakeIdentity\.properties\.clientId$/m);
  });

  // Application-only runs skip the module and read the same identity back as an existing resource.
  await t.test('reads the client id, not the resource id, on runs that skip the module', () => {
    assert.match(MAIN, /^var intakeIdentityClientId = !deployDocumentIntake \? '' : \(deployFoundation \? documentIntake!\.outputs\.intakeIdentityClientId : intakeIdentityExisting\.properties\.clientId\)$/m);
    assert.match(resourceBlock(MAIN, 'intakeIdentityExisting'), /name: 'demi-intake-\$\{environmentName\}'/);
    assert.match(resourceBlock(MODULE, 'intakeIdentity'), /name: 'demi-intake-\$\{environmentName\}'/);
  });

  // Empty INTAKE_STORAGE_ACCOUNT leaves intakeScanSweep unregistered and uploads answer 503.
  await t.test('passes the intake account name only when intake is deployed', () => {
    assert.match(MAIN, /^\s+intakeStorageAccount: deployDocumentIntake \? intakeStorageAccountName : ''$/m);
    assert.match(MAIN, /^\s+storageAccountName: intakeStorageAccountName$/m);
  });

  await t.test('attaches demi-intake-<env> when intake is deployed', () => {
    assert.match(API_MODULE, /empty\(intakeIdentityId\) \? \{\} : \{ '\$\{intakeIdentityId\}': \{\} \}/);
    assert.match(MAIN, /^\s+intakeIdentityId: intakeIdentityId$/m);
  });
});

test('the scan cap alerts', async (t) => {
  const alert = resourceBlock(MODULE, 'capAlert');

  await t.test('warn at 75% and error at 100% of the cap', () => {
    assert.match(MODULE, /var capAlerts = \[\n {2}\{ percent: 75, severity: 2 \}\n {2}\{ percent: 100, severity: 1 \}\n\]/);
    assert.match(alert, /severity: a\.severity/);
  });

  // The sweep logs the month-to-date total; a log alert cannot sum further back than two days.
  await t.test('read the newest month-to-date line and compare it with the cap it carries', () => {
    assert.match(alert, /Message contains "\[intake\] month-to-date" \| top 1 by TimeGenerated desc/);
    assert.match(alert, /extract\("scannedBytes=\(\[0-9\]\+\)", 1, Message\)/);
    assert.match(alert, /extract\("capBytes=\(\[0-9\]\+\)", 1, Message\)/);
    assert.match(alert, /where capBytes > 0 and scannedBytes \* 100 >= capBytes \* \$\{a\.percent\}'/);
    assert.match(alert, /windowSize: 'P1D'/);
  });

  await t.test('notify demi-alerts-<env> from the API log workspace', () => {
    assert.match(alert, /actionGroups: \[ actionGroupId \]/);
    assert.match(alert, /scopes: \[ logsWorkspaceId \]/);
    assert.match(MAIN, /^\s+logsWorkspaceId: observability!\.outputs\.workspaceId\n\s+actionGroupId: actionGroupId$/m);
  });
});

test('a dead sweep alerts after 2 hours without a month-to-date line', () => {
  const alert = resourceBlock(MODULE, 'sweepSilentAlert');
  assert.match(alert, /^resource sweepSilentAlert '[^']+' = \{$/m, 'not gated: no rollout pass skips it');
  assert.match(alert, /query: 'AppTraces \| where Message contains "\[intake\] month-to-date scannedBytes="'/);
  assert.match(alert, /windowSize: 'PT2H'/);
  assert.match(alert, /timeAggregation: 'Count'\n\s+operator: 'LessThan'\n\s+threshold: 1\n/);
  assert.match(alert, /actionGroups: \[ actionGroupId \]/);
});

test('a foundation-only edit to the module is caught by deploy-infra.sh', () => {
  const list = /FOUNDATION_MODULES=\(\n([\s\S]*?)\n\)/.exec(DEPLOY);
  assert.ok(list, 'FOUNDATION_MODULES is declared');
  assert.match(list[1], /^\s+azure\/modules\/document-intake\.bicep$/m);
});
