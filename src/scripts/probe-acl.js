'use strict';

// Live ACL probe: the test corpus is all public, so this plants a hidden/control pair and mints two keys.
// Exit: 0 all cells passed, 1 a cell missed its prediction, 2 aborted, 3 a leg was inconclusive.

const BASE = process.env.DEMI_API_BASE || 'https://demi-api-fc-test.azurewebsites.net';
// Not via src/config.js, whose boot guards are for the server. An unresolved Key Vault reference
// reads as unset, so a 401 from sending its text is never read as a broken ACL.
const { isKeyVaultReference } = require('../utils/key-vault-reference');
const ADMIN_RAW = process.env.ADMIN_API_KEY || '';
const ADMIN = isKeyVaultReference(ADMIN_RAW) ? '' : ADMIN_RAW;

// Documents reach the search index only on the indexer's PT5M pass, so the search leg has to wait
// for its own control row before it can conclude anything.
const INDEX_WAIT_MS = 8 * 60 * 1000;
const INDEX_POLL_MS = 30 * 1000;

// MAX_IDS in helpers/native-query.js, copied: requiring it loads the Cosmos client this script
// must not need. Also ANON_MAX_PAGE_SIZE, so one page holds a whole batch for the anonymous legs.
const IDS_BATCH = 100;

const results = [];
let failures = 0;

/** One cell of the matrix. `expected` is what a WORKING predicate must produce. */
function cell(name, expected, actual, note) {
  const ok = expected === actual;
  if (!ok) failures++;
  results.push({ name, expected, actual, ok, note });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: expected ${expected}, got ${actual}${note ? ` (${note})` : ''}`);
}

async function api(path, { key, method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(key ? { 'X-Api-Key': key } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text };
}

/**
 * How many planted ids this caller sees on a live list. Read by id, not paged: anonymous offset
 * paging stops at 2,000 rows, so a zero could mean "beyond the window" instead of "withheld".
 */
async function listSees(key, projectId, ids) {
  let seen = 0;
  for (let i = 0; i < ids.length; i += IDS_BATCH) {
    const batch = ids.slice(i, i + IDS_BATCH);
    const q = `/api/documents?project=${encodeURIComponent(projectId)}` +
      `&ids=${batch.map(encodeURIComponent).join(',')}&pageSize=${IDS_BATCH}`;
    const r = await api(q, { key });
    if (r.status !== 200 || !Array.isArray(r.json)) return `HTTP ${r.status}`;
    seen += r.json.filter(d => batch.includes(d._id || d.id)).length;
  }
  return seen;
}

/** How many of the planted ids this caller can find by the nonsense term. */
async function searchSees(key, term, ids) {
  const r = await api(`/api/search?dataset=Document&keywords=${encodeURIComponent(term)}&pageSize=100`, { key });
  if (r.status !== 200) return `HTTP ${r.status}`;
  const rows = (r.json && r.json[0] && r.json[0].searchResults) || [];
  return rows.filter(d => ids.includes(d._id || d.id)).length;
}

async function pointRead(key, id, projectId) {
  const r = await api(`/api/documents/${id}?project=${encodeURIComponent(projectId)}`, { key });
  return r.status;
}

async function main() {
  // A nonsense term, so a fallback that ignores keywords and returns the corpus head is visible as
  // a non-zero count rather than reading as a working search.
  const term = `zzqxprobe${Date.now().toString(36)}`;
  const created = [];
  const keys = [];
  // Set once the search leg has a control row in the index, so cleanup knows whether an index
  // assertion can mean anything.
  let searchLegRan = false;

  const cleanup = async () => {
    console.log('\ncleanup');
    for (const doc of created) {
      const r = await api(`/api/documents/${doc.id}?project=${encodeURIComponent(doc.projectId)}`,
        { key: ADMIN, method: 'DELETE' });
      // Asserted: two planted rows are public, and test search serves eagle-public.
      cell(`deleted ${doc.label}`, 200, r.status);
    }
    for (const k of keys) {
      const r = await api(`/api/admin/api-keys/${k.id}`, { key: ADMIN, method: 'DELETE' });
      console.log(`  key ${k.id}: HTTP ${r.status}`);
    }
    // Checked on an auth-required route: `/documents` is passiveAuth and answers 200 to a rejected
    // credential, so a 401 there can never happen.
    for (const k of keys) {
      const r = await api('/api/admin/api-keys', { key: k.plaintext });
      cell(`revoked key ${k.label} is refused`, 401, r.status, 'auth-required route');
    }

    // Indexers never see deletes, so this proves `deleteFromIndex` ran; only rows that reached the index can.
    if (searchLegRan) {
      // Polled: index deletes are not read-your-write. They settle in seconds, so a minute is ample.
      const settleBy = Date.now() + 60 * 1000;
      let left = await searchSees(ADMIN, term, created.map(d => d.id));
      while (left !== 0 && Date.now() < settleBy) {
        await new Promise(r => setTimeout(r, 5000));
        left = await searchSees(ADMIN, term, created.map(d => d.id));
      }
      cell('the planted rows are gone from the index', 0, left, 'deletes are the app\'s job');
    }
  };

  try {
    // Two public projects, anonymously — whatever the corpus actually holds.
    const anonProjects = await api('/api/projects?pageSize=50');
    if (anonProjects.status !== 200) throw new Error(`project list HTTP ${anonProjects.status}`);
    const pool = (Array.isArray(anonProjects.json) ? anonProjects.json : anonProjects.json.items || [])
      .map(p => String(p._id || p.id)).filter(Boolean);
    if (pool.length < 2) throw new Error(`need 2 projects, got ${pool.length}`);
    const [projectA, projectB] = pool;
    console.log(`projects: A=${projectA} B=${projectB}\nterm: ${term}\n`);

    // No hand-written ACL: resolveDocumentAcl derives read[] as for every upload.
    const plant = async (projectId, label, isPublished) => {
      const r = await api('/api/documents', {
        key: ADMIN, method: 'POST',
        body: { project: projectId, displayName: `${term} ${label}`, s3Key: `probe/${term}-${label}`, isPublished }
      });
      if (r.status !== 201) throw new Error(`plant ${label}: HTTP ${r.status} ${r.text.slice(0, 200)}`);
      const id = String(r.json._id || r.json.id);
      created.push({ id, projectId, label });
      console.log(`planted ${label} ${id} in ${projectId} (isPublished=${r.json.isPublished})`);
      return id;
    };

    const hidden = await plant(projectA, 'hidden', false);
    const control = await plant(projectA, 'control', true);
    const otherProject = await plant(projectB, 'other', true);

    const mint = async (label, roles, projectScope) => {
      const r = await api('/api/admin/api-keys', {
        key: ADMIN, method: 'POST',
        body: {
          name: `acl-probe-${label}-${term}`,
          roles,
          projectScope,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
        }
      });
      if (r.status !== 201 && r.status !== 200) {
        throw new Error(`mint ${label}: HTTP ${r.status} ${r.text.slice(0, 300)}`);
      }
      const plaintext = r.json.key || r.json.plaintext || r.json.apiKey;
      const id = String(r.json.id || r.json.keyId || (r.json.record && r.json.record.id));
      // Recorded before the shape check: the key is live, and a throw here would skip its revoke.
      keys.push({ id, plaintext, label });
      if (!plaintext) throw new Error(`mint ${label}: no plaintext in response`);
      console.log(`minted ${label} key ${id} roles=${JSON.stringify(roles)} scope=${JSON.stringify(projectScope || null)}`);
      return plaintext;
    };

    // A: the only grantable NON-privileged role, so readClause does not short-circuit.
    const keyA = await mint('compliance', ['compliance'], undefined);
    // B: privileged and scoped. `demi-service-read`, not `staff`: staff is a write role, and a probe
    // holds no write credential.
    const keyB = await mint('scoped-service-read', ['demi-service-read'], [projectA]);

    // BEFORE reading: the admin sees all three, or the rest of the matrix measures nothing.
    console.log('\n--- live reads (Cosmos, no indexer lag) ---');
    cell('admin sees the hidden row', 1, await listSees(ADMIN, projectA, [hidden]));
    cell('admin sees the control row', 1, await listSees(ADMIN, projectA, [control]));

    cell('anonymous cannot see the hidden row', 0, await listSees(null, projectA, [hidden]));
    cell('anonymous sees the control row', 1, await listSees(null, projectA, [control]),
      'the control is what proves a 0 above is the ACL and not an empty list');

    cell('compliance key cannot see the hidden row', 0, await listSees(keyA, projectA, [hidden]));
    cell('compliance key sees the control row', 1, await listSees(keyA, projectA, [control]));

    cell('scoped key sees its own project', 1, await listSees(keyB, projectA, [control]));
    // Control for the zero below: proves the row is listable at all.
    cell('the out-of-scope row IS listable at all', 1, await listSees(ADMIN, projectB, [otherProject]),
      'or the zero under it proves nothing');
    cell('scoped key sees NOTHING outside its scope', 0,
      await listSees(keyB, projectB, [otherProject]));
    cell('scoped key is privileged INSIDE its scope', 1, await listSees(keyB, projectA, [hidden]),
      'privilege lifts the role predicate; the scope still narrows');

    console.log('\n--- point reads ---');
    cell('anonymous point read of the hidden row', 404, await pointRead(null, hidden, projectA));
    cell('anonymous point read of the control row', 200, await pointRead(null, control, projectA));
    cell('compliance point read of the hidden row', 404, await pointRead(keyA, hidden, projectA));
    cell('scoped point read outside its scope', 404, await pointRead(keyB, otherProject, projectB));

    console.log('\n--- search (index, PT5M indexer) ---');
    // Wait for both controls: `otherProject` is planted later and may miss an indexer pass.
    const deadline = Date.now() + INDEX_WAIT_MS;
    let indexed = 0;
    while (Date.now() < deadline) {
      indexed = await searchSees(ADMIN, term, [control, otherProject]);
      if (indexed === 2) break;
      await new Promise(r => setTimeout(r, INDEX_POLL_MS));
    }

    if (indexed !== 2) {
      // Neither pass nor fail: without its controls indexed the leg cannot tell a filter from an empty index.
      console.log(`INCONCLUSIVE search leg: ${2 - indexed} of its 2 control rows did not reach ` +
        `the index within ${INDEX_WAIT_MS / 60000} min. Nothing below it is evidence.`);
      results.push({ name: 'search leg', expected: '2 controls indexed', actual: indexed, ok: null });
    } else {
      searchLegRan = true;
      cell('admin finds the hidden row by the nonsense term', 1, await searchSees(ADMIN, term, [hidden]));
      cell('anonymous cannot find the hidden row', 0, await searchSees(null, term, [hidden]));
      cell('anonymous finds the control row', 1, await searchSees(null, term, [control]));
      cell('compliance key cannot find the hidden row', 0, await searchSees(keyA, term, [hidden]));
      cell('the out-of-scope row IS findable at all', 1, await searchSees(ADMIN, term, [otherProject]),
        'the same pairing, on the index');
      cell('scoped key finds nothing outside its scope', 0,
        await searchSees(keyB, term, [otherProject]));
    }
  } finally {
    await cleanup();
  }

  const inconclusive = results.filter(r => r.ok === null).length;
  console.log(`\n${results.filter(r => r.ok === true).length} passed, ${failures} failed, ` +
    `${inconclusive} inconclusive`);
  // An inconclusive leg is not a pass.
  process.exit(failures > 0 ? 1 : (inconclusive > 0 ? 3 : 0));
}

if (require.main === module) {
  if (!ADMIN) {
    console.error('ADMIN_API_KEY is not set. Read it from demi-app-secrets; never pass it in argv.');
    process.exit(2);
  }
  main().catch(async (err) => {
    console.error(`\nprobe aborted: ${err.message}`);
    process.exit(2);
  });
}

module.exports = { listSees };
