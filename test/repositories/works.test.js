'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const cosmos = require('../../src/db/cosmos-nosql');
const works = require('../../src/repositories/works');

const ROOT = path.join(__dirname, '..', '..');
const WORKS_MODULE = path.join(ROOT, 'src', 'repositories', 'works');

/** Works have no read[], so every file that loads them is a gate decision, named here. */
const MAY_REQUIRE = new Set([
  'src/controllers/nosql/project-compose.js',
  'src/domain/works-derive.js',
  'src/repositories/projects.js',
  'src/scripts/date-assessment-phases.js',
  'src/scripts/sync-works.js',
  'src/scripts/track-record-write.js'
].map(file => path.join(ROOT, ...file.split('/'))));

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

const requiresWorks = (file) => [...fs.readFileSync(file, 'utf8').matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)]
  .some(([, spec]) => path.resolve(path.dirname(file), spec).replace(/\.js$/, '') === WORKS_MODULE);

test('works.js is required only by the project read and the works writers', () => {
  const callers = [...sourceFiles(path.join(ROOT, 'src')), ...sourceFiles(path.join(ROOT, 'api'))]
    .filter(requiresWorks)
    .filter(file => !MAY_REQUIRE.has(file))
    .map(file => path.relative(ROOT, file));

  assert.deepStrictEqual(callers, []);
});

test('works repository', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('listByProject leaves out a tombstone unless asked for it', async () => {
    const rows = [
      { id: 'track-1', projectId: 'p1', phases: [] },
      { id: 'track-2', projectId: 'p1', deleted: true, pushStamps: { work: 5 } }
    ];
    t.mock.method(cosmos, 'query', async () => ({ items: rows, continuationToken: undefined }));

    const live = await works.listByProject('p1');
    const all = await works.listByProject('p1', { includeDeleted: true });

    assert.deepStrictEqual([live.map(w => w.id), all.map(w => w.id)], [['track-1'], ['track-1', 'track-2']]);
  });

  await t.test('a save on a stale etag is a 412 and leaves the stored work alone', async () => {
    const stored = { id: 'track-1', projectId: 'p1', simpleTitle: 'Newer', _etag: 'e2' };
    t.mock.method(cosmos, 'upsert', async (_container, item, { etag } = {}) => {
      // As Cosmos: no etag means no condition, and the upsert overwrites.
      if (etag && etag !== stored._etag) throw Object.assign(new Error('precondition failed'), { code: 412 });
      return Object.assign(stored, item, { _etag: 'e3' });
    });

    await assert.rejects(
      works.save({ id: 'track-1', projectId: 'p1', simpleTitle: 'Older' }, { etag: 'e1' }),
      { code: 412 }
    );
    assert.strictEqual(stored.simpleTitle, 'Newer');
  });
});
