'use strict';

// PUT committed index and indexer definitions. Dry run by default; --live PUTs; --check is a read-only
// drift check (exit 1 on drift). Run on the devbox via demi-run with Search Service Contributor granted.

const fs = require('fs');
const path = require('path');
// Not destructured: tests mock `aiSearch.getToken`, and CI has no credential to mint a real one.
const aiSearch = require('../search/ai-search');

const ROOT = path.join(__dirname, '..', '..');
const INDEX_DIR = path.join(ROOT, 'azure', 'search', 'indexes');
const INDEXER_DIR = path.join(ROOT, 'azure', 'search', 'indexers');
// Read, never written: compared with the live data source to spot a stale column projection.
const DATASOURCE_DIR = path.join(ROOT, 'azure', 'search', 'datasources');
const API_VERSION = '2024-07-01';

function parseArgs(argv) {
  const args = { live: false, check: false, only: '' };
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
    else if (a === '--check') args.check = true;
    else if (a === '--only') {
      // `--only "$IDX"` with IDX unset must not mean "no filter" and apply everything.
      args.only = value(a);
      if (!args.only.trim()) throw new Error('--only was given an empty value');
    }
    else throw new Error(`unknown flag ${a}`);
  }
  if (args.live && args.check) throw new Error('--live and --check are mutually exclusive');
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
 * A 403 is either the network rule (publicNetworkAccess Disabled, a 403 and not a timeout off the
 * VNet) or a missing Search Service Contributor role; only the body tells them apart.
 */
function assertNotForbidden(status, text, what) {
  if (status !== 403) return;
  if (/publicNetworkAccess|not allowed by applicable rules/i.test(text || '')) {
    throw new Error(
      `HTTP 403 reading ${what}: the SERVICE'S NETWORK RULES rejected this, not its RBAC. ` +
      `demi-search-* is publicNetworkAccess: Disabled, so no role grant changes this — run on the ` +
      `devbox (demi-devbox-<env>) via demi-run — Kudu's SCM container has no ` +
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
 * Pick the definitions a run touches. `--only` takes an index or indexer name and resolves to the
 * pair; a name matching nothing throws, so an empty run never reads as success.
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
 * Why the committed index is not a safe write over the live one; empty when it is. Adding fields is
 * the only in-place change AI Search supports, so live fields and index properties must match exactly.
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

  // `@odata.*` keys are server-assigned on GET and never committed; comparing them refuses every index.
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

/** Committed fields absent from the live index, by name only; `notAdditive()` does the deep compare. */
function missingFields(liveBody, committedBody) {
  const liveNames = new Set((liveBody.fields || []).map(f => f.name));
  return (committedBody.fields || []).map(f => f.name).filter(name => !liveNames.has(name));
}

/** `--check`: read-only drift report. An absent live index counts every committed field as missing. */
async function runCheck({ endpoint, only, log = console.log }) {
  const { indexes } = select(only);
  let drifted = 0;
  for (const { body } of indexes) {
    const live = await call(endpoint, 'GET', `/indexes/${body.name}?api-version=${API_VERSION}`);
    assertNotForbidden(live.status, live.text, `index ${body.name}`);
    if (live.status !== 200 && live.status !== 404) {
      throw new Error(`index ${body.name} returned HTTP ${live.status} reading it back: ${live.text.slice(0, 200)}`);
    }
    const missing = live.status === 404
      ? (body.fields || []).map(f => f.name)
      : missingFields(safeJson(live.text) || {}, body);
    if (missing.length > 0) {
      drifted++;
      log(`drift ${body.name}: missing fields ${missing.join(',')}`);
    } else {
      log(`ok ${body.name}`);
    }
  }
  return drifted;
}

/** What the app is serving from right now — the names `run()` refuses to PUT non-additively over. */
function servingNames(cfg) {
  return [cfg.index, cfg.projectsIndex, cfg.documentsIndex, cfg.activitiesIndex, cfg.notificationsIndex];
}

async function run({ endpoint, live, only, liveNames, log = console.log }) {
  const args = { live, only };

  // The indexes serving traffic: a non-additive PUT over one is an outage.
  const serving = new Set(liveNames.filter(Boolean));

  const { indexes, indexers } = select(args.only);

  log(`endpoint : ${endpoint}`);
  log(`live now : ${[...serving].join(', ') || '(none configured)'}`);
  log(`mode     : ${args.live ? 'LIVE — will PUT' : 'dry run'}`);
  log('');

  // Gates --live only, so a dry run is safe in every state. Checked before the first write so a
  // refusal never leaves some indexes written and others not.
  const additive = new Map();
  for (const { file, body } of indexes) {
    if (!serving.has(body.name) || !args.live) continue;
    const live = await call(endpoint, 'GET', `/indexes/${body.name}?api-version=${API_VERSION}`);
    assertNotForbidden(live.status, live.text, `index ${body.name}`);
    // Absent on a fresh service: creating it is additive.
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

  // Indexes before indexers: an indexer fails to create without its target index.
  let applied = 0;
  let driftedDataSources = 0;
  for (const { file, body } of indexes) {
    const existing = await call(endpoint, 'GET', `/indexes/${body.name}?api-version=${API_VERSION}`);
    assertNotForbidden(existing.status, existing.text, `index ${body.name}`);
    const state = existing.status === 200 ? 'exists' : existing.status === 404 ? 'absent' : `HTTP ${existing.status}`;
    // A dry run has not read the live schema, so only --live can say whether the diff is additive.
    const added = additive.get(body.name);
    const servingNote = !serving.has(body.name) || state === 'absent' ? ''
      : added === undefined ? '  ** SERVING TRAFFIC — --live refuses a non-additive change **'
        : `  ** SERVING TRAFFIC — additive, +${added} field(s) **`;
    log(`index    ${body.name.padEnd(24)} ${state}   <- ${path.basename(file)}${servingNote}`);
    if (!args.live) continue;
    const put = await call(endpoint, 'PUT', `/indexes/${body.name}?api-version=${API_VERSION}`, body);
    if (put.status >= 300) throw new Error(`PUT /indexes/${body.name} -> ${put.status} ${put.text.slice(0, 400)}`);
    applied++;
  }

  for (const { body } of indexers) {
    // Data sources are never written (connectionString is redacted on export), only checked: a missing
    // one fails the indexer PUT with an unclear message.
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
    // The data source SELECT decides which columns the indexer sees. A live query that differs from
    // the committed one leaves new fields null with no error, so say so.
    const committedDs = readCommittedDataSource(body.dataSourceName);
    const liveQuery = (safeJson(ds.text)?.container || {}).query || null;
    if (committedDs && liveQuery !== null && committedDs.container.query !== liveQuery) {
      log(
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
    log(`indexer  ${body.name.padEnd(24)} ${state}   -> ${body.targetIndexName}  (ds ${body.dataSourceName} ok)`);
    if (!args.live) continue;
    const put = await call(endpoint, 'PUT', `/indexers/${body.name}?api-version=${API_VERSION}`, body);
    if (put.status >= 300) throw new Error(`PUT /indexers/${body.name} -> ${put.status} ${put.text.slice(0, 400)}`);
    applied++;
  }

  log('');
  // Repeated at the end: the per-indexer warning scrolls past, and this failure looks green.
  if (driftedDataSources > 0) {
    log(
      `WARNING: ${driftedDataSources} data source(s) differ from the committed copy — see above. ` +
      `Indexes applied here can still be filled with the OLD column set.`);
  }
  if (!args.live) {
    log('dry run — nothing was written. Re-run with --live to apply.');
    return;
  }
  log(`applied ${applied} definition(s).`);
  log('The indexers run on their own PT5M schedule; nothing else has to be triggered.');
  log('REVOKE the Search Service Contributor grant now — this script is done with it.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = aiSearch.config();
  if (!cfg.configured) throw new Error('SEARCH_ENDPOINT is not set — nothing to apply against');
  const endpoint = cfg.endpoint.replace(/\/$/, '');
  if (args.check) {
    const drifted = await runCheck({ endpoint, only: args.only });
    // Exit 1 without throwing: drift is a report, not a script failure.
    if (drifted > 0) process.exitCode = 1;
    return;
  }
  return run({
    endpoint,
    live: args.live,
    only: args.only,
    liveNames: servingNames(cfg)
  });
}

if (require.main === module) {
  main().catch(err => {
    console.error(`[apply-search-definitions] ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs, load, select, run, runCheck, servingNames, missingFields, assertNotForbidden, readCommittedDataSource,
  safeJson, notAdditive, INDEX_DIR, INDEXER_DIR, DATASOURCE_DIR
};
