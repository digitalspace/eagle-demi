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

const REPO_DIR = path.join(__dirname, '..', '..', 'src', 'repositories');

/**
 * Repositories that legitimately hold no ACL gate, each with the reason it does not need one.
 *
 * A name earns a place here by being unreachable by an ungated caller, NOT by being inconvenient
 * to gate. The route citations are the evidence; if a route moves, this suite keeps passing and the
 * reason silently rots, which is the known ceiling of an allowlist.
 * ponytail: reasons are prose, unverified against the router. Assert the middleware chain here too
 * if a route ever moves out from behind requireWrite without anyone noticing.
 */
const UNGATED = {
  'api-keys.js':
    'Every route is behind authMiddleware + requireWrite (routes/api.js:115-120). The registry is ' +
    'the credential store itself — there is no caller tier that may read part of it.',
  'boundaries.js':
    'Administrative geography, public reference data. Reads are passiveAuth (routes/api.js:106-107) ' +
    'and deliberately unrestricted; every write is behind requireWrite (:108-110).',
  'wildfires.js':
    'No read path at all. GET /wildfires was removed for having no consumer — the frontend reads ' +
    'the DataBC WFS directly — leaving only POST /admin/sync/wildfires, gated (routes/api.js:65).',
  '_sql.js':
    'Not a repository. This is the shared query builder where visibilityFor is composed, so it is ' +
    'the thing the others are asserted to route through.'
};

/** @returns {{name: string, source: string}[]} every repository module, allowlisted or not. */
function repositories() {
  return fs.readdirSync(REPO_DIR)
    .filter(f => f.endsWith('.js'))
    .map(name => ({ name, source: fs.readFileSync(path.join(REPO_DIR, name), 'utf8') }));
}

/** Strip comments so a gate named only in prose cannot satisfy an assertion about code. */
function code(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('access gate coverage', async (t) => {
  const all = repositories();

  await t.test('there are repositories to check', () => {
    // Guards the whole file: a bad path would make every assertion below vacuous, and a suite that
    // passes because it examined nothing is the failure this repo keeps writing down.
    assert.ok(all.length >= 8, `expected the repository directory, found ${all.length} files`);
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
});
