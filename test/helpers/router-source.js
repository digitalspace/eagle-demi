'use strict';

/**
 * Reading the ROUTE TABLE SOURCE, for the assertions the runtime table cannot make.
 *
 * A guard is a function value in `guards: [...]`, so at runtime a table entry cannot say whether it
 * holds `authMiddleware` or `passiveAuthMiddleware` — the second attaches an anonymous access
 * object instead of rejecting, and swapping one for the other turns a privileged route into a
 * public one while a guard COUNT stays satisfied. The distinction survives only in the source.
 *
 * Both halves of this module exist because a source scan has one failure of its own: source text
 * includes comments, so a guard named in prose reads exactly like a guard that is called. Stripping
 * is not optional — a route whose guard has been deleted and replaced by a comment naming it still
 * matches, while running no auth at all. `access-coverage.test.js` proves the stripper works rather
 * than assuming it ("a gate named only in a comment does not count"); keep that test here.
 *
 * This scans text; it does not parse an AST. Someone determined to defeat it can. That is
 * deliberate — the failure that actually happens is forgetting, and a text scan catches forgetting.
 * A parser would cost a dependency to defend against an adversary who already has commit access.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROUTER_PATH = path.join(__dirname, '..', '..', 'src', 'http', 'routes.js');

/** Strip comments so a gate named only in prose cannot satisfy an assertion about code. */
function code(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Every route declared in `src/http/routes.js`, comments already stripped.
 *
 * @returns {{method: string, path: string, chain: string}[]} `chain` is the guard list as written —
 *   what a `\bauthMiddleware\b` test asserts against.
 */
function routeChains(source) {
  const table = code(source === undefined ? fs.readFileSync(ROUTER_PATH, 'utf8') : source);
  return [...table.matchAll(/method:\s*'(\w+)',\s*path:\s*'([^']+)',\s*guards:\s*\[([^\]]*)\]/g)]
    .map(m => ({ method: m[1], path: m[2], chain: m[3] }));
}

/**
 * The ARGUMENT text of every call `opener` matches, read to its MATCHING paren rather than to the
 * end of the line — a call that spans lines is most of them in these controllers, and a
 * line-bounded scan silently misses `deleted: <row>` three lines below its `res.json(`.
 *
 * Comments are stripped first, so a call site named only in prose cannot satisfy an assertion.
 */
function balancedArgs(source, opener) {
  const body = code(source);
  const args = [];
  for (let m = opener.exec(body); m; m = opener.exec(body)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < body.length && depth > 0; i++) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')') depth--;
    }
    args.push(body.slice(m.index + m[0].length, i - 1).trim());
  }
  return args;
}

/** Every `res.json(...)` / `res.status(n).json(...)` argument in a controller. */
function jsonEmissions(source) {
  return balancedArgs(source, /res(?:\.status\(\d+\))?\.json\(/g);
}

module.exports = { code, routeChains, balancedArgs, jsonEmissions, ROUTER_PATH };
