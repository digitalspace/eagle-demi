// PUT the committed datasources on SEARCH_ENDPOINT, pointed at the Cosmos account in COSMOS_ENDPOINT
// through the search service's user-assigned identity. Env: DS_SUB, DS_RG (of the Cosmos account),
// DS_DIR (datasource JSON dir, default the committed one — not packaged, upload it),
// DS_IDENTITY_ID (resource id of the identity the service runs indexers as). Needs Search Service
// Contributor for the duration — run under scripts/with-search-admin.sh.
const fs = require('fs'), path = require('path');
const DS_DIR = process.env.DS_DIR || path.join(__dirname, '..', '..', 'azure', 'search', 'datasources');
const { getToken } = require('../search/ai-search');
const ep = process.env.SEARCH_ENDPOINT, api = '2024-05-01-preview'; // identity block is preview-only
// A missing env var lands as the literal string "undefined" inside the PUT body, which the service
// accepts — the indexers then fail on their next run with "Ensure managed identity is enabled".
for (const k of ['SEARCH_ENDPOINT', 'COSMOS_ENDPOINT', 'COSMOS_NOSQL_DATABASE', 'DS_SUB', 'DS_RG', 'DS_IDENTITY_ID']) {
  if (!process.env[k]) { console.error(`${k} is not set — refusing to PUT a broken datasource`); process.exit(1); }
}
const acct = process.env.COSMOS_ENDPOINT.match(/https:\/\/([^.]+)\./)[1];
const rid = `/subscriptions/${process.env.DS_SUB}/resourceGroups/${process.env.DS_RG}/providers/Microsoft.DocumentDB/databaseAccounts/${acct}`;
(async () => {
  const h = { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' };
  for (const f of fs.readdirSync(DS_DIR)) {
    const d = JSON.parse(fs.readFileSync(path.join(DS_DIR, f), 'utf8'));
    delete d['@odata.etag'];
    d.credentials = { connectionString: `ResourceId=${rid};Database=${process.env.COSMOS_NOSQL_DATABASE};IdentityAuthType=AccessToken` };
    d.identity = { '@odata.type': '#Microsoft.Azure.Search.DataUserAssignedIdentity', userAssignedIdentity: process.env.DS_IDENTITY_ID };
    const r = await fetch(`${ep}/datasources/${d.name}?api-version=${api}`, { method: 'PUT', headers: h, body: JSON.stringify(d) });
    console.log(d.name, r.status, r.status >= 300 ? (await r.text()).slice(0, 300) : `-> ${acct}/${d.container.name}`);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
