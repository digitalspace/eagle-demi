'use strict';

/**
 * PUT the committed index and indexer definitions onto a search service.
 *
 * These are DATA-PLANE objects. Bicep creates the search *service* and cannot create anything
 * inside it, which is why `azure/search/` exists and why, until this script, the definitions were
 * hand-POSTed from inside the VNet with nothing in git able to replay them.
 *
 * WHERE THIS RUNS. `demi-search-*` is `publicNetworkAccess: Disabled` with local auth off, so a
 * workstation cannot reach the data plane at all. Run it from Kudu on `demi-api-<env>`, which is
 * already inside the VNet and already runs as the identity below.
 *
 * WHAT ROLE IT NEEDS, and the part that is easy to get wrong. The app's identity holds **Search
 * Index Data Contributor**, which covers DOCUMENTS and not DEFINITIONS. Creating an index or an
 * indexer needs **Search Service Contributor** (`7ca78c08-252a-4471-8644-bb5ff32d4ba0`). Grant it
 * at the SERVICE scope, not the resource group, and revoke it when the run is done — a
 * public-facing API's runtime identity should not keep index-management rights.
 *
 *   az role assignment create --role 7ca78c08-252a-4471-8644-bb5ff32d4ba0 \
 *     --assignee-object-id <identity objectId> --assignee-principal-type ServicePrincipal \
 *     --scope /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Search/searchServices/<svc>
 *
 * That grant IS revocable here, which was doubted for a while: the `c4b0a8` ABAC condition
 * restricts `roleAssignments/write` and `/delete` to the same six role GUIDs (Owner, Contributor,
 * User Access Administrator, RBAC Administrator, two custom), and Search Service Contributor is on
 * neither list. Proven 2026-08-22 by a grant/revoke cycle at the service scope.
 *
 * DRY RUN BY DEFAULT. `--live` is the mutating flag, matching export-chunks-to-eagle.js.
 *
 *   node src/scripts/apply-search-definitions.js            # report what would change
 *   node src/scripts/apply-search-definitions.js --live     # PUT them
 */

const fs = require('fs');
const path = require('path');
const { getToken, config } = require('../search/ai-search');

const ROOT = path.join(__dirname, '..', '..');
const INDEX_DIR = path.join(ROOT, 'azure', 'search', 'indexes');
const INDEXER_DIR = path.join(ROOT, 'azure', 'search', 'indexers');
const API_VERSION = '2024-07-01';

function parseArgs(argv) {
  const args = { live: false, only: '' };
  let i = 0;
  const value = (flag) => {
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) {
      throw new Error(`${flag} needs a value, got ${v === undefined ? 'nothing' : `\`${v}\``}`);
    }
    return v;
  };
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--only') args.only = value(a);
    else throw new Error(`unknown flag ${a}`);
  }
  return args;
}

/** Definitions on disk, in the order they must be applied. */
function load(dir) {
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => ({ file: path.join(dir, f), body: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
}

/**
 * TWO COMPLETELY DIFFERENT FAULTS ARRIVE AS 403, and telling someone the wrong one costs an hour.
 * The status alone cannot distinguish them — the body can, so read it rather than guessing:
 *
 *   - NETWORK. `publicNetworkAccess: Disabled` rejects the request before authorization is even
 *     considered, with "the source is not allowed by applicable rules". Measured from a workstation
 *     2026-08-22: this is what you get, NOT a connection error, so a timeout is not the tell.
 *     No grant fixes it; run from inside the VNet.
 *   - ROLE. The caller is inside the VNet but holds Search Index Data Contributor (documents) and
 *     not Search Service Contributor (definitions).
 */
function assertNotForbidden(status, text, what) {
  if (status !== 403) return;
  if (/publicNetworkAccess|not allowed by applicable rules/i.test(text || '')) {
    throw new Error(
      `HTTP 403 reading ${what}: the SERVICE'S NETWORK RULES rejected this, not its RBAC. ` +
      `demi-search-* is publicNetworkAccess: Disabled, so no role grant changes this — run from ` +
      `inside the VNet (Kudu on demi-api-<env>).`
    );
  }
  throw new Error(
    `HTTP 403 reading ${what}: reachable, but this token cannot read DEFINITIONS. Grant Search ` +
    `Service Contributor (7ca78c08-252a-4471-8644-bb5ff32d4ba0) at the SERVICE scope, run this, ` +
    `then revoke it. Service response: ${(text || '').slice(0, 200)}`
  );
}

async function call(endpoint, method, resourcePath, body) {
  const res = await fetch(`${endpoint}${resourcePath}`, {
    method,
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = config();
  if (!cfg.configured) throw new Error('SEARCH_ENDPOINT is not set — nothing to apply against');
  const endpoint = cfg.endpoint.replace(/\/$/, '');

  // THE NAMES THE APP IS CURRENTLY POINTED AT. PUTting one of these would rewrite a schema that is
  // serving traffic — an index PUT is not additive, and a breaking change to a live index is an
  // outage rather than an error. The definitions in git are renamed AHEAD of the cutover precisely
  // so these sets do not overlap; if they ever do, that is the accident this guard exists for.
  const live = new Set([cfg.index, cfg.projectsIndex, cfg.documentsIndex].filter(Boolean));

  const indexes = load(INDEX_DIR).filter(d => !args.only || d.body.name === args.only);
  const indexers = load(INDEXER_DIR).filter(d => !args.only || d.body.targetIndexName === args.only);

  console.log(`endpoint : ${endpoint}`);
  console.log(`live now : ${[...live].join(', ') || '(none configured)'}`);
  console.log(`mode     : ${args.live ? 'LIVE — will PUT' : 'dry run'}`);
  console.log('');

  for (const { file, body } of indexes) {
    if (live.has(body.name)) {
      throw new Error(
        `refusing to PUT index "${body.name}" (${path.basename(file)}): it is what the app is ` +
        `serving from right now. Point SEARCH_INDEX* elsewhere first, or rename the definition.`
      );
    }
  }

  // INDEXES BEFORE INDEXERS, and it is not cosmetic: an indexer references both its data source
  // and its target index and fails to create if either is missing.
  let applied = 0;
  for (const { file, body } of indexes) {
    const existing = await call(endpoint, 'GET', `/indexes/${body.name}?api-version=${API_VERSION}`);
    assertNotForbidden(existing.status, existing.text, `index ${body.name}`);
    const state = existing.status === 200 ? 'exists' : existing.status === 404 ? 'absent' : `HTTP ${existing.status}`;
    console.log(`index    ${body.name.padEnd(24)} ${state}   <- ${path.basename(file)}`);
    if (!args.live) continue;
    const put = await call(endpoint, 'PUT', `/indexes/${body.name}?api-version=${API_VERSION}`, body);
    if (put.status >= 300) throw new Error(`PUT /indexes/${body.name} -> ${put.status} ${put.text.slice(0, 400)}`);
    applied++;
  }

  for (const { body } of indexers) {
    // DATA SOURCES ARE NEVER TOUCHED. They carry no index name, both the old and the new indexers
    // share them, and `connectionString` comes back redacted on export — re-POSTing one would mean
    // supplying a credential for no behaviour change. Checked, not assumed: a missing data source
    // makes the indexer PUT fail with a message that does not name it clearly.
    const ds = await call(endpoint, 'GET', `/datasources/${body.dataSourceName}?api-version=${API_VERSION}`);
    assertNotForbidden(ds.status, ds.text, `data source ${body.dataSourceName}`);
    if (ds.status === 404) {
      throw new Error(
        `indexer ${body.name} needs data source "${body.dataSourceName}", which does not exist. ` +
        `Create it first — this script deliberately does not, because connectionString comes back ` +
        `redacted on export and the committed copy cannot restore a working one.`
      );
    }
    if (ds.status !== 200) {
      throw new Error(`data source ${body.dataSourceName} returned HTTP ${ds.status}: ${ds.text.slice(0, 200)}`);
    }
    const existing = await call(endpoint, 'GET', `/indexers/${body.name}?api-version=${API_VERSION}`);
    assertNotForbidden(existing.status, existing.text, `indexer ${body.name}`);
    const state = existing.status === 200 ? 'exists' : existing.status === 404 ? 'absent' : `HTTP ${existing.status}`;
    console.log(`indexer  ${body.name.padEnd(24)} ${state}   -> ${body.targetIndexName}  (ds ${body.dataSourceName} ok)`);
    if (!args.live) continue;
    const put = await call(endpoint, 'PUT', `/indexers/${body.name}?api-version=${API_VERSION}`, body);
    if (put.status >= 300) throw new Error(`PUT /indexers/${body.name} -> ${put.status} ${put.text.slice(0, 400)}`);
    applied++;
  }

  console.log('');
  if (!args.live) {
    console.log('dry run — nothing was written. Re-run with --live to apply.');
    return;
  }
  console.log(`applied ${applied} definition(s).`);
  console.log('The indexers run on their own PT5M schedule; nothing else has to be triggered.');
  console.log('REVOKE the Search Service Contributor grant now — this script is done with it.');
}

if (require.main === module) {
  main().catch(err => {
    console.error(`[apply-search-definitions] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, load, assertNotForbidden, INDEX_DIR, INDEXER_DIR };
