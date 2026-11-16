'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { cosmosContainer } = require('../helpers/cosmos-bicep');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', '..', 'azure', ...parts), 'utf8');
const MAIN = read('main.bicep');
const API_MODULE = read('modules', 'api-function-flex.bicep');
const PROD_PARAMS = read('main.prod.bicepparam');

/** The prod `param <name>` line, or undefined when prod leaves it at the template default. */
const prodParamLine = (name) => new RegExp(`^param ${name}\\b.*$`, 'm').exec(PROD_PARAMS)?.[0];

for (const name of ['mines', 'regulatoryRecords']) {
  test(`deployEnrichment gates the ${name} container`, () => {
    const block = cosmosContainer(name);
    assert.ok(block, `no ${name} container declared in cosmos-nosql.bicep`);
    assert.match(block.split('\n')[0], /= if \(deployEnrichment\) \{$/,
      `${name} must be gated on deployEnrichment — prod holds no NRPTI data`);
  });

  // canRead compares a scalar partition field; any other key lets a project-scoped caller read
  // rows of another project.
  test(`${name} is partitioned on /projectId`, () => {
    assert.match(cosmosContainer(name), /partitionKey: \{\n\s+paths: \[\n\s+'\/projectId'\n\s+\]/);
  });

  test(`${name} rows expire after 7 days`, () => {
    assert.match(cosmosContainer(name), /^\s+defaultTtl: 604800\b/m,
      'each sync re-upserts what NRPTI still links; without a TTL dropped rows stay forever');
  });
}

test('the API app carries NRPTI_SYNC_SCHEDULE from nrptiSyncSchedule', () => {
  assert.match(MAIN, /^param nrptiSyncSchedule string = ''$/m);
  assert.match(MAIN, /^\s+nrptiSyncSchedule: nrptiSyncSchedule$/m,
    'bicep only warns on an unwired param, and the app then registers no timer');
  assert.match(API_MODULE, /^param nrptiSyncSchedule string = ''$/m);
  assert.match(API_MODULE, /name: 'NRPTI_SYNC_SCHEDULE'\n\s+value: nrptiSyncSchedule$/m);
});

test('prod runs no NRPTI sync timer', () => {
  assert.ok([undefined, "param nrptiSyncSchedule = ''"].includes(prodParamLine('nrptiSyncSchedule')),
    'NRPTI sync is test only');
});

test('prod publishes no enrichment source', () => {
  assert.ok([undefined, "param enrichmentSources = ''"].includes(prodParamLine('enrichmentSources')),
    'prod serves Eagle and Track data only');
});

test('prod declares no enrichment containers', () => {
  assert.strictEqual(prodParamLine('deployEnrichment'), 'param deployEnrichment = false',
    'the template default is true, so prod must turn it off by name');
});
