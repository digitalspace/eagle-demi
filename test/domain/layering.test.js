'use strict';

// The import direction in docs/eagle-api-port.md "Layering", checked by a text scan of src/.
// routes.js -> controllers/native -> domain -> repositories -> db.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { code } = require('../helpers/router-source');

const SRC = path.join(__dirname, '..', '..', 'src');

/** Layer violations that predate the rules. Each names the one violation it excuses. */
const EXEMPT = Object.freeze({
  'repositories/links.js': {
    violation: 'imports vis/redact',
    reason: 'a short-code lookup answers only the codes this caller may see, so the project field dials apply inside it'
  },
  'repositories/_sql.js': {
    violation: 'imports vis/redact',
    reason: 'a filter or sort on a field the caller cannot see is refused where the SQL is built, or row matches would leak its value'
  },
  'repositories/credentials.js': {
    violation: 'imports utils/audit',
    reason: 'a project delete narrows and revokes credentials with no request in hand, and each changed row is audited there'
  }
});

/** Every relative `require` in `source`, as a path under src/ with no extension. */
function importsOf(file, source) {
  const dir = path.posix.dirname(file);
  return [...code(source).matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)]
    .map(m => path.posix.normalize(path.posix.join(dir, m[1])).replace(/\.js$/, ''));
}

/** The layer rules `source` breaks, as `file` (a path under src/). */
function violations(file, source) {
  const imports = importsOf(file, source);
  const text = code(source);
  const found = [];
  const ban = (...layers) => {
    for (const target of imports) {
      if (layers.some(layer => target === layer || target.startsWith(`${layer}/`))) found.push(`imports ${target}`);
    }
  };

  if (file.startsWith('controllers/native/') && imports.some(target => target.startsWith('domain/'))) {
    ban('db');
    if (/\bres\.(?:status|json)\b/.test(text)) found.push('writes res.status or res.json');
  }
  if (file.startsWith('domain/')) {
    ban('http', 'db');
    if (/\bres\./.test(text)) found.push('touches res');
  }
  if (file.startsWith('repositories/')) ban('domain', 'controllers', 'utils/audit', 'vis/redact');
  return found;
}

/** Exempt entries whose file no longer breaks the rule they excuse. */
function staleExemptions(exempt, sourceOf) {
  return Object.entries(exempt)
    .filter(([file, { violation }]) => !violations(file, sourceOf(file)).includes(violation))
    .map(([file]) => file);
}

const readSrc = (file) => (fs.existsSync(path.join(SRC, file)) ? fs.readFileSync(path.join(SRC, file), 'utf8') : '');

function layerFiles() {
  return ['controllers/native', 'domain', 'repositories'].flatMap(dir =>
    fs.readdirSync(path.join(SRC, dir), { recursive: true })
      .filter(name => name.endsWith('.js'))
      .map(name => path.posix.join(dir, name.split(path.sep).join('/'))));
}

test('every file in a layer keeps to the import direction', () => {
  const files = layerFiles();
  assert.ok(files.some(f => f.startsWith('domain/')) && files.some(f => f.startsWith('repositories/')),
    'the scan must find files in each layer, or it passes by reading nothing');

  const broken = files.flatMap(file => violations(file, readSrc(file))
    .filter(found => !(EXEMPT[file] && EXEMPT[file].violation === found))
    .map(found => `${file} ${found}`));
  assert.deepStrictEqual(broken, []);
});

test('every exempt entry still excuses a real violation', () => {
  assert.deepStrictEqual(staleExemptions(EXEMPT, readSrc), []);
});

test('an exempt entry whose violation is gone is reported stale', () => {
  assert.deepStrictEqual(staleExemptions(EXEMPT, () => "'use strict';\n"), Object.keys(EXEMPT));
});

test('a domain module may not reach http or db, or touch res', () => {
  assert.deepStrictEqual(violations('domain/thing.js', "const r = require('../http/router');"), ['imports http/router']);
  assert.deepStrictEqual(violations('domain/thing.js', "const c = require('../db/cosmos-nosql');"), ['imports db/cosmos-nosql']);
  assert.deepStrictEqual(violations('domain/thing.js', 'function f(res) { res.json({}); }'), ['touches res']);
});

test('a domain module may import repositories and the shared helpers', () => {
  const source = [
    "require('../repositories/lists');", "require('../helpers/etag-write');",
    "require('./_schema');", "require('./_write');"
  ].join('\n');
  assert.deepStrictEqual(violations('domain/thing.js', source), []);
});

test('a repository may not import domain, controllers, audit or redact', () => {
  const source = [
    "require('../domain/_write');", "require('../controllers/native/write');",
    "require('../utils/audit');", "require('../vis/redact');"
  ].join('\n');
  assert.deepStrictEqual(violations('repositories/thing.js', source), [
    'imports domain/_write', 'imports controllers/native/write', 'imports utils/audit', 'imports vis/redact'
  ]);
});

test('a native controller that imports domain answers only through writeHandler', () => {
  const source = "const d = require('../../domain/thing');\nconst c = require('../../db/cosmos-nosql');\nres.status(200).json({});";
  assert.deepStrictEqual(violations('controllers/native/thing.js', source),
    ['imports db/cosmos-nosql', 'writes res.status or res.json']);
});

test('a native controller without a domain import keeps its own responses', () => {
  assert.deepStrictEqual(violations('controllers/native/thing.js', 'res.status(400).json({});'), []);
});

test('an import named only in a comment does not count', () => {
  assert.deepStrictEqual(violations('domain/thing.js', "// require('../db/cosmos-nosql')\n"), []);
});
