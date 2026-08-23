'use strict';

/**
 * Reading the ROUTER SOURCE, for the assertions the runtime stack cannot make.
 *
 * Express hands back `<anonymous>` for every middleware in `route.stack`, so a runtime layer cannot
 * say whether it is `authMiddleware` or `passiveAuthMiddleware` — the second attaches an anonymous
 * access object instead of rejecting, and swapping one for the other turns a privileged route into
 * a public one while a layer COUNT stays satisfied. The distinction survives only in the source.
 *
 * Both halves of this module exist because a source scan has one failure of its own: source text
 * includes comments, so a guard named in prose reads exactly like a guard that is called. Stripping
 * is not optional — a route whose middleware has been deleted and replaced by a comment naming it
 * still matches, while running no auth at all. `access-coverage.test.js` proves the stripper works
 * rather than assuming it ("a gate named only in a comment does not count"); keep that test here.
 *
 * This scans text; it does not parse an AST. Someone determined to defeat it can. That is
 * deliberate — the failure that actually happens is forgetting, and a text scan catches forgetting.
 * A parser would cost a dependency to defend against an adversary who already has commit access.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROUTER_PATH = path.join(__dirname, '..', '..', 'src', 'routes', 'api.js');

/** Strip comments so a gate named only in prose cannot satisfy an assertion about code. */
function code(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Every route declared in `src/routes/api.js`, comments already stripped.
 *
 * @returns {{method: string, path: string, chain: string}[]} `chain` is the middleware argument
 *   list as written, minus the leading path — what a `\bauthMiddleware\b` test asserts against.
 */
function routeChains(source) {
  const router = code(source === undefined ? fs.readFileSync(ROUTER_PATH, 'utf8') : source);
  return [...router.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'\s*,([^;]*?)\);/g)]
    .map(m => ({ method: m[1], path: m[2], chain: m[3] }));
}

module.exports = { code, routeChains, ROUTER_PATH };
