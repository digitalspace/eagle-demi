'use strict';

/**
 * Live ACL probe.
 *
 * Every row in the test corpus is public, so an anonymous caller and a privileged one see the same
 * rows and no probe over the corpus can fail. This mints two throwaway keys, plants a synthetic
 * hidden/control pair, and asserts a matrix in which each cell is a prediction competing hypotheses
 * disagree on. It cleans up after itself and exits non-zero on the first missed prediction.
 *
 * Two keys, not one: `staff` is in SECURE_ROLES, so `isPrivileged` short-circuits `readClause` to
 * `true` and a staff key proves only the SCOPE narrowing. `compliance` is the one grantable role
 * that is not privileged, so it is the only credential that exercises the `read[]` predicate.
 *
 *   ADMIN_API_KEY=... node src/scripts/probe-acl.js
 *
 * Everything it creates is removed, and the removal is itself verified. There is no --keep: the
 * plaintext is returned by the mint route once and is unrecoverable, so kept keys could not be
 * used for anything — the flag only left two live credentials behind. Revocation is not deletion
 * (there is no delete endpoint), so each run leaves one revoked record per key in the registry.
 *
 * Exit: 0 all cells passed, 1 a cell missed its prediction, 2 aborted, 3 a leg was inconclusive.
 */

const BASE = process.env.DEMI_API_BASE || 'https://demi-api-test.azurewebsites.net';
const ADMIN = process.env.ADMIN_API_KEY;

// Documents reach the search index only on the indexer's PT5M pass, so the search leg has to wait
// for its own control row before it can conclude anything.
const INDEX_WAIT_MS = 8 * 60 * 1000;
const INDEX_POLL_MS = 30 * 1000;

if (!ADMIN) {
  console.error('ADMIN_API_KEY is not set. Read it from demi-app-secrets; never pass it in argv.');
  process.exit(2);
}

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
  return { status: res.status, json, text, continuation: res.headers.get('x-continuation-token') };
}

/**
 * How many of the planted ids this caller can see on a live Cosmos list.
 *
 * PAGED, not one request: the repository orders by `c.id ASC`, so a planted UUID lands at a random
 * depth. In a project with more than one page of documents, a single request makes "0 rows" mean
 * "beyond the window" just as readily as "the ACL withheld it" — and every zero in this matrix is
 * supposed to mean only the second.
 *
 * 100 rows a page, not 1000: the anonymous legs present no credential at all, and the list routes
 * refuse a larger page from such a caller with a 400.
 */
async function listSees(key, projectId, ids) {
  let seen = 0;
  let token;
  // A bound, not a limit: 600 pages of 100 is 60,000 rows, well past the largest project in the
  // corpus. If it ever binds, the caller gets a loud string rather than a silently short count.
  for (let page = 0; page < 600; page++) {
    const q = `/api/documents?project=${encodeURIComponent(projectId)}&pageSize=100` +
      (token ? `&continuationToken=${encodeURIComponent(token)}` : '');
    const r = await api(q, { key });
    if (r.status !== 200 || !Array.isArray(r.json)) return `HTTP ${r.status}`;
    seen += r.json.filter(d => ids.includes(d._id || d.id)).length;
    token = r.continuation;
    if (!token) return seen;
  }
  return 'unpaged: more than 600 pages';
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
      // Asserted, not logged. Two of the three planted rows are `public`, and test search is
      // already served to eagle-public from this environment — a failed delete leaves them in the
      // live corpus, and printing the status let the run still exit 0.
      cell(`deleted ${doc.label}`, 200, r.status);
    }
    for (const k of keys) {
      const r = await api(`/api/admin/api-keys/${k.id}`, { key: ADMIN, method: 'DELETE' });
      console.log(`  key ${k.id}: HTTP ${r.status}`);
    }
    // The revocation has to be verified, not assumed: a live leftover key is the one thing here
    // that is worse than a failed probe. Checked against an AUTH-REQUIRED route — `/documents` is
    // passiveAuth, so it answers 200 to a rejected credential by design, having simply dropped the
    // identity. Asserting 401 there is a prediction the route can never satisfy.
    for (const k of keys) {
      const r = await api('/api/admin/api-keys', { key: k.plaintext });
      cell(`revoked key ${k.label} is refused`, 401, r.status, 'auth-required route');
    }

    // A delete has to leave the index too. The indexer's high-water mark cannot see deletes at
    // all, so `deleteFromIndex` in the controller is the only thing that removes these rows —
    // and only rows that REACHED the index can prove it ran. Skipped when they never did.
    if (searchLegRan) {
      // Polled, not read once: deletes on this service are not read-your-write, so a search
      // issued immediately after one can legitimately still return the row. A minute is far
      // past what was measured (seconds); still non-zero after it is a real finding.
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

    // The synthetic pair. `hidden` carries no `public` in read[] because resolveDocumentAcl derives
    // it, so this needs no hand-written ACL — the same code path every upload takes.
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
      // Recorded BEFORE the shape check: the key is already live for an hour by here, and a body
      // that ever drifted would otherwise throw past the only thing that revokes it.
      keys.push({ id, plaintext, label });
      if (!plaintext) throw new Error(`mint ${label}: no plaintext in response`);
      console.log(`minted ${label} key ${id} roles=${JSON.stringify(roles)} scope=${JSON.stringify(projectScope || null)}`);
      return plaintext;
    };

    // A: the only grantable NON-privileged role, so readClause does not short-circuit.
    const keyA = await mint('compliance', ['compliance'], undefined);
    // B: privileged AND scoped — proves resolveAccess resolves scope before the privilege check.
    // `demi-service-read`, not `staff`: both are in SECURE_ROLES so both are privileged for READS,
    // but `staff` is in WRITE_ROLES and the mint route refuses it without `allowWrite: true`. A
    // probe has no business holding a write credential.
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
    // The paired control the other zeroes have and this one lacked: without it a 0 below reads
    // the same whether the scope narrowed or the row was simply never in the window.
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
    // BOTH rows the leg asserts on, not just the control: `otherProject` is planted after it, so
    // an indexer pass landing between the two writes would make its own control read as a MISSED
    // prediction rather than as an unfinished index.
    const deadline = Date.now() + INDEX_WAIT_MS;
    let indexed = 0;
    while (Date.now() < deadline) {
      indexed = await searchSees(ADMIN, term, [control, otherProject]);
      if (indexed === 2) break;
      await new Promise(r => setTimeout(r, INDEX_POLL_MS));
    }

    if (indexed !== 2) {
      // Not a pass and not a failure of the predicate: without its control in the index the search
      // leg cannot tell a working filter from an empty index.
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
  // An inconclusive leg is not a pass. It proved nothing about six of the cells, and anything
  // reading only the exit status would have been told otherwise.
  process.exit(failures > 0 ? 1 : (inconclusive > 0 ? 3 : 0));
}

main().catch(async (err) => {
  console.error(`\nprobe aborted: ${err.message}`);
  process.exit(2);
});
