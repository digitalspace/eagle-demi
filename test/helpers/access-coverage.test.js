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

const { code, routeChains } = require('./router-source');

const REPO_DIR = path.join(__dirname, '..', '..', 'src', 'repositories');

/**
 * Repositories that legitimately hold no ACL gate, each with the reason it does not need one.
 *
 * A name earns a place here by being unreachable by an ungated caller, NOT by being inconvenient
 * to gate. The reason is prose; the ROUTER is the evidence, and it is asserted below rather than
 * cited — line-number citations rot. They already did: these entries pointed at routes/api.js:106
 * and :115 until a route removal shifted every line, and the suite kept passing while the
 * evidence silently stopped matching. `requireWritePrefixes` is the executable replacement.
 *
 * `boundaries.js` used to be listed here as "public reference data, deliberately unrestricted".
 * That described the corpus, not the requirement — a staff-only shapefile could not be expressed
 * at all. It is gated now, so it is not an exception.
 */
const UNGATED = {
  'api-keys.js':
    'The registry is the credential store itself — there is no caller tier that may read part of ' +
    'it, so every route is write-gated rather than ACL-filtered.',
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
    'the document is not published until it is added there too.'
};

/**
 * Path prefixes that must be behind `requireWrite` on EVERY method, checked against the router.
 * The first two are what the allowlist reasons above assert, expressed as something that can fail;
 * `/eagle/` is here because those handlers read and write through `systemAccess()`, so the write
 * gate is the only thing standing between a read-only credential and the mirror.
 */
const requireWritePrefixes = ['/admin/api-keys', '/admin/sync/', '/eagle/'];

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

  await t.test('the allowlisted routes really are write-gated', () => {
    // The executable half of the reasons above. An allowlist entry says "no ACL needed because
    // nothing unprivileged can reach it" — this reads the router and checks that is still true,
    // so moving a route out from behind requireWrite fails here instead of rotting a comment.
    // routeChains() strips comments first. Without that, deleting `requireWrite` and leaving its
    // name in a comment beside the handler satisfies the assertion below while the route runs
    // ungated — the same hole the sibling db_auth suite was caught on.
    const routes = routeChains();

    assert.ok(routes.length >= 20, `expected the router, parsed ${routes.length} routes`);

    for (const prefix of requireWritePrefixes) {
      const matching = routes.filter(r => r.path.startsWith(prefix));
      assert.ok(matching.length > 0, `no route matches ${prefix} — the allowlist reason is stale`);
      for (const r of matching) {
        assert.ok(
          /\bauthMiddleware\b/.test(r.chain) && /\brequireWrite\b/.test(r.chain),
          `${r.method.toUpperCase()} ${r.path} is not behind authMiddleware + requireWrite, ` +
          'so the repository it reaches can no longer be allowlisted out of the ACL gate.'
        );
      }
    }

    // wildfires is allowlisted specifically for having NO read path. Assert the absence.
    assert.strictEqual(
      routes.filter(r => r.method === 'get' && r.path.startsWith('/wildfires')).length, 0,
      'a GET /wildfires route exists again — wildfires.js now needs a real ACL gate'
    );
  });
});
