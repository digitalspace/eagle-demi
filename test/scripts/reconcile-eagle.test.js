'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  parseArgs, diff, summaryLine, reconcile, report
} = require('../../src/scripts/reconcile-eagle');

const EAGLE_API_BASE = 'https://eagle-test.example/api/public';

/**
 * Eagle publishes projects P1/P2 and documents D1/D2/D3.
 *
 * DEMI mirrors: P1 under a Track-sourced row (the shape that made a naive diff report every
 * matched project as missing), P2 Eagle-sourced, plus `gone` — Eagle-sourced and absent from
 * Eagle's public search. `track-dangling` is the same absence on a Track row.
 *
 * D3 is the document-side counterpart of `gone`: Eagle publishes it, DEMI never mirrored it, and
 * its own project ('gone') is not in EAGLE_PROJECTS — seed-nosql would drop it as unresolvable, so
 * the reconcile must report it as `unresolvedParent`, not `eagleOnly`.
 */
const EAGLE_PROJECTS = [{ _id: 'P1' }, { _id: 'P2' }];
const EAGLE_DOCS = [{ _id: 'D1', project: 'P1' }, { _id: 'D2', project: 'P2' },
  { _id: 'D3', project: 'gone' }];

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
 * every row it cannot read would report as Eagle-only drift and every unpublished row as gone from
 * Eagle. Without this assertion, dropping systemAccess() left the suite green.
 *
 * `counts` overrides what a container reports it holds — the truncation guard's input.
 */
function makeDeps(over = {}, counts = {}) {
  const assertSystem = (access) => assert.strictEqual(access && access.tier, 'privileged',
    'the reconcile must read as systemAccess(), or it diffs against a partial view');
  return {
    sources: stubSources(),
    projects: {
      listWithEagleId: async (access) => { assertSystem(access); return PROJECT_ROWS; },
      countWithEagleId: async () => counts.projects ?? PROJECT_ROWS.length
    },
    documents: {
      listSeededIds: async (access) => { assertSystem(access); return DOCUMENT_ROWS; },
      countSeededIds: async () => counts.documents ?? DOCUMENT_ROWS.length
    },
    ...over
  };
}

test('parseArgs', async (t) => {
  await t.test('takes only --json', () => {
    assert.deepStrictEqual(parseArgs([]), { json: false });
    assert.deepStrictEqual(parseArgs(['--json']), { json: true });
  });

  await t.test('rejects an unknown argument rather than ignoring it', () => {
    assert.throws(() => parseArgs(['--force']), /unknown argument/);
    // The flags a reader may expect from seed-nosql. Nothing here writes, so accepting either
    // silently would promise a purge that does not happen.
    assert.throws(() => parseArgs(['--live']), /unknown argument/);
    assert.throws(() => parseArgs(['--max-purge', '10']), /unknown argument/);
  });
});

test('diff', async (t) => {
  await t.test('finds both directions', () => {
    const result = diff([{ id: 'a' }, { id: 'b' }], row => row.id, new Set(['b', 'c']));
    assert.deepStrictEqual(result.unpublishedOrDeleted.map(r => r.id), ['a']);
    assert.deepStrictEqual(result.eagleOnly, ['c']);
  });

  await t.test('a row the push does not own is split out but still counts as present', () => {
    const rows = [{ id: 'keep', eagleId: 'x', sourceSystem: 'track' }];
    const owned = row => row.sourceSystem === 'eagle';
    const result = diff(rows, row => row.eagleId, new Set(), owned);
    assert.deepStrictEqual(result.unpublishedOrDeleted, []);
    assert.deepStrictEqual(result.trackOnly.map(r => r.id), ['keep']);
    // And its Eagle id is still membership: a matched Track row must not read as Eagle-only.
    assert.deepStrictEqual(diff(rows, row => row.eagleId, new Set(['x']), owned).eagleOnly, []);
  });

  await t.test('an id whose parent is unpublished is unresolvedParent, not eagleOnly', () => {
    const parentPublished = id => id !== 'unresolved';
    const result = diff([], row => row.id, new Set(['ok', 'unresolved']), undefined, parentPublished);
    assert.deepStrictEqual(result.eagleOnly, ['ok']);
    assert.deepStrictEqual(result.unresolvedParent, ['unresolved']);
  });
});

test('reconcile', async (t) => {
  await t.test('reports drift both ways', async () => {
    const summary = await reconcile([], makeDeps());

    assert.deepStrictEqual(summary.projects.unpublishedOrDeleted.map(r => r.id), ['eagle-gone']);
    assert.deepStrictEqual(summary.documents.unpublishedOrDeleted.map(r => r.id), ['D-gone']);
    // P1 is mirrored on a Track-sourced row; reading only the Eagle-sourced rows reported it here.
    assert.deepStrictEqual(summary.projects.eagleOnly, []);
    assert.deepStrictEqual(summary.documents.eagleOnly, []);
    // The Track row gone from Eagle: reported apart, and not the push's drift.
    assert.deepStrictEqual(summary.projects.trackOnly.map(r => r.id), ['354']);
    // D3's project ('gone') is unpublished — excluded from eagleOnly, reported apart, not drift.
    assert.deepStrictEqual(summary.documents.unresolvedParent, ['D3']);
    assert.strictEqual(summary.drift, 2);
    assert.deepStrictEqual(summary.failures, []);
  });

  await t.test('a document whose project is unpublished is not counted as eagleOnly', async () => {
    const summary = await reconcile([], makeDeps());
    assert.deepStrictEqual(summary.documents.eagleOnly, []);
    assert.deepStrictEqual(summary.documents.unresolvedParent, ['D3']);
    // Reported separately, not added into drift — the gate this whole change exists for.
    assert.strictEqual(summary.drift, 2);
  });

  await t.test('an id Eagle publishes and DEMI never mirrored is reported', async () => {
    const summary = await reconcile([], makeDeps({
      sources: stubSources({ fetchEagleProjects: async () => [...EAGLE_PROJECTS, { _id: 'P3' }] })
    }));
    assert.deepStrictEqual(summary.projects.eagleOnly, ['P3']);
    assert.strictEqual(summary.drift, 3);
  });

  await t.test('a truncated enumeration is reported', async () => {
    const summary = await reconcile([], makeDeps({}, { documents: DOCUMENT_ROWS.length + 500 }));
    assert.match(summary.failures[0],
      /documents enumerated 3 rows but the container holds 503 — .*truncated read/);
  });

  await t.test('nothing it reports is a delete list', async () => {
    // eagle-api answers `200 []` both for a deleted row and for one that merely lost `public`
    // from its read[], so `unpublishedOrDeleted` cannot be purged. Verified 2026-08-26 against
    // prod: `/api/public/document/000000000000000000000000` -> `200 []`, a published id -> the
    // row. If a purge ever lands it needs a probe that separates the two, not this set.
    const summary = await reconcile([], makeDeps());
    const rendered = report(summary, { json: true });
    assert.match(rendered, /NOT purged/);
    assert.doesNotMatch(rendered, /purged: \d/);
    // The script exports no purge path at all, so no caller can reach one by mistake.
    const mod = require('../../src/scripts/reconcile-eagle');
    assert.deepStrictEqual(Object.keys(mod).filter(k => /purge|live/i.test(k)), []);
  });
});

test('summaryLine is the alert contract', async (t) => {
  await t.test('carries every count and a drift total', async () => {
    const summary = await reconcile([], makeDeps());
    assert.strictEqual(summaryLine(summary),
      '[reconcile] projects: unpublishedOrDeleted=1 eagleOnly=0 ' +
      'documents: unpublishedOrDeleted=1 eagleOnly=0 unresolvedParent=1 drift=2');
  });

  await t.test('a clean run says drift=0', () => {
    assert.strictEqual(
      summaryLine({ projects: { unpublishedOrDeleted: [], eagleOnly: [] },
        documents: { unpublishedOrDeleted: [], eagleOnly: [], unresolvedParent: [] }, drift: 0 }),
      '[reconcile] projects: unpublishedOrDeleted=0 eagleOnly=0 ' +
      'documents: unpublishedOrDeleted=0 eagleOnly=0 unresolvedParent=0 drift=0');
  });
});
