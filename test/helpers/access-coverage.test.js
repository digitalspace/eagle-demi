'use strict';

/**
 * Every repository read is gated, and a new one fails this suite until somebody says which way.
 *
 * `access-sql.test.js` and `access-odata.test.js` test the gates themselves — that
 * `visibilityFor` emits the right predicate, that `filterFor` restricts an anonymous caller. What
 * neither of them can see is whether a read path *uses* one. That is the gap this file closes, and
 * the failure it guards against is silent: a repository that forgets its gate returns more rows,
 * not an error, and nothing DEMI logs is retained anywhere, so nobody would find out from a log.
 *
 * The invariant is checkable because the code already funnels reads through two choke points:
 *
 *  1. **Query reads** compose `visibilityFor` inside `_sql.js`'s `selectWhere`/`countWhere`. A
 *     repository routing through those is gated for free — and so are its counts, which is the
 *     "counts use the same predicate as reads" rule holding by construction rather than by memory.
 *  2. **Point reads** bypass the query predicate entirely. `cosmos.readItem` hands back the item
 *     whatever the caller's roles are, so each call site must follow it with `canRead`.
 *
 * **This scans source text; it does not parse an AST.** Someone determined to defeat it can — write
 * the call through a variable and the grep misses. That is deliberate and it is not the threat: the
 * failure mode that actually happens here is forgetting, and forgetting is exactly what a text scan
 * catches. A parser would cost a dependency and buy protection against an adversary who already has
 * commit access.
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
 * Repositories that legitimately hold no ACL gate, each with the reason it does not need one.
 *
 * A name earns a place here by being unreachable by an ungated caller, NOT by being inconvenient
 * to gate. The reason is prose; the ROUTER is the evidence, and it is asserted below rather than
 * cited — line-number citations rot. They already did: these entries pointed at routes/api.js:106
 * and :115 until a route removal shifted every line, and the suite kept passing while the
 * evidence silently stopped matching. `gatedPrefixes` is the executable replacement.
 *
 * `boundaries.js` used to be listed here as "public reference data, deliberately unrestricted".
 * That described the corpus, not the requirement — a staff-only shapefile could not be expressed
 * at all. It is gated now, so it is not an exception.
 */
const UNGATED = {
  'api-keys.js':
    'The registry is the credential store itself — there is no caller tier that may read part of ' +
    'it, so every route is admin-gated rather than ACL-filtered.',
  'wildfires.js':
    'No read path at all. GET /wildfires was removed for having no consumer — the frontend reads ' +
    'the DataBC WFS directly — leaving only the admin sync.',
  '_sql.js':
    'Not a repository. This is the shared query builder where visibilityFor is composed, so it is ' +
    'the thing the others are asserted to route through.',
  'config.js':
    'One document, served verbatim to anonymous callers by GET /api/config, so there is no tier ' +
    'that may read only part of it and nothing to filter. What bounds the payload is the ' +
    "controller's explicit OVERRIDABLE_KEYS allowlist, not a permission field — a key added to " +
    'the document is not published until it is added there too.',
  'links.js':
    'Rows carry no per-document ACL. GET /api/links is route-gated (authMiddleware only, no ' +
    'ACL predicate needed since every row is staff-visible); create/repoint/delete are ' +
    'admin/write-gated; and /s/:code is a deliberately PUBLIC point read with no caller tier to ' +
    'filter for — the destination itself, not the row, is what gets validated.'
};

/**
 * Path prefixes that must carry a named gate on EVERY method, checked against the router.
 *
 * The `/admin/*` entries are what the allowlist reasons above assert, expressed as something that
 * can fail. They demand `requireAdmin`, the NARROWER gate: `requireWrite` there would let a
 * machine writer holding `demi-service-write` mint itself a `demi-admin` key, which is the one
 * escalation the two-gate split exists to prevent.
 *
 * `/eagle/` demands `requireWrite` because those handlers read and write through `systemAccess()`,
 * so the write gate is the only thing standing between a read-only credential and the mirror. It
 * is deliberately NOT `requireAdmin` — the Eagle push is exactly the consumer that should hold
 * `demi-service-write` and nothing more.
 */
const gatedPrefixes = {
  '/admin/api-keys': 'requireAdmin',
  '/admin/sync/': 'requireAdmin',
  '/eagle/': 'requireWrite'
};

/**
 * Per-verb gates on /links: GET is authMiddleware only (every row is staff-visible), but the three
 * mutating verbs also need requireWrite — one gate per prefix (gatedPrefixes, above) cannot express
 * a route whose gate depends on its verb, so this is checked as an explicit list instead.
 */
const gatedRoutes = [
  { method: 'get', path: '/links', gate: null },
  { method: 'post', path: '/links', gate: 'requireWrite' },
  { method: 'put', path: '/links/:code', gate: 'requireWrite' },
  { method: 'delete', path: '/links/:code', gate: 'requireWrite' }
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
    // The executable half of the reasons above. An allowlist entry says "no ACL needed because
    // nothing unprivileged can reach it" — this reads the router and checks that is still true,
    // so moving a route out from behind requireWrite fails here instead of rotting a comment.
    // routeChains() strips comments first. Without that, deleting `requireWrite` and leaving its
    // name in a comment beside the handler satisfies the assertion below while the route runs
    // ungated — the same hole the sibling db_auth suite was caught on.
    const routes = routeChains();

    assert.ok(routes.length >= 20, `expected the router, parsed ${routes.length} routes`);

    for (const [prefix, gate] of Object.entries(gatedPrefixes)) {
      const matching = routes.filter(r => r.path.startsWith(prefix));
      assert.ok(matching.length > 0, `no route matches ${prefix} — the allowlist reason is stale`);
      for (const r of matching) {
        assert.ok(
          /\bauthMiddleware\b/.test(r.chain) && new RegExp(`\\b${gate}\\b`).test(r.chain),
          `${r.method.toUpperCase()} ${r.path} is not behind authMiddleware + ${gate}, ` +
          'so the repository it reaches can no longer be allowlisted out of the ACL gate.'
        );
      }
    }

    // The escalation the split exists to block, asserted as an ABSENCE rather than left implied:
    // requireAdmin is not a synonym for requireWrite, and a mount that swapped one for the other
    // on the key routes would satisfy every other assertion in this file.
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

  /**
   * The ROW gate says which records; the field catalog says which attributes of one. This is the
   * second half, checked per CALL SITE rather than per file (docs/rbac-architecture.md §2 item 1):
   * a response that emits a stored project without `redactForAccess` ships `read[]`, `vis`, the
   * raw `sources` payloads and the Cosmos system fields to whoever asked.
   */
  await t.test('every project response site redacts', () => {
    const controller = fs.readFileSync(path.join(CONTROLLER_DIR, 'nosql', 'project.js'), 'utf8');
    const emissions = jsonEmissions(controller);
    // Exact, not a floor: a floor passes when a site is DELETED and replaced by a wider one.
    assert.strictEqual(emissions.length, 22,
      `the project controller's response sites changed; re-check each, then update this count (found ${emissions.length})`);

    // A site emitting a stored row names it BARE (`redactForAccess('projects', saved, access)`) or
    // maps over the page. The negative lookahead for a dot is what separates that from a literal
    // that merely reads a scalar off one: `{ id: saved.id, action: 'upsert' }` carries no ACL, and
    // counting it would fail this test against correct code — which is how a source invariant gets
    // deleted by the next person instead of fixed.
    const ROW_SOURCES = /\b(saved|existing|items|page|project)\b(?!\s*\.)|\b(items|page)\.map\(/;
    const unredacted = emissions.filter(e => ROW_SOURCES.test(e) && !/redactForAccess/.test(e));
    assert.deepStrictEqual(unredacted, [],
      'these emit a stored project row without redactForAccess — each ships read[], vis and sources');

    // The search fallback redacts one step EARLIER, inside the mapper, because the mapper emits
    // eagle-search wire names and the catalog must never run over its output (§2 item 9). Its
    // `res.json` argument therefore says nothing, so the mapper body is what gets asserted.
    const search = fs.readFileSync(path.join(CONTROLLER_DIR, 'search.js'), 'utf8');
    const mappers = balancedArgs(search, /\bprojects\.map\(/g);
    assert.strictEqual(mappers.length, 1, 'expected one Cosmos project mapper in search.js');
    assert.match(mappers[0], /redactForAccess\('projects'/,
      'the Cosmos project fallback maps a raw repository row');
    assert.ok(!/\bp\.[A-Za-z]/.test(mappers[0]),
      'the mapper reads fields off the redacted row, never off the raw repository row');
  });

  /**
   * The same ratchet over the document controller. Five of its `res.json` sites are hand-built
   * payloads — the download URL, the Eagle push ack and the three ingest acks — and they read only
   * scalars off a row, so the dotted-name lookahead is what tells them apart from a site that
   * emits the row itself.
   */
  await t.test('every document response site redacts', () => {
    const controller = fs.readFileSync(path.join(CONTROLLER_DIR, 'nosql', 'document.js'), 'utf8');
    const emissions = jsonEmissions(controller);
    // Exact, not a floor: a floor passes when a site is DELETED and replaced by a wider one.
    assert.strictEqual(emissions.length, 34,
      `the document controller's response sites changed; re-check each, then update this count (found ${emissions.length})`);

    const ROW_SOURCES = /\b(saved|updated|existing|doc|items)\b(?!\s*\.)/;
    const unredacted = emissions.filter(e => ROW_SOURCES.test(e) &&
      !/redact(All)?ForAccess/.test(e));
    assert.deepStrictEqual(unredacted, [],
      'these emit a stored document row without redactForAccess — each ships read[], s3Key and _etag');

    // Proves the filter above is not vacuous: the hand-built sites really are in the scan, so a new
    // one that DID name a row bare would be caught rather than silently skipped.
    assert.ok(emissions.some(e => /expiresIn/.test(e)), 'the download URL site is in the scan');
    assert.ok(emissions.some(e => /action: 'upsert'/.test(e)), 'the Eagle push ack is in the scan');
  });

  await t.test('each /links route carries the gate its verb requires', () => {
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
