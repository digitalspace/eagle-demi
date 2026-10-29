'use strict';

/**
 * A new repository read fails here until it routes through `_sql.js` or follows a point read with
 * `canRead`. Scans source text, not an AST: it catches forgetting, not an adversary.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { code, routeChains, balancedArgs, jsonEmissions } = require('./router-source');

const REPO_DIR = path.join(__dirname, '..', '..', 'src', 'repositories');
const CONTROLLER_DIR = path.join(__dirname, '..', '..', 'src', 'controllers');

/**
 * Repositories with no ACL gate, each with the reason. Only for names no ungated caller can reach;
 * the router is the evidence, asserted via `gatedPrefixes` below because line citations rot.
 */
const UNGATED = {
  'api-keys.js':
    'The registry is the credential store itself — there is no caller tier that may read part of ' +
    'it, so every route is admin-gated rather than ACL-filtered.',
  'credentials.js':
    'The grant registry, not application data: a row names who may see what, so there is no ' +
    'caller tier that may read part of it. Every /credentials route is authMiddleware + ' +
    'requireWrite + requireRole(sysadmin), asserted below; the middleware reads it by party, ' +
    'internally.',
  'wildfires.js':
    'No read path at all. GET /wildfires was removed for having no consumer — the frontend reads ' +
    'the DataBC WFS directly — leaving only the admin sync.',
  '_sql.js':
    'Not a repository. This is the shared query builder where visibilityFor is composed, so it is ' +
    'the thing the others are asserted to route through.',
  'config.js':
    'Two documents, served to anonymous callers by GET /api/config and GET /api/config/public, so ' +
    'there is no tier that may read only part of either and nothing to filter. What bounds each ' +
    "payload is the controller's explicit key allowlist — OVERRIDABLE_KEYS for the admin console, " +
    'PUBLIC_KEYS for the public site — not a permission field. A key added to a document is not ' +
    'published until it is added to the matching list too.',
  'cache.js':
    'Holds no application data. It is read by GET /admin/cost and GET /admin/reconcile, both ' +
    'admin-gated and asserted below, and written by the cost route and the scheduled reconcile ' +
    'job. What it stores is operator data computed for an admin, so there is no tier that may ' +
    'read part of a row, and nothing here a caller reaches except through those gates.',
  'links.js':
    'Rows carry no per-document ACL. GET /api/links is route-gated (authMiddleware only, no ' +
    'ACL predicate needed since every row is staff-visible); create/repoint/delete are ' +
    'admin/write-gated; and /s/:code is a deliberately PUBLIC point read with no caller tier to ' +
    'filter for — the destination itself, not the row, is what gets validated. Its one read of ' +
    'the PROJECTS container, listProjectCodes, is gated like any other: it composes selectWhere ' +
    'with the access it is handed, asserted below.',
  'edge-bans.js':
    'Ban rows are not application data: banned edge addresses and a crawler range cache, read and ' +
    'written only by the edge-ban timer and its CLI. No route reaches the container.',
  'bulk-downloads.js':
    'Job rows are not application data: a row records what its own requester asked for, carries no ' +
    'read[] and is never listed. The unguessable job id is the capability, and the controller binds ' +
    'an authenticated job to its requester and answers 404 on a mismatch. Its DOCUMENT read is ' +
    'documents.listByIdsUnscoped, gated there with every other document read and asserted above.',
  'projectSummaries.js':
    'A summary row carries no read[] of its own, and needs none: the generator builds it from ' +
    'level-4 documents only (isPublicSource in src/ai/project-summary.js) and the row asserts that ' +
    'as sourceAccess, which putProjectSummary refuses a record without. So no part of a row is ' +
    'narrower than its project, and the gate is the PROJECT: both /projects/:id/summary routes ' +
    're-read the project under the caller\'s access and 404 when it is not readable, exactly as ' +
    'GET /projects/:id does, and both are behind authMiddleware (asserted below).',
  'userdata.js':
    'The partition key IS the access rule: every function takes the owner as its first argument ' +
    'and the controller only ever passes the caller\'s own token username, so a row of another ' +
    'user is unreachable rather than filtered out. Rows carry no read[] and no tier can see part ' +
    'of one, so there is nothing for visibilityFor or canRead to compose.'
};

/**
 * Prefixes that must carry the named guards on EVERY method. `/admin/*` demands requireAdmin: with
 * requireWrite a `demi-service-write` holder could mint itself a `demi-admin` key.
 */
const gatedPrefixes = {
  '/admin/api-keys': ['authMiddleware', 'requireAdmin'],
  '/admin/sync/': ['authMiddleware', 'requireAdmin'],
  // The Azure read routes: the audit trail names every actor, and the usage and cost figures are
  // operator data. None of them touch a repository, so this file is the only thing gating them.
  '/admin/audit': ['authMiddleware', 'requireAdmin'],
  '/admin/analytics': ['authMiddleware', 'requireAdmin'],
  '/admin/cost': ['authMiddleware', 'requireAdmin'],
  // The stored reconcile report lists Eagle ids by drift class, private ones included.
  '/admin/reconcile': ['authMiddleware', 'requireAdmin'],
  '/eagle/': ['authMiddleware', 'requireWrite', 'requireEagleMirror'],
  // The ENGAGE ingest writes through systemAccess() too, so it is pinned the same way to ENGAGE.
  '/engage/': ['authMiddleware', 'requireWrite', 'requireEngageWriter'],
  // The executable half of the `credentials.js` reason above. `requireRole` is the narrow gate a
  // grant needs: requireWrite alone would let the machine writer mint one for itself.
  '/credentials': ['authMiddleware', 'requireRole'],
  // `authMiddleware` is ABSENT on purpose: AUTHENTICATED_ROLES excludes `compliance`, so it would
  // lock out the compartment's only caller. `sealedAuth` plus the named role is the authorisation.
  '/sealed': ['sealedAuth', "requireRole('compliance')"],
  // passiveAuth, not authMiddleware: an anonymous caller gets the public tier, as on
  // /documents/:id/download.
  '/bulk-downloads': ['passiveAuthMiddleware', 'credentialsMiddleware']
};

/** Per-verb gates: `gatedPrefixes` cannot express a gate that depends on the verb. */
const gatedRoutes = [
  { method: 'get', path: '/links', gate: null },
  { method: 'post', path: '/links', gate: 'requireWrite' },
  { method: 'put', path: '/links/:code', gate: 'requireWrite' },
  { method: 'delete', path: '/links/:code', gate: 'requireWrite' },
  // GET's ACL is the project read in the controller; PUT adds requireWrite so a read-only
  // credential cannot store prose that renders as EAO's account of a project.
  { method: 'get', path: '/projects/:id/summary', gate: null },
  { method: 'put', path: '/projects/:id/summary', gate: 'requireWrite' },
  // Staff only: the machine writer holds requireWrite but not requireAdmin.
  { method: 'put', path: '/projects/:id/short-code', gate: 'requireAdmin' },
  // The only route that returns full chunk text. authMiddleware, never passiveAuth.
  { method: 'get', path: '/documents/:id/chunks', gate: null },
  // /me/*: authMiddleware also supplies the partition key; unauthenticated would write to ''.
  { method: 'get', path: '/me/data', gate: null },
  { method: 'put', path: '/me/lassos', gate: null },
  { method: 'delete', path: '/me/lassos/:slug', gate: null },
  { method: 'put', path: '/me/queries', gate: null },
  { method: 'delete', path: '/me/queries/:slug', gate: null },
  { method: 'put', path: '/me/prefs', gate: null }
];

/** @returns {{name: string, source: string}[]} every repository module, allowlisted or not. */
function repositories() {
  return fs.readdirSync(REPO_DIR)
    .filter(f => f.endsWith('.js'))
    .map(name => ({ name, source: fs.readFileSync(path.join(REPO_DIR, name), 'utf8') }));
}


test('access gate coverage', async (t) => {
  const all = repositories();

  await t.test('there are repositories to check', () => {
    // Guards the whole file: a bad path would make every assertion below vacuous, and a suite that
    // passes because it examined nothing is the failure this repo keeps writing down.
    assert.ok(all.length >= 7, `expected the repository directory, found ${all.length} files`);
  });

  await t.test('every allowlisted name still exists', () => {
    // A stale allowlist is how an entry outlives its reason. If a repository is renamed or deleted,
    // fail here rather than silently exempting a name nothing resolves to.
    for (const name of Object.keys(UNGATED)) {
      assert.ok(all.some(r => r.name === name), `${name} is allowlisted but no longer exists`);
    }
  });

  await t.test('every gated repository composes visibilityFor through _sql', () => {
    for (const { name, source } of all) {
      if (UNGATED[name]) continue;
      const body = code(source);
      assert.ok(
        /\b(selectWhere|countWhere)\s*\(/.test(body),
        `${name} reads without selectWhere/countWhere, so nothing composes visibilityFor for it. ` +
        'Route it through _sql.js, or add it to UNGATED with the reason it needs no gate.'
      );
    }
  });

  await t.test('every point read is followed by canRead', () => {
    // The sharp edge. cosmos.readItem returns the item regardless of roles, so the query predicate
    // that protects listVisible does nothing here.
    for (const { name, source } of all) {
      const body = code(source);
      if (!/cosmos\.readItem\s*\(/.test(body)) continue;
      if (UNGATED[name]) continue;
      assert.ok(
        /\bcanRead\s*\(/.test(body),
        `${name} calls cosmos.readItem without canRead — a point read bypasses the query ` +
        'predicate, so this returns documents the caller may not see.'
      );
    }
  });

  await t.test('a gate named only in a comment does not count', () => {
    // Proves code() actually strips, so the two assertions above cannot be satisfied by prose.
    const commented = code('// canRead(doc, access)\n/* selectWhere({}) */\nconst x = 1;');
    assert.ok(!/canRead\s*\(/.test(commented));
    assert.ok(!/selectWhere\s*\(/.test(commented));
  });

  await t.test('the allowlist carries a reason, not just a name', () => {
    for (const [name, reason] of Object.entries(UNGATED)) {
      assert.ok(
        typeof reason === 'string' && reason.length > 40,
        `${name} is allowlisted without a usable reason — the next reader has to re-derive it`
      );
    }
  });

  await t.test('the allowlisted routes really are gate-guarded', () => {
    // Checks the router still backs each allowlist reason. routeChains() strips comments, or a
    // `requireWrite` left in a comment would satisfy the assertion while the route runs ungated.
    const routes = routeChains();

    assert.ok(routes.length >= 20, `expected the router, parsed ${routes.length} routes`);

    for (const [prefix, gates] of Object.entries(gatedPrefixes)) {
      const matching = routes.filter(r => r.path.startsWith(prefix));
      assert.ok(matching.length > 0, `no route matches ${prefix} — the allowlist reason is stale`);
      for (const r of matching) {
        for (const gate of gates) {
          // `\b` and not `includes`, so `passiveAuthMiddleware` cannot satisfy `authMiddleware`.
          const named = new RegExp(`\\b${gate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
          assert.ok(
            named.test(r.chain),
            `${r.method.toUpperCase()} ${r.path} is not behind ${gate}, ` +
            'so the repository it reaches can no longer be allowlisted out of the ACL gate.'
          );
        }
      }
    }

    // Asserted as an ABSENCE: swapping requireAdmin for requireWrite on the key routes would
    // satisfy every other assertion in this file.
    for (const r of routes.filter(route => route.path.startsWith('/admin/api-keys'))) {
      assert.ok(
        !/\brequireWrite\b/.test(r.chain),
        `${r.method.toUpperCase()} ${r.path} is behind requireWrite, so a demi-service-write ` +
        'credential can mint itself a demi-admin key.'
      );
    }

    // wildfires is allowlisted specifically for having NO read path. Assert the absence.
    assert.strictEqual(
      routes.filter(r => r.method === 'get' && r.path.startsWith('/wildfires')).length, 0,
      'a GET /wildfires route exists again — wildfires.js now needs a real ACL gate'
    );
  });

  await t.test('the links list tags rows only through the caller\'s own project access', () => {
    const repo = code(fs.readFileSync(path.join(REPO_DIR, 'links.js'), 'utf8'));
    const fn = repo.slice(repo.indexOf('async function listProjectCodes'));
    assert.match(fn, /^async function listProjectCodes\(access\) \{\s*if \(!access\) throw/,
      'access has no default, so omitting it cannot read past the ACL');
    assert.match(fn, /selectWhere\(\{\s*access,/, 'listProjectCodes must compose the access it is handed');
    const controller = code(fs.readFileSync(path.join(CONTROLLER_DIR, 'nosql', 'link.js'), 'utf8'));
    const calls = controller.match(/listProjectCodes\([^)]*\)/g) || [];
    assert.deepStrictEqual(calls, ['listProjectCodes(resolveAccess(req)'],
      'GET /links must tag through the caller\'s access');
  });

  /**
   * Field gate, per CALL SITE (docs/rbac-architecture.md §2 item 1): a project emitted without
   * `redactForAccess` ships `read[]`, `vis`, raw `sources` and Cosmos system fields.
   */
  await t.test('every project response site redacts', () => {
    const controller = fs.readFileSync(path.join(CONTROLLER_DIR, 'nosql', 'project.js'), 'utf8');
    const emissions = jsonEmissions(controller);
    // Exact, not a floor: a floor passes when a site is DELETED and replaced by a wider one.
    assert.strictEqual(emissions.length, 46,
      `the project controller's response sites changed; re-check each, then update this count (found ${emissions.length})`);
    // The short-link sites by name: the count alone passes when one is swapped for a wider one.
    for (const site of [
      "shortCodeBody(redactForAccess('projects', settled, access), settled)",
      '{ error: LINK_RACE_ERROR }',
      "{ error: 'Send shortCode, url, or both' }"
    ]) {
      assert.ok(emissions.includes(site), `missing short-link response site: ${site}`);
    }

    // The dot lookahead separates a bare row from a literal reading one scalar off it
    // (`{ id: saved.id }` carries no ACL); counting those would fail against correct code.
    const ROW_SOURCES = /\b(saved|existing|items|page|project)\b(?!\s*\.)|\b(items|page)\.map\(/;
    const unredacted = emissions.filter(e => ROW_SOURCES.test(e) && !/redactForAccess/.test(e));
    assert.deepStrictEqual(unredacted, [],
      'these emit a stored project row without redactForAccess — each ships read[], vis and sources');

    // The fallback redacts inside the mapper (the catalog must never run over wire names, §2
    // item 9), so its `res.json` argument says nothing; assert the mapper body.
    const search = fs.readFileSync(path.join(CONTROLLER_DIR, 'search.js'), 'utf8');
    const mappers = balancedArgs(search, /\bprojects\.map\(/g);
    assert.strictEqual(mappers.length, 1, 'expected one Cosmos project mapper in search.js');
    assert.match(mappers[0], /redactForAccess\('projects'/,
      'the Cosmos project fallback maps a raw repository row');
    assert.ok(!/\bp\.[A-Za-z]/.test(mappers[0]),
      'the mapper reads fields off the redacted row, never off the raw repository row');
  });

  /** The same ratchet over the document controller. */
  await t.test('every document response site redacts', () => {
    const controller = fs.readFileSync(path.join(CONTROLLER_DIR, 'nosql', 'document.js'), 'utf8');
    const emissions = jsonEmissions(controller);
    // Exact, not a floor: a floor passes when a site is deleted and replaced by a wider one.
    // Non-literal statuses (resolveDownload, headDownload) are outside the scan; pinned below.
    assert.strictEqual(emissions.length, 50,
      `the document controller's response sites changed; re-check each, then update this count (found ${emissions.length})`);

    // `ranked` and `memoed` are the recent-uploads row lists, named here so a site that emits
    // either one BARE is caught the way a bare `items` is.
    const ROW_SOURCES = /\b(saved|updated|existing|doc|items|ranked|memoed)\b(?!\s*\.)|\b(items|page)\.map\(/;
    // Recent-uploads rows are redacted inside `recentUploadRow` (a wire shape the catalog must not
    // run over), so these two emissions are exempt by exact text and the builder is asserted below.
    const BUILT_ELSEWHERE = /^\{ items: (ranked|memoed) \}$/;
    const unredacted = emissions.filter(e => ROW_SOURCES.test(e) &&
      !/redact(All)?ForAccess/.test(e) && !BUILT_ELSEWHERE.test(e.trim()));
    assert.deepStrictEqual(unredacted, [],
      'these emit a stored document row without redactForAccess — each ships read[], s3Key and _etag');

    // The builder must redact BOTH rows and read only off the copies: `projectId: project.id`
    // would ship an id the redactor withheld.
    const builder = /function recentUploadRow\([^)]*\) \{([\s\S]*?)\n\}/.exec(code(controller));
    assert.ok(builder, 'recentUploadRow is gone — re-check what builds a recent-uploads row');
    assert.match(builder[1], /redactForAccess\('documents'/);
    assert.match(builder[1], /redactForAccess\('projects'/);
    assert.ok(!/\b(doc|project)\.[A-Za-z]/.test(builder[1]),
      'the recent-uploads row reads a field off a stored row rather than off its redacted copy');

    // Proves the filter above is not vacuous: the hand-built sites really are in the scan, so a new
    // one that DID name a row bare would be caught rather than silently skipped.
    assert.ok(emissions.some(e => /'upsert'/.test(e)), 'the Eagle push ack is in the scan');
    assert.ok(emissions.some(e => /chunks:/.test(e)), 'a chunk ingest ack is in the scan');

    // The download payload is no longer a res.json site, so the scan cannot see it. It is the one
    // response built from a document row outside the emission set — assert it stays hand-built.
    const download = /return \{\s*status: 200,\s*body: \{([^}]*)\}/.exec(code(controller));
    assert.ok(download, 'resolveDownload no longer returns a literal body — re-check what it emits');
    assert.ok(!/\bdoc\b(?!\s*\.)/.test(download[1]),
      'the download body names the stored document row bare, so it ships read[] and s3Key');

    // findStoredFile's refusals reach the caller through that unscanned site, so its bodies are
    // pinned as exact text: anything else it returned would ship unseen.
    const finder = /async function findStoredFile\([^)]*\) \{([\s\S]*?)\n\}/.exec(code(controller));
    assert.ok(finder, 'findStoredFile is gone — re-check what the download routes answer with');
    assert.deepStrictEqual(finder[1].match(/body: \{[^}]*\}/g), [
      "body: { error: 'Document not found' }",
      "body: { error: 'Document has no stored file.' }"
    ], 'findStoredFile answers with a body other than its two error strings');
    // The same site sends downloadFailed's body when the lookup throws.
    const failed = /function downloadFailed\([^)]*\) \{([\s\S]*?)\n\}/.exec(code(controller));
    assert.ok(failed, 'downloadFailed is gone — re-check what a failed download answers with');
    assert.deepStrictEqual(failed[1].match(/body: \{[^}]*\}/g),
      ["body: { error: 'Failed to generate download link.' }"]);
  });

  await t.test('every /me route in the router is on the list above', () => {
    // The list is checked route by route below, so a new /me route that nobody added to it would
    // be gated by nothing but the router's own text. Enumerate from the router, not from the list.
    const listed = new Set(gatedRoutes.map(r => `${r.method} ${r.path}`));
    const missing = routeChains()
      .filter(r => r.path.startsWith('/me/'))
      .map(r => `${r.method} ${r.path}`)
      .filter(key => !listed.has(key));

    assert.deepStrictEqual(missing, [],
      'these /me routes are not in gatedRoutes, so nothing checks the gate they carry');
  });

  await t.test('each /links and /me route carries the gate its verb requires', () => {
    const routes = routeChains();

    for (const { method, path, gate } of gatedRoutes) {
      const matching = routes.filter(r => r.method === method && r.path === path);
      assert.ok(matching.length > 0, `no route matches ${method.toUpperCase()} ${path}`);
      for (const r of matching) {
        assert.ok(
          /\bauthMiddleware\b/.test(r.chain),
          `${method.toUpperCase()} ${path} is not behind authMiddleware`
        );
        if (gate) {
          assert.ok(
            new RegExp(`\\b${gate}\\b`).test(r.chain),
            `${method.toUpperCase()} ${path} is not behind ${gate}`
          );
        }
      }
    }
  });
});
