'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { COUNTED, main } = require('../../src/scripts/count-containers');

const PACIFIC_LINK = 'eagle-6abf251529e23409d1307085';

/**
 * Cosmos double answering by container and query parameters, the way the real one would.
 * `failing` names containers whose COUNT throws.
 */
function fakeCosmos({ projects = [], docsByProject = {}, failing = [] } = {}) {
  const param = spec => (spec.parameters[0] || {}).value;
  return {
    async queryValue(container, spec, options = {}) {
      if (failing.includes(container)) throw new Error(`Request rate is large on ${container}`);
      if (container === 'documents' && param(spec) !== undefined) {
        assert.strictEqual(options.partitionKey, param(spec), 'document count stays in one partition');
        return docsByProject[param(spec)] || 0;
      }
      return COUNTED.indexOf(container) + 10;
    },
    async query(container, spec) {
      assert.strictEqual(container, 'projects');
      const id = param(spec);
      if (id === undefined) return { items: [{ sourceSystem: 'track', n: 381 }, { sourceSystem: 'eagle', n: 1 }] };
      return { items: projects.filter(p => p.id === id || p.eagleId === id) };
    },
    async indexProgress() {
      return 100;
    }
  };
}

async function run(argv, deps) {
  const lines = [];
  const code = await main(argv, { write: line => lines.push(line), ...deps });
  return { code, lines };
}

test('prints one JSON line with every container count', async () => {
  const { code, lines } = await run([], { cosmos: fakeCosmos() });

  assert.strictEqual(code, 0);
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /^\{[^\n]*\}\n$/);
  assert.ok(lines[0].length < 4096, `line is ${lines[0].length} bytes`);
  const out = JSON.parse(lines[0]);
  assert.deepStrictEqual(Object.keys(out.counts), [
    'projects', 'documents', 'chunks', 'updates', 'commentPeriods', 'comments',
    'notifications', 'lists', 'boundaries', 'projectSummaries', 'links'
  ]);
  assert.strictEqual(out.counts.chunks, 12);
  assert.deepStrictEqual(out.projectsBySourceSystem, { track: 381, eagle: 1 });
  assert.deepStrictEqual(out.indexProgress, { chunks: 100, documents: 100, projects: 100 });
  assert.strictEqual(out.errors, undefined);
});

test('reports a keep id with no project row as missing', async () => {
  const keepFile = `# projects the re-seed must spare\n${PACIFIC_LINK}  # Pacific Link\n\nnot-a-project\n`;
  const cosmos = fakeCosmos({
    projects: [{ id: PACIFIC_LINK, eagleId: '6abf251529e23409d1307085', sourceSystem: 'eagle',
      trackProjectId: null, tags: ['pilot'] }],
    docsByProject: { [PACIFIC_LINK]: 42 }
  });

  const { code, lines } = await run(['--keep-ids', 'keep.txt'],
    { cosmos, readFile: () => keepFile });

  assert.strictEqual(code, 0);
  const [found, missing] = JSON.parse(lines[0]).keep;
  assert.strictEqual(found.rowId, PACIFIC_LINK);
  assert.strictEqual(found.documents, 42);
  assert.deepStrictEqual(found.tags, ['pilot']);
  assert.strictEqual(found.missing, undefined);
  assert.strictEqual(missing.id, 'not-a-project');
  assert.strictEqual(missing.missing, true);
  assert.strictEqual(missing.rowId, null);
});

test('exits 1 when a count fails', async () => {
  const { code, lines } = await run([], { cosmos: fakeCosmos({ failing: ['chunks'] }) });

  assert.strictEqual(code, 1);
  const out = JSON.parse(lines[0]);
  assert.strictEqual(out.counts.chunks, null);
  assert.strictEqual(out.counts.documents, 11);
  assert.match(out.errors['counts.chunks'], /Request rate is large/);
});
