'use strict';

// The route table's source: at runtime a guard is a function, so `authMiddleware` and `passiveAuthMiddleware`
// look alike. Comments are stripped first, or a guard named in prose would pass for one that runs.

const fs = require('node:fs');
const path = require('node:path');

const ROUTER_PATH = path.join(__dirname, '..', '..', 'src', 'http', 'routes.js');
// Route files `routes.js` spreads in; their entries are part of the one table.
const ROUTE_PARTS = ['routes-track.js'].map(name => path.join(path.dirname(ROUTER_PATH), name));

/** Strip comments so a gate named only in prose cannot satisfy an assertion about code. */
function code(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Every route declared in `src/http/routes.js` and the files it spreads in, comments already stripped.
 *
 * @returns {{method: string, path: string, chain: string}[]} `chain` is the guard list as written —
 *   what a `\bauthMiddleware\b` test asserts against.
 */
function routeChains(source) {
  const read = () => [ROUTER_PATH, ...ROUTE_PARTS].map(file => fs.readFileSync(file, 'utf8')).join('\n');
  const table = code(source === undefined ? read() : source);
  return [...table.matchAll(/method:\s*'(\w+)',\s*path:\s*'([^']+)',\s*guards:\s*\[([^\]]*)\]/g)]
    .map(m => ({ method: m[1], path: m[2], chain: m[3] }));
}

/** The argument text of every call `opener` matches, read to its matching paren: most calls here span lines. */
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
