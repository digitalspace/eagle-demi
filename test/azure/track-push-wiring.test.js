'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, 'azure', ...parts), 'utf8');
const MAIN = read('main.bicep');
const API_MODULE = read('modules', 'api-function-flex.bicep');
const APIM_MODULE = read('modules', 'apim.bicep');
const OBSERVABILITY = read('modules', 'observability.bicep');
const COSMOS_MODULE = read('modules', 'cosmos-nosql.bicep');
const TEST_PARAMS = read('main.test.bicepparam');
const PROD_PARAMS = read('main.prod.bicepparam');

for (const [name, why] of [
  ['deployTrackDriftAlert', 'the observability module call — without it the Track drift alert is never created'],
  ['trackPrincipals', 'the API module call — without it DEMI_TRACK_PRINCIPALS is always the module default'],
  ['worksWrite', 'the API module call — without it WORKS_WRITE stays false whatever the param file says'],
  ['worksRead', 'the API module call — without it WORKS_READ stays false whatever the param file says'],
]) {
  test(`main.bicep declares and wires ${name} (${why.split(' —')[0]})`, () => {
    assert.match(MAIN, new RegExp(`^param ${name} `, 'm'),
      `${name} must be a main.bicep parameter, or no param file can set it`);
    assert.match(MAIN, new RegExp(`^\\s+${name}: ${name}$`, 'm'), `${name} is declared but not wired into ${why}`);
  });
}

const alertBlock = (name) => OBSERVABILITY.split(/^resource /m)
  .find(b => b.includes(`name: '${name}-\${environmentName}'`));

test('bicep declares the track machine subscription and wires DEMI_TRACK_PRINCIPALS to the app', () => {
  assert.match(/^var machineConsumers = \[\n([\s\S]*?)^\]$/m.exec(APIM_MODULE)?.[1] ?? '', /^\s+'track'$/m,
    'no track subscription, so Track has no key to send its pushes with');
  assert.match(MAIN, /^param trackPrincipals string = 'apim:track'$/m);
  assert.match(API_MODULE, /^param trackPrincipals string = 'apim:track'$/m);
  assert.match(API_MODULE, /name: 'DEMI_TRACK_PRINCIPALS'\n\s+value: trackPrincipals$/m,
    'an undeclared app setting dies on the next whole-collection PUT');
});

// The controller's log lines live on another branch, so the query is pinned whole: info lines share
// the prefix, one retryable line must stay quiet, and two for one id must fire.
test('demi-track-push deploys in every environment and pins its failure query', () => {
  const block = alertBlock('demi-track-push');
  assert.ok(block, 'no demi-track-push rule in observability.bicep');
  assert.match(block, /^trackPushAlert '[^']+' = \{$/m, 'ungated: it can only fire once Track pushes');
  assert.match(block, /evaluationFrequency: 'PT15M'\n\s+windowSize: 'PT30M'/,
    'a window as short as the frequency can split one push and its retry across two evaluations');
  assert.strictEqual(/query: '''\n([\s\S]+?)\n'''/.exec(block)?.[1], [
    'let lines = AppTraces',
    `| where (Message startswith "[track-push]" and SeverityLevel >= 3) or Message startswith "[demi-api] Track refused apim:" or Message startswith "[demi-api] APIM subscription 'track' has no registry row"`,
    '| extend retryable = Message startswith "[track-push] write failed id=" or Message startswith "[track-push] delete lost its etag race id=", projectId = extract("id=([^ ]+)", 1, Message);',
    'let hard = lines | where not(retryable) | summarize n = count() | where n > 0 | project problem = strcat(n, " non-retryable line(s)");',
    'let repeated = lines | where retryable | summarize n = count() by projectId | where n >= 2 | project problem = strcat("project ", projectId, ": ", n, " retryable line(s)");',
    'union hard, repeated',
  ].join('\n'));
  assert.match(block, /actionGroups: \[ alertGroup\.id \]/);
});

// The drift rule reads three counts out of the teams line; a renamed field reads null, and null
// compares false, so the rule would go silent rather than fail.
test('demi-track-drift reads the counts the teams sync logs and is off by default', () => {
  const block = alertBlock('demi-track-drift');
  assert.ok(block, 'no demi-track-drift rule in observability.bicep');
  assert.match(block, /= if \(deployTrackDriftAlert && !empty\(syncTeamsSchedule\)\) \{/,
    'with no teams timer the line never arrives and the rule can only be silent');
  assert.match(OBSERVABILITY, /^param deployTrackDriftAlert bool = false$/m);
  assert.match(MAIN, /^param deployTrackDriftAlert bool = false$/m,
    'on before Track pushes, the nightly is the only writer and the rule fires every night');

  const query = /query: '''\n([\s\S]+?)'''/.exec(block)?.[1];
  assert.ok(query, 'the rule declares no query');
  const { summaryLine } = require('../../src/scripts/sync-track-teams');
  const line = summaryLine({ mode: 'live', trackProjects: 7, created: 2, updated: 3, orphaned: 5, failures: 0 });
  const prefix = /startswith "([^"]+)"/.exec(query)?.[1];
  assert.ok(prefix && line.startsWith(prefix), `the rule filters on ${prefix}, not the start of ${line}`);
  const counts = Object.fromEntries([...query.matchAll(/(\w+) = toint\(extract\("([^"]+)", 1, Message\)\)/g)]
    .map(([, name, re]) => [name, new RegExp(re).exec(line)?.[1]]));
  assert.deepStrictEqual(counts, { trackProjects: '7', created: '2', updated: '3', orphaned: '5' });
  assert.match(query, /^\| where trackProjects > 0\n\| sort by TimeGenerated asc\n\| extend previous = prev\(orphaned\);$/m,
    'a failed night logs trackProjects=0 and orphaned=0; as a baseline it makes the next night a false rise');
  assert.match(block, /autoMitigate: false\n\s+muteActionsDuration: 'PT23H'/,
    'one mail a night: auto-resolve would send none for the next night, a short mute two for this one');
  assert.match(query, /\| top 1 by TimeGenerated \| where created > 0 or updated > 0 or orphaned > previous$/m,
    'only the latest night is judged, or one bad night alerts for two days');
  assert.strictEqual(/^let span = (\S+);$/m.exec(query)?.[1], '48h', 'two nights, the log alert maximum');
  assert.match(block, /windowSize: 'P2D'/);
});

const containerBlock = (name) => COSMOS_MODULE.split(/^resource /m)
  .find(b => /^\w+ 'Microsoft\.DocumentDB\/databaseAccounts\/sqlDatabases\/containers@/.test(b) && b.includes(`\n  name: '${name}'\n`));
const indexedPaths = (block) => [...block.matchAll(/path: '([^']+)'/g)].map(m => m[1]);
const worksContainer = containerBlock('works');

// With /* excluded, a filter on an unlisted path is not served by the index.
test('cosmos declares the works container, partitioned and indexed for per-project reads', () => {
  assert.ok(worksContainer, 'no works container in cosmos-nosql.bicep, so every works read and write 404s');
  assert.doesNotMatch(worksContainer.split('\n')[0], /= if \(/, 'every environment writes works once WORKS_WRITE is on');
  assert.match(worksContainer, /partitionKey: \{\n\s+paths: \[\n\s+'\/projectId'\n\s+\]/,
    'the partition key cannot change after creation; every read is "the works of this project"');
  assert.deepStrictEqual(indexedPaths(worksContainer), [
    '/projectId/?', '/workTypeId/?', '/deleted/?', '/kind/?', '/source/?', '/owner/?', '/sourceKey/?',
    '/actYear/?', '/workTypeCode/?', '/workState/?', '/startDate/?', '/decisionDate/?', '/summary/*',
  ]);
  assert.match(worksContainer, /excludedPaths: noIndex\n/, 'without /* excluded, Cosmos indexes every field it is sent');
  assert.match(COSMOS_MODULE, /^var noIndex = \[\n\s+\{\n\s+path: '\/\*'\n/m);
});

test('cosmos indexes the project external id pair for the cross-project uniqueness query', () => {
  const projects = containerBlock('projects');
  assert.ok(projects, 'no projects container in cosmos-nosql.bicep');
  for (const p of ['/externalIds/[]/system/?', '/externalIds/[]/value/?']) {
    assert.ok(indexedPaths(projects).includes(p), `${p} is not indexed, so the uniqueness check scans every project`);
  }
});

// src/config.js reads only the string 'true' as on.
test('the API app carries WORKS_WRITE and WORKS_READ, default off', () => {
  assert.match(MAIN, /^param worksWrite bool = false$/m);
  assert.match(MAIN, /^param worksRead bool = false$/m);
  assert.match(API_MODULE, /^param worksWrite bool = false$/m);
  assert.match(API_MODULE, /^param worksRead bool = false$/m);
  assert.match(API_MODULE, /name: 'WORKS_WRITE'\n\s+value: worksWrite \? 'true' : 'false'$/m,
    'an undeclared app setting dies on the next whole-collection PUT');
  assert.match(API_MODULE, /name: 'WORKS_READ'\n\s+value: worksRead \? 'true' : 'false'$/m,
    'an undeclared app setting dies on the next whole-collection PUT');
});

test('test writes works and reads phase and milestone fields from it', () => {
  assert.match(TEST_PARAMS, /^param worksWrite = true$/m, 'reads from an unfilled works container come back empty');
  assert.match(TEST_PARAMS, /^param worksRead = true$/m, 'test proves works reads before prod turns them on');
});

test('prod neither writes nor reads works', () => {
  assert.match(PROD_PARAMS, /^param worksWrite = false$/m);
  assert.match(PROD_PARAMS, /^param worksRead = false$/m);
});
