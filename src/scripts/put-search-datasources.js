// PUT the committed datasources on SEARCH_ENDPOINT, pointed at the Cosmos account in COSMOS_ENDPOINT
// through the search service's user-assigned identity. Env: DS_SUB, DS_RG (of the Cosmos account),
// DS_DIR (datasource JSON dir, default the committed one), DS_IDENTITY_ID (resource id of the
// identity the service runs indexers as). Needs Search Service Contributor for the duration — run
// under scripts/with-search-admin.sh, or through POST /admin/search-definitions/apply, which calls
// putDataSources() in process (src/jobs/search-definitions.js).
'use strict';

const fs = require('fs'), path = require('path');
const aiSearch = require('../search/ai-search');

const DS_DIR = () => process.env.DS_DIR || path.join(__dirname, '..', '..', 'azure', 'search', 'datasources');
const API = '2024-05-01-preview'; // identity block is preview-only

// A missing env var lands as the literal string "undefined" inside the PUT body, which the service
// accepts — the indexers then fail on their next run with "Ensure managed identity is enabled".
const REQUIRED = ['SEARCH_ENDPOINT', 'COSMOS_ENDPOINT', 'COSMOS_NOSQL_DATABASE', 'DS_SUB', 'DS_RG', 'DS_IDENTITY_ID'];

function missingEnv() {
  return REQUIRED.filter(k => !process.env[k]);
}

/**
 * PUT the committed data sources, or the `names` subset of them.
 *
 * Exported so the queue job can run it in process; `log` is the report's only exit, defaulting to
 * console.log for the CLI below.
 */
async function putDataSources({ names = [], log = console.log } = {}) {
  const missing = missingEnv();
  if (missing.length > 0) {
    throw new Error(`${missing.join(', ')} not set — refusing to PUT a broken datasource`);
  }
  const endpoint = process.env.SEARCH_ENDPOINT.replace(/\/$/, '');
  const account = process.env.COSMOS_ENDPOINT.match(/https:\/\/([^.]+)\./)[1];
  const rid = `/subscriptions/${process.env.DS_SUB}/resourceGroups/${process.env.DS_RG}` +
    `/providers/Microsoft.DocumentDB/databaseAccounts/${account}`;
  const headers = { Authorization: `Bearer ${await aiSearch.getToken()}`, 'Content-Type': 'application/json' };

  const files = fs.readdirSync(DS_DIR()).filter(f => f.endsWith('.json'));
  const onDisk = [];
  let written = 0;
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(DS_DIR(), f), 'utf8'));
    onDisk.push(d.name);
    // An empty list is every committed data source — the CLI's behaviour since it was written.
    if (names.length > 0 && !names.includes(d.name)) continue;
    delete d['@odata.etag'];
    d.credentials = { connectionString: `ResourceId=${rid};Database=${process.env.COSMOS_NOSQL_DATABASE};IdentityAuthType=AccessToken` };
    d.identity = { '@odata.type': '#Microsoft.Azure.Search.DataUserAssignedIdentity', userAssignedIdentity: process.env.DS_IDENTITY_ID };
    const r = await fetch(`${endpoint}/datasources/${d.name}?api-version=${API}`,
      { method: 'PUT', headers, body: JSON.stringify(d) });
    if (r.status >= 300) {
      throw new Error(`PUT /datasources/${d.name} -> ${r.status} ${(await r.text()).slice(0, 300)}`);
    }
    written++;
    log(`datasource ${d.name} ${r.status} -> ${account}/${d.container.name}`);
  }
  // A name that matches nothing is a typo, and the run that "succeeded" without writing it is the
  // failure this refuses to report as success.
  const unknown = names.filter(n => !onDisk.includes(n));
  if (unknown.length > 0) throw new Error(`no committed data source named ${unknown.join(', ')}`);
  return written;
}

if (require.main === module) {
  putDataSources({ names: process.argv.slice(2).filter(Boolean) })
    .catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { putDataSources };
