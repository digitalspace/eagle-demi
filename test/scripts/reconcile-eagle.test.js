'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  DEFAULT_MAX_PURGE, parseArgs, diff, summaryLine, exitCodeFor, reconcile
} = require('../../src/scripts/reconcile-eagle');

const EAGLE_API_BASE = 'https://eagle-test.example/api/public';

/**
 * Eagle publishes projects P1/P2 and documents D1/D2.
 *
 * DEMI mirrors: P1 under a Track-sourced row (the shape that made a naive diff report every
 * matched project as missing), P2 Eagle-sourced, plus `gone` — Eagle-sourced with no Eagle
 * counterpart, the hard-delete this script exists to catch. `track-dangling` is a Track row whose
 * Eagle counterpart is gone: real drift, but never purgeable from here.
 */
const EAGLE_PROJECTS = [{ _id: 'P1' }, { _id: 'P2' }];
const EAGLE_DOCS = [{ _id: 'D1' }, { _id: 'D2' }];

const PROJECT_ROWS = [
  { id: '207', eagleId: 'P1', sourceSystem: 'track' },
  { id: 'eagle-P2', eagleId: 'P2', sourceSystem: 'eagle' },
  { id: 'eagle-gone', eagleId: 'gone', sourceSystem: 'eagle' },
  { id: '354', eagleId: 'track-dangling', sourceSystem: 'track' }
];
const DOCUMENT_ROWS = [
  { id: 'D1', projectId: '207' },
  { id: 'D2', projectId: 'eagle-P2' },
  { id: 'D-gone', projectId: '207' }
];

function stubSources(over = {}) {
  return {
    EAGLE_API_BASE,
    fetchEagleProjects: async () => EAGLE_PROJECTS,
    streamEagleDocuments: async (onPage) => {
      await onPage(EAGLE_DOCS);
      return { count: EAGLE_DOCS.length, total: EAGLE_DOCS.length };
    },
    ...over
  };
}

/**
 * Repository doubles. Both ASSERT the access tier: a scoped context lists only what it can see, so
 * every row it cannot read would report as Eagle-only drift and every unpublished row as a purge
 * candidate. Without this assertion, dropping systemAccess() left the suite green.
 *
 * `counts` overrides what a container reports it holds — the truncation guard's input.
 */
function makeDeps(over = {}, counts = {}) {
  const purged = { documents: [], projects: [] };
  const audited = [];
  const assertSystem = (access) => assert.strictEqual(access && access.tier, 'privileged',
    'the reconcile must read as systemAccess(), or it diffs against a partial view');
  return {
    purged,
    audited,
    deps: {
      sources: stubSources(),
      projects: {
        listWithEagleId: async (access) => { assertSystem(access); return PROJECT_ROWS; },
        countWithEagleId: async () => counts.projects ?? PROJECT_ROWS.length
      },
      documents: {
        listSeededIds: async (access) => { assertSystem(access); return DOCUMENT_ROWS; },
        countSeededIds: async () => counts.documents ?? DOCUMENT_ROWS.length
      },
      purge: {
        purgeDocument: async (row) => { purged.documents.push(`${row.projectId}|${row.id}`); },
        purgeProject: async (row) => { purged.projects.push(row.id); }
      },
      audit: { auditEvent: (_req, event) => audited.push(event) },
      searchReady: true,
      ...over
    }
  };
}

test('parseArgs', async (t) => {
  await t.test('defaults to a report with the standard ceiling', () => {
    assert.deepStrictEqual(parseArgs([]),
      { live: false, json: false, maxPurge: DEFAULT_MAX_PURGE });
  });

  await t.test('rejects a non-positive or non-integer --max-purge', () => {
    assert.throws(() => parseArgs(['--max-purge', '0']), /positive integer/);
    assert.throws(() => parseArgs(['--max-purge', '1.5']), /positive integer/);
    assert.throws(() => parseArgs(['--max-purge', 'lots']), /positive integer/);
  });

  await t.test('rejects an unknown argument rather than ignoring it', () => {
    assert.throws(() => parseArgs(['--force']), /unknown argument/);
  });
});

test('diff', async (t) => {
  await t.test('finds both directions', () => {
    const result = diff(
      [{ id: 'a' }, { id: 'b' }], row => row.id, new Set(['b', 'c']));
    assert.deepStrictEqual(result.demiOnly.map(r => r.id), ['a']);
    assert.deepStrictEqual(result.eagleOnly, ['c']);
  });

  await t.test('a row the diff may not purge stays out of demiOnly but still counts as present',
    () => {
      const rows = [{ id: 'keep', eagleId: 'x', sourceSystem: 'track' }];
      const result = diff(rows, row => row.eagleId, new Set(), row => row.sourceSystem === 'eagle');
      assert.deepStrictEqual(result.demiOnly, []);
      assert.deepStrictEqual(result.kept.map(r => r.id), ['keep']);
      // And its Eagle id is still membership: a matched Track row must not read as Eagle-only.
      assert.deepStrictEqual(diff(rows, row => row.eagleId, new Set(['x']),
        row => row.sourceSystem === 'eagle').eagleOnly, []);
    });
});

test('reconcile', async (t) => {
  await t.test('reports drift both ways and purges nothing without --live', async () => {
    const { purged, deps } = makeDeps();
    const summary = await reconcile([], deps);

    assert.strictEqual(summary.mode, 'report');
    assert.deepStrictEqual(summary.projects.demiOnly.map(r => r.id), ['eagle-gone']);
    assert.deepStrictEqual(summary.documents.demiOnly.map(r => r.id), ['D-gone']);
    // P1 is mirrored on a Track-sourced row; reading only the Eagle-sourced rows reported it here.
    assert.deepStrictEqual(summary.projects.eagleOnly, []);
    assert.deepStrictEqual(summary.documents.eagleOnly, []);
    // The Track row whose Eagle counterpart is gone: reported, never purgeable.
    assert.strictEqual(summary.projects.trackOnly, 1);
    assert.strictEqual(summary.drift, 2);
    assert.deepStrictEqual(purged, { documents: [], projects: [] });
    assert.strictEqual(exitCodeFor(summary), 0);
  });

  await t.test('an id Eagle publishes and DEMI never mirrored is reported, never purged', async () => {
    const { purged, deps } = makeDeps({
      sources: stubSources({ fetchEagleProjects: async () => [...EAGLE_PROJECTS, { _id: 'P3' }] })
    });
    const summary = await reconcile(['--live'], deps);

    assert.deepStrictEqual(summary.projects.eagleOnly, ['P3']);
    assert.deepStrictEqual(purged.projects, ['eagle-gone']);
    assert.strictEqual(summary.drift, 3);
  });

  await t.test('--live purges only the DEMI-only rows, documents before projects', async () => {
    const { purged, audited, deps } = makeDeps();
    const summary = await reconcile(['--live'], deps);

    assert.deepStrictEqual(purged.documents, ['207|D-gone']);
    assert.deepStrictEqual(purged.projects, ['eagle-gone']);
    assert.strictEqual(summary.documents.purged, 1);
    assert.strictEqual(summary.projects.purged, 1);
    assert.deepStrictEqual(summary.failures, []);
    assert.deepStrictEqual(audited.map(e => `${e.action} ${e.targetId}`),
      ['document.delete D-gone', 'project.delete eagle-gone']);
  });

  await t.test('--live refuses above the ceiling, and removes nothing from either container',
    async () => {
      const { purged, deps } = makeDeps();
      const summary = await reconcile(['--live', '--max-purge', '1'], deps);
      assert.deepStrictEqual(summary.failures, [], 'one row per container is AT the ceiling');
      assert.deepStrictEqual(purged, { documents: ['207|D-gone'], projects: ['eagle-gone'] });

      const second = makeDeps();
      const refused = await reconcile(['--live', '--max-purge', '1'], {
        ...second.deps,
        // Two projects gone: over a ceiling of 1, so the single document must not be purged either.
        projects: {
          listWithEagleId: async () => [...PROJECT_ROWS,
            { id: 'eagle-gone2', eagleId: 'gone2', sourceSystem: 'eagle' }],
          countWithEagleId: async () => PROJECT_ROWS.length + 1
        }
      });
      assert.match(refused.failures[0], /projects 2 exceeds --max-purge 1/);
      assert.deepStrictEqual(second.purged, { documents: [], projects: [] });
      assert.strictEqual(refused.documents.purged, 0);
      assert.strictEqual(exitCodeFor(refused), 1);
    });

  await t.test('--live refuses when the search index cannot be cleaned up', async () => {
    const { purged, deps } = makeDeps({ searchReady: false });
    const summary = await reconcile(['--live'], deps);
    assert.match(summary.failures[0], /SEARCH_ENDPOINT/);
    assert.deepStrictEqual(purged, { documents: [], projects: [] });
  });

  await t.test('a truncated enumeration is reported, and a report still exits 0', async () => {
    const { deps } = makeDeps({}, { documents: DOCUMENT_ROWS.length + 500 });
    const summary = await reconcile([], deps);
    assert.match(summary.failures[0], /documents enumerated 3 rows but the container holds 503/);
    assert.strictEqual(exitCodeFor(summary), 0);
  });

  await t.test('a purge that throws is counted as a failure, not as success', async () => {
    const { deps } = makeDeps({
      purge: {
        purgeDocument: async () => { throw new Error('409 conflict'); },
        purgeProject: async () => {}
      }
    });
    const summary = await reconcile(['--live'], deps);
    assert.strictEqual(summary.documents.purged, 0);
    assert.match(summary.failures[0], /document D-gone purge failed: 409 conflict/);
    assert.strictEqual(exitCodeFor(summary), 1);
  });
});

test('summaryLine is the alert contract', async (t) => {
  await t.test('carries every count and a drift total', async () => {
    const { deps } = makeDeps();
    const summary = await reconcile([], deps);
    assert.strictEqual(summaryLine(summary),
      '[reconcile] projects: demiOnly=1 eagleOnly=0 documents: demiOnly=1 eagleOnly=0 drift=2');
  });

  await t.test('a clean run says drift=0', () => {
    assert.strictEqual(
      summaryLine({ projects: { demiOnly: [], eagleOnly: [] },
        documents: { demiOnly: [], eagleOnly: [] }, drift: 0 }),
      '[reconcile] projects: demiOnly=0 eagleOnly=0 documents: demiOnly=0 eagleOnly=0 drift=0');
  });
});
