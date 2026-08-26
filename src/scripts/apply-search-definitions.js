'use strict';

/**
 * PUT the committed index and indexer definitions onto a search service.
 *
 * These are DATA-PLANE objects. Bicep creates the search *service* and cannot create anything
 * inside it, which is why `azure/search/` exists and why, until this script, the definitions were
 * hand-POSTed from inside the VNet with nothing in git able to replay them.
 *
 * MUST RUN INSIDE THE APP CONTAINER, over the App Service SSH tunnel — not Kudu's /api/command,
 * whose SCM container has no managed-identity endpoint. This script's only auth path is
 * `getToken()` -> DefaultAzureCredential -> managed identity, so Kudu cannot work at all. See
 * README.md for the recipe, including the `IDENTITY_ENDPOINT`/`IDENTITY_HEADER` pair.
 *
 * `demi-search-*` is `publicNetworkAccess: Disabled` with local auth off, so a workstation cannot
 * reach the data plane either: it answers 403 "the source is not allowed by applicable rules",
 * not a connection error.
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
 * Then revoke it with `az role assignment delete --ids <the id that returned>`.
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
// Required as a MODULE, not destructured: `t.mock.method(aiSearch, 'getToken', ...)` is how
// the tests avoid reaching for a real managed-identity token, and a destructured binding
// cannot be mocked. CI has no credential, so a test that mints one really does hang for 15s
// and then fail — which is exactly how this was found.
const aiSearch = require('../search/ai-search');

const ROOT = path.join(__dirname, '..', '..');
const INDEX_DIR = path.join(ROOT, 'azure', 'search', 'indexes');
const INDEXER_DIR = path.join(ROOT, 'azure', 'search', 'indexers');
// Read, never written. The committed data source is the only way to notice that the LIVE one is
// projecting a different set of Cosmos columns than the indexes now expect.
const DATASOURCE_DIR = path.join(ROOT, 'azure', 'search', 'datasources');
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
    else if (a === '--only') {
      // An EMPTY value is not "no filter". `--only "$IDX"` with IDX unset passes the value() guard
      // (not undefined, no `--` prefix), and select() would then short-circuit its must-match check
      // and apply all six objects — the opposite of what the operator asked for.
      args.only = value(a);
      if (!args.only.trim()) throw new Error('--only was given an empty value');
    }
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

/** The committed copy of one data source, or null when the repo does not carry it. */
function readCommittedDataSource(name) {
  const file = path.join(DATASOURCE_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Parse a response body that is only sometimes JSON — an error page must not crash the report. */
function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
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
      `inside the app container over the App Service SSH tunnel — Kudu's SCM container has no ` +
      `managed-identity endpoint, so it cannot authenticate here either.`
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
      Authorization: `Bearer ${await aiSearch.getToken()}`,
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });
  const text = await res.text();
  return { status: res.status, text };
}

/**
 * Pick the definitions a run touches.
 *
 * ONE VOCABULARY, and it must match something. The two directories name their objects differently —
 * an index is `chunks`, its indexer is `chunks-indexer` — so `--only` accepts either and resolves to
 * the same pair. Without that, `--only chunks-indexer` (the obvious thing to type, since the file is
 * `chunks-indexer.json`) selected nothing, both loops walked empty, and the run printed
 * `applied 0 definition(s).` followed by the revoke reminder — indistinguishable from success.
 */
function select(only) {
  const indexes = load(INDEX_DIR);
  const indexers = load(INDEXER_DIR);
  if (!only) return { indexes, indexers };

  const target = indexers.find(d => d.body.name === only)?.body.targetIndexName || only;
  const picked = {
    indexes: indexes.filter(d => d.body.name === target),
    indexers: indexers.filter(d => d.body.targetIndexName === target)
  };
  if (!picked.indexes.length && !picked.indexers.length) {
    throw new Error(
      `--only ${only} matches no definition. Known: ` +
      `${indexes.map(d => d.body.name).join(', ')} (or their -indexer names).`
    );
  }
  return picked;
}

/**
 * Why the committed index would NOT be a safe write over the live one — empty when it would.
 *
 * ADDING a field to a live index is the one schema change Azure AI Search supports in place, and
 * it is the change `azure/search/README.md` "Adding a field" documents as routine: existing
 * documents keep their values and the new column reads null until the indexer has run again.
 * Everything else — dropping a field, retyping one, flipping `filterable`, changing an analyzer or
 * the similarity — is a rebuild, and doing it to the index the app is querying is an outage.
 *
 * So the serving guard asks whether the diff is additive rather than whether the index is live.
 * Refusing every live index made the documented workflow impossible to run through this script:
 * once the definitions took the plain names at the 2026-08-22 cutover, `projects` IS what the app
 * serves, so step 1 of "Adding a field" could never execute. The refusal was written when the
 * committed names were deliberately AHEAD of the live ones and overlap meant an accident.
 *
 * Deliberately strict: any field present live must appear in the committed copy with a byte-equal
 * definition, and every index-level property outside `fields` must match too. A rename reads as a
 * drop plus an add and is refused, which is the original accident this guard was built for.
 */
function notAdditive(liveBody, committedBody) {
  const reasons = [];
  const liveFields = new Map((liveBody.fields || []).map(f => [f.name, f]));
  const committedFields = new Map((committedBody.fields || []).map(f => [f.name, f]));

  for (const [name, liveField] of liveFields) {
    const committedField = committedFields.get(name);
    if (!committedField) {
      reasons.push(`field "${name}" exists live and is missing from the committed copy`);
      continue;
    }
    if (JSON.stringify(liveField) !== JSON.stringify(committedField)) {
      reasons.push(`field "${name}" is redefined, not merely kept`);
    }
  }

  // The rest of the index body: analyzers, tokenizers, scoring profiles, similarity, suggesters.
  // A changed `similarity` reorders every result the app already serves — additive in field count,
  // not additive in behaviour.
  //
  // `@odata.*` IS DROPPED, and not as tidying. A GET carries `@odata.context` and `@odata.etag`,
  // which no committed file has and no PUT sends; leaving them in made every live index compare
  // unequal, so the guard refused a widening whose only difference was two server-assigned keys —
  // the exact false refusal it had just been rewritten to stop.
  const strip = (b) => JSON.stringify(Object.fromEntries(
    Object.entries(b)
      .filter(([k]) => k !== 'fields' && !k.startsWith('@odata.'))
      .sort(([a], [c]) => a.localeCompare(c))
  ));
  if (strip(liveBody) !== strip(committedBody)) {
    reasons.push('an index-level property outside `fields` changed (analyzers, similarity, scoring)');
  }

  return reasons;
}

/**
 * Apply the definitions. Exported so the guard below and the dry-run split are reachable from a
 * test — the property that the committed names do not collide with the live ones can be asserted
 * from the files alone, but that says nothing about whether this function still CHECKS it.
 */
async function run({ endpoint, live, only, liveNames }) {
  const args = { live, only };

  // THE NAMES THE APP IS CURRENTLY POINTED AT. PUTting one of these would rewrite a schema that is
  // serving traffic — an index PUT is not additive, and a breaking change to a live index is an
  // outage rather than an error. The definitions in git are renamed AHEAD of the cutover precisely
  // so these sets do not overlap; if they ever do, that is the accident this guard exists for.
  const serving = new Set(liveNames.filter(Boolean));

  const { indexes, indexers } = select(args.only);

  console.log(`endpoint : ${endpoint}`);
  console.log(`live now : ${[...serving].join(', ') || '(none configured)'}`);
  console.log(`mode     : ${args.live ? 'LIVE — will PUT' : 'dry run'}`);
  console.log('');

  // GATES WRITING, NOT REPORTING. This used to run before the dry-run split below, so a dry run
  // refused too — and after the index rename made the committed names the live ones, that meant the
  // one command an operator reaches for FIRST during an incident always exited 1 without printing
  // anything useful. A dry run touches nothing; it should be safe in every state.
  //
  // FAIL BEFORE THE FIRST WRITE, not partway through: a `--only`-less run applies three indexes and
  // stopping at the second would leave one written and two not.
  const additive = new Map();
  for (const { file, body } of indexes) {
    if (!serving.has(body.name) || !args.live) continue;
    const live = await call(endpoint, 'GET', `/indexes/${body.name}?api-version=${API_VERSION}`);
    assertNotForbidden(live.status, live.text, `index ${body.name}`);
    // Absent = greenfield (a fresh service): nothing serves from it yet, so creating it is additive.
    if (live.status === 404) continue;
    if (live.status !== 200) {
      throw new Error(
        `index "${body.name}" is what the app is serving from, and reading it back returned ` +
        `HTTP ${live.status}. Refusing to PUT over a schema this cannot see: ${live.text.slice(0, 200)}`
      );
    }
    const reasons = notAdditive(safeJson(live.text) || {}, body);
    if (reasons.length > 0) {
      throw new Error(
        `refusing to PUT index "${body.name}" (${path.basename(file)}): it is what the app is ` +
        `serving from right now and the change is NOT additive — ${reasons.join('; ')}. Adding ` +
        `fields to a live index is supported in place; anything else is a rebuild. Point ` +
        `SEARCH_INDEX* elsewhere first, or rename the definition.`
      );
    }
    additive.set(body.name, (body.fields || []).length - ((safeJson(live.text) || {}).fields || []).length);
  }

  // INDEXES BEFORE INDEXERS, and it is not cosmetic: an indexer references both its data source
  // and its target index and fails to create if either is missing.
  let applied = 0;
  let driftedDataSources = 0;
  for (const { file, body } of indexes) {
    const existing = await call(endpoint, 'GET', `/indexes/${body.name}?api-version=${API_VERSION}`);
    assertNotForbidden(existing.status, existing.text, `index ${body.name}`);
    const state = existing.status === 200 ? 'exists' : existing.status === 404 ? 'absent' : `HTTP ${existing.status}`;
    // A dry run has not read the live schema, so it cannot say whether the diff is additive — it
    // says the index is live and leaves the verdict to the --live run, which does read it.
    const added = additive.get(body.name);
    const servingNote = !serving.has(body.name) || state === 'absent' ? ''
      : added === undefined ? '  ** SERVING TRAFFIC — --live refuses a non-additive change **'
        : `  ** SERVING TRAFFIC — additive, +${added} field(s) **`;
    console.log(`index    ${body.name.padEnd(24)} ${state}   <- ${path.basename(file)}${servingNote}`);
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
    // THE SILENT FAILURE THIS GUARD EXISTS FOR. The committed data source carries the SELECT that
    // decides which Cosmos columns the indexer even sees. This script never writes one (above), so
    // adding a field to an index and to the data source file, then running --live, reports success
    // while the indexer keeps projecting the old columns — every new field stays null, with no
    // error anywhere. Compare and SAY SO; the repair is a hand-run PUT with the real
    // connectionString, which only a human holds.
    const committedDs = readCommittedDataSource(body.dataSourceName);
    const liveQuery = (safeJson(ds.text)?.container || {}).query || null;
    if (committedDs && liveQuery !== null && committedDs.container.query !== liveQuery) {
      console.log(
        `  !! data source ${body.dataSourceName} DIFFERS from the committed copy. The indexer will\n` +
        `     keep projecting the LIVE query, so any field added to the index but not to the live\n` +
        `     data source stays null and nothing reports an error.\n` +
        `       live:      ${liveQuery}\n` +
        `       committed: ${committedDs.container.query}\n` +
        `     Fix with a hand-run PUT /datasources/${body.dataSourceName} carrying the real\n` +
        `     connectionString (azure/search/README.md), BEFORE relying on the new fields.`
      );
      driftedDataSources++;
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
  // Repeated at the END because the per-indexer warning above scrolls past on a full run, and this
  // is the one failure that produces a green report and null fields.
  if (driftedDataSources > 0) {
    console.log(
      `WARNING: ${driftedDataSources} data source(s) differ from the committed copy — see above. ` +
      `Indexes applied here can still be filled with the OLD column set.`);
  }
  if (!args.live) {
    console.log('dry run — nothing was written. Re-run with --live to apply.');
    return;
  }
  console.log(`applied ${applied} definition(s).`);
  console.log('The indexers run on their own PT5M schedule; nothing else has to be triggered.');
  console.log('REVOKE the Search Service Contributor grant now — this script is done with it.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = aiSearch.config();
  if (!cfg.configured) throw new Error('SEARCH_ENDPOINT is not set — nothing to apply against');
  return run({
    endpoint: cfg.endpoint.replace(/\/$/, ''),
    live: args.live,
    only: args.only,
    liveNames: [cfg.index, cfg.projectsIndex, cfg.documentsIndex]
  });
}

if (require.main === module) {
  main().catch(err => {
    console.error(`[apply-search-definitions] ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs, load, select, run, assertNotForbidden, readCommittedDataSource, safeJson, notAdditive,
  INDEX_DIR, INDEXER_DIR, DATASOURCE_DIR
};
