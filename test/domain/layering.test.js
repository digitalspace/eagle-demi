'use strict';

// The import direction in docs/eagle-api-port.md "Layering", checked by a text scan of src/.
// routes.js -> controllers/native -> domain -> repositories -> db. The nosql project and document controllers import no db/.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { code } = require('../helpers/router-source');

const SRC = path.join(__dirname, '..', '..', 'src');

/** Layer violations that predate the rules. Each lists the violations it excuses. */
const EXEMPT = Object.freeze({
  'repositories/links.js': {
    violations: ['imports vis/redact'],
    reason: 'a short-code lookup answers only the codes this caller may see, so the project field dials apply inside it'
  },
  'repositories/_sql.js': {
    violations: ['imports vis/redact'],
    reason: 'a filter or sort on a field the caller cannot see is refused where the SQL is built, or row matches would leak its value'
  },
  'repositories/credentials.js': {
    violations: ['imports utils/audit'],
    reason: 'a project delete narrows and revokes credentials with no request in hand, and each changed row is audited there'
  },
  'scripts/seed-public-reads.js': {
    violations: [
      'imports controllers/nosql/organization', 'imports controllers/nosql/notification', 'imports controllers/nosql/update',
      'imports controllers/nosql/comment-period', 'imports controllers/nosql/comment'
    ],
    reason: 'Eagle mirror lines, deleted by R3'
  },
  'scripts/parity-map.js': {
    violations: ['imports controllers/nosql/comment', 'imports controllers/nosql/comment-period', 'imports controllers/nosql/organization'],
    reason: 'Eagle mirror lines, deleted by R3'
  }
});

const WRITE_CONTROLLERS = Object.freeze(['controllers/nosql/project.js', 'controllers/nosql/document.js']);

/** Write rules moved from WRITE_CONTROLLERS to domain/. One defined there again sits beside `res` once more. */
const MOVED_RULES = Object.freeze([
  'runCascade', 'cascadeProjectVisibility', 'cascadeOnce', 'markCascadePending', 'clearCascadePending',
  'visibilityMoved', 'mergeEaglePush', 'keepNativeIdentity', 'resolveDocumentAcl', 'propagateParentFields',
  'patchParentFieldsInline', 'reStampParentFieldDrift', 'stampParentFieldsPending', 'recordIngested',
  'removeOverCapChunks', 'tryRecordIngestFailure'
]);

/** The MOVED_RULES `source` defines, as a function declaration or a function bound to a name. */
function movedRulesIn(source) {
  const text = code(source);
  return MOVED_RULES.filter(name => new RegExp(
    `\\bfunction\\s+${name}\\b|\\b(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\b|\\(|function\\b|[\\w$]+\\s*=>)`).test(text));
}

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
  if (WRITE_CONTROLLERS.includes(file)) ban('db');
  if (file.startsWith('repositories/')) ban('domain', 'controllers', 'utils/audit', 'vis/redact');
  // Only the route table and controllers wire a controller. A repository's ban above already names it.
  else if (!file.startsWith('controllers/') && !file.startsWith('http/')) ban('controllers');
  return found;
}

/** Exempt entries whose file does not break every rule they excuse. */
function staleExemptions(exempt, sourceOf) {
  return Object.entries(exempt)
    .filter(([file, entry]) => {
      const found = violations(file, sourceOf(file));
      return entry.violations.some(violation => !found.includes(violation));
    })
    .map(([file]) => file);
}

const readSrc = (file) => (fs.existsSync(path.join(SRC, file)) ? fs.readFileSync(path.join(SRC, file), 'utf8') : '');

/** Every .js file under src/ (or `dir` in it), as a posix path. A local `node_modules` install is skipped. */
function layerFiles(dir = '') {
  return fs.readdirSync(path.join(SRC, dir), { withFileTypes: true }).flatMap(entry => {
    const file = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : layerFiles(file);
    return entry.name.endsWith('.js') ? [file] : [];
  });
}

test('every file in a layer keeps to the import direction', () => {
  const files = layerFiles();
  assert.ok(files.some(f => f.startsWith('domain/')) && files.some(f => f.startsWith('repositories/')),
    'the scan must find files in each layer, or it passes by reading nothing');

  const broken = files.flatMap(file => violations(file, readSrc(file))
    .filter(found => !(EXEMPT[file] && EXEMPT[file].violations.includes(found)))
    .map(found => `${file} ${found}`));
  assert.deepStrictEqual(broken, []);
});

test('moved write rules stay in the domain', () => {
  const defined = WRITE_CONTROLLERS.flatMap(file =>
    movedRulesIn(fs.readFileSync(path.join(SRC, file), 'utf8')).map(name => `${file} defines ${name}`));
  assert.deepStrictEqual(defined, []);
});

test('every exempt entry still excuses a real violation', () => {
  assert.deepStrictEqual(staleExemptions(EXEMPT, readSrc), []);
});

test('an exempt entry whose violation is gone is reported stale', () => {
  assert.deepStrictEqual(staleExemptions(EXEMPT, () => "'use strict';\n"), Object.keys(EXEMPT));
});

test('an exempt entry with one of its listed violations gone is reported stale', () => {
  const exempt = { 'scripts/thing.js': { violations: ['imports controllers/nosql/update', 'imports controllers/nosql/user'] } };
  assert.deepStrictEqual(staleExemptions(exempt, () => "require('../controllers/nosql/update');"), ['scripts/thing.js']);
});

test('the scan reads every file under src/, scripts included', () => {
  assert.ok(layerFiles().includes('scripts/announce-updates.js'));
});

test('a file outside controllers/ and http/ may not import a controller', () => {
  assert.deepStrictEqual(violations('scripts/thing.js', "require('../controllers/nosql/update');"),
    ['imports controllers/nosql/update']);
});

test('the route table and controllers may import a controller', () => {
  assert.deepStrictEqual(violations('http/routes.js', "require('../controllers/nosql/update');"), []);
  assert.deepStrictEqual(violations('controllers/native/thing.js', "require('../nosql/update');"), []);
});

test('a repository importing a controller is reported once', () => {
  assert.deepStrictEqual(violations('repositories/thing.js', "require('../controllers/nosql/update');"),
    ['imports controllers/nosql/update']);
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

test('a nosql write controller may not reach db, but keeps its own responses', () => {
  const source = "require('../../domain/project-cascade');\nrequire('../../db/cosmos-nosql');\nres.status(200).json({});";
  assert.deepStrictEqual(violations('controllers/nosql/project.js', source), ['imports db/cosmos-nosql']);
});

test('a moved write rule defined in a controller is reported, an imported one is not', () => {
  const source = [
    'function runCascade() {}', 'const recordIngested = async () => {};',
    'const visibilityMoved = id => id;', 'let markCascadePending = async id => id;',
    'const cascadeOnce = make();', "const { mergeEaglePush } = require('../../domain/project-push');"
  ].join('\n');
  assert.deepStrictEqual(movedRulesIn(source),
    ['runCascade', 'markCascadePending', 'visibilityMoved', 'recordIngested']);
});

test('a native controller without a domain import keeps its own responses', () => {
  assert.deepStrictEqual(violations('controllers/native/thing.js', 'res.status(400).json({});'), []);
});

test('an import named only in a comment does not count', () => {
  assert.deepStrictEqual(violations('domain/thing.js', "// require('../db/cosmos-nosql')\n"), []);
});
