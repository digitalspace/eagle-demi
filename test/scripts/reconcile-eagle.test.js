'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  parseArgs, diff, summaryLine, reconcile, report, run
} = require('../../src/scripts/reconcile-eagle');
const { logger } = require('../../src/utils/logger');
const { documentAdmission } = require('../../src/scripts/seed-nosql');
const { buildRegistry, buildProjectIndex } = require('../../src/merge/project');
const { MAX_PAGE_SIZE } = require('../../src/helpers/access-sql');

const EAGLE_API_BASE = 'https://eagle-test.example/api/public';

/**
 * Eagle publishes projects P1/P2, one ProjectNotification N1, and documents D1-D4.
 *
 * DEMI mirrors: P1 under a Track-sourced row (the shape that made a naive diff report every
 * matched project as missing), P2 Eagle-sourced, plus `gone` — Eagle-sourced and absent from
 * Eagle's public search. `track-dangling` is the same absence on a Track row.
 *
 * D3 is the document-side counterpart of `gone`: Eagle publishes it, DEMI never mirrored it, and
 * its own project ('gone') is not in EAGLE_PROJECTS — seed-nosql would drop it as unresolvable, so
 * the reconcile must report it as `unresolvedParent`, not `eagleOnly`.
 *
 * D4 hangs off N1, a ProjectNotification rather than a project — seed-nosql admits these (~80 in
 * prod, see seed-nosql.js). Eagle publishes it, DEMI never mirrored it: real push drift, so it
 * must be `eagleOnly`, not `unresolvedParent`.
 *
 * D5 is the plainest miss the flip gate exists to catch: published project P2, published document,
 * never mirrored. D6 is the class the old hand-copied rule got wrong — its parent is the Track row
 * 354, whose epic_guid no longer resolves to a published Eagle project, but the registry still
 * indexes that guid, so seed-nosql seeds the document and this is drift too.
 */
const EAGLE_PROJECTS = [{ _id: 'P1' }, { _id: 'P2' }];
const NOTIFICATIONS = [{ _id: 'N1' }];

/**
 * The public-read containers, in step on purpose: the fixtures above carry the project and document
 * drift this suite has always asserted, so the four newer containers are clean here and their own
 * drift is driven by the subtest that overrides them.
 */
const EAGLE_BY_DATASET = {
  ProjectNotification: NOTIFICATIONS,
  // The period's own `project` ref rides along, because `dataset=CommentPeriod` gates on the
  // period's `read[]` alone and joins no parent — it is the only thing that says whether the
  // mirror could have resolved a parent for it. CP1 hangs off published P1, so it is clean here.
  CommentPeriod: [{ _id: 'CP1', project: 'P1' }],
  List: [{ _id: 'L1' }],
  Organization: [{ _id: 'O1' }],
  RecentActivity: [{ _id: 'U1' }]
};
const PERIOD_ROWS = { 207: [{ id: 'CP1', projectId: '207' }] };
const LIST_ROWS = { List: [{ id: 'L1', kind: 'List' }], Organization: [{ id: 'O1', kind: 'Organization' }] };
const NOTIFICATION_ROWS = [{ id: 'N1' }];
const UPDATE_ROWS = [{ id: 'U1' }];
const TRACK_PROJECTS = [
  { track_project_id: 207, name: 'P1', epic_guid: 'P1' },
  { track_project_id: 354, name: 'Dangling', epic_guid: 'track-dangling' }
];
const EAGLE_DOCS = [{ _id: 'D1', project: 'P1' }, { _id: 'D2', project: 'P2' },
  { _id: 'D3', project: 'gone' }, { _id: 'D4', project: 'N1' },
  { _id: 'D5', project: 'P2' }, { _id: 'D6', project: 'track-dangling' }];

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

/**
 * @param {object} over      individual source functions to replace
 * @param {object} datasets  the `/search` id sets, when a case needs a different one
 */
function stubSources(over = {}, datasets = EAGLE_BY_DATASET) {
  return {
    EAGLE_API_BASE,
    loadTrackProjects: () => TRACK_PROJECTS,
    fetchEagleProjects: async () => EAGLE_PROJECTS,
    // Same generic pager seed-nosql calls — the dataset name is asserted so a divergent one fails
    // here rather than silently reading the wrong collection.
    fetchAllPages: async (base, dataset) => {
      assert.strictEqual(base, EAGLE_API_BASE);
      assert.ok(datasets[dataset], `unexpected dataset: ${dataset}`);
      return datasets[dataset];
    },
    PAGE_SIZE: 100,
    // The comment sweep reads its total from the header, not the body — eagle-api's
    // `/api/public/comment` reports it nowhere else. Empty here, so DEMI's one mirrored comment
    // is drift the sweep must find.
    fetchJsonWithHeaders: async () => ({
      body: [], headers: new Headers({ 'x-total-count': '0' })
    }),
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
const assertSystem = (access) => assert.strictEqual(access && access.tier, 'privileged',
  'the reconcile must read as systemAccess(), or it diffs against a partial view');

/** `n` rows in one partition, enough of them to reach a page ceiling. */
const idRows = (prefix, n) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }));

function makeDeps(over = {}, counts = {}) {
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
    commentPeriods: {
      listByProject: async (projectId, access) => {
        assertSystem(access);
        return PERIOD_ROWS[projectId] || [];
      }
    },
    lists: {
      KINDS: { LIST: 'List', ORGANIZATION: 'Organization' },
      listByKind: async (kind, access) => { assertSystem(access); return LIST_ROWS[kind]; },
      countByKind: async (kind) => counts[kind] ?? LIST_ROWS[kind].length
    },
    notifications: {
      list: async (access) => { assertSystem(access); return NOTIFICATION_ROWS; },
      count: async () => counts.notifications ?? NOTIFICATION_ROWS.length
    },
    updates: {
      list: async (access) => { assertSystem(access); return UPDATE_ROWS; },
      count: async () => counts.updates ?? UPDATE_ROWS.length
    },
    comments: {
      listByPeriod: async (periodId, access) => { assertSystem(access); return [{ id: 'C1' }]; }
    },
    ...over
  };
}

/**
 * The `updates` container out of step in BOTH directions: Eagle publishes U1 and U2, DEMI holds U1
 * and `U-gone`. Same shape as the notifications fixture — the two containers are compared the same
 * way, and `updates` was the one the nightly sweep never covered.
 */
function updatesDrift() {
  return {
    sources: stubSources({}, { ...EAGLE_BY_DATASET, RecentActivity: [{ _id: 'U1' }, { _id: 'U2' }] }),
    updates: {
      list: async (access) => { assertSystem(access); return [{ id: 'U1' }, { id: 'U-gone' }]; },
      count: async () => 2
    }
  };
}

test('parseArgs', async (t) => {
  await t.test('takes --json and --comments', () => {
    assert.deepStrictEqual(parseArgs([]), { json: false, comments: false });
    assert.deepStrictEqual(parseArgs(['--json']), { json: true, comments: false });
    assert.deepStrictEqual(parseArgs(['--comments']), { json: false, comments: true });
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
    // D4 hangs off notification N1, D5 off published P2, D6 off a Track row's dangling
    // epic_guid — seed-nosql seeds all three, so all three are real push drift.
    assert.deepStrictEqual(summary.documents.eagleOnly, ['D4', 'D5', 'D6']);
    // The Track row gone from Eagle: reported apart, and not the push's drift.
    assert.deepStrictEqual(summary.projects.trackOnly.map(r => r.id), ['354']);
    // D3's project ('gone') is unpublished — excluded from eagleOnly, reported apart, not drift.
    assert.deepStrictEqual(summary.documents.unresolvedParent, ['D3']);
    assert.strictEqual(summary.drift, 5);
    assert.deepStrictEqual(summary.failures, []);
  });

  await t.test('an id Eagle publishes and DEMI never mirrored is reported', async () => {
    const summary = await reconcile([], makeDeps({
      sources: stubSources({ fetchEagleProjects: async () => [...EAGLE_PROJECTS, { _id: 'P3' }] })
    }));
    assert.deepStrictEqual(summary.projects.eagleOnly, ['P3']);
    assert.strictEqual(summary.drift, 6);
  });

  // eagle-api's `dataset=CommentPeriod` gates on the period's OWN read[] and joins no parent, so a
  // period Eagle publishes under a project it does not publish is still in the id set — while the
  // mirror drops it, because there is no parent project row in DEMI to hang it off. Measured on
  // test 2026-09-07: 29 such periods under 20 unpublished projects, all reported as push drift.
  await t.test('a period whose project is unpublished is unresolvedParent, not push drift',
    async () => {
      const summary = await reconcile([], makeDeps({
        sources: stubSources({}, {
          ...EAGLE_BY_DATASET,
          // 'gone' is an Eagle project DEMI mirrored but Eagle no longer publishes, so it is not in
          // the published set — exactly the parent the mirror could not resolve.
          CommentPeriod: [{ _id: 'CP1', project: 'P1' }, { _id: 'CP-orphan', project: 'gone' }]
        })
      }));

      assert.deepStrictEqual(summary.commentPeriods.unresolvedParent, ['CP-orphan']);
      assert.deepStrictEqual(summary.commentPeriods.eagleOnly, []);
      assert.strictEqual(summary.drift, 5,
        'the project and document drift only — an unresolvable parent is not the push\'s fault');
    });

  // The other half of the gate. Without this, a gate that answered "unresolved" to everything
  // would silence the container completely and still pass the case above.
  await t.test('a period whose project IS published and DEMI never mirrored is still drift',
    async () => {
      const summary = await reconcile([], makeDeps({
        sources: stubSources({}, {
          ...EAGLE_BY_DATASET,
          CommentPeriod: [{ _id: 'CP1', project: 'P1' }, { _id: 'CP-missed', project: 'P2' }]
        })
      }));

      assert.deepStrictEqual(summary.commentPeriods.eagleOnly, ['CP-missed']);
      assert.deepStrictEqual(summary.commentPeriods.unresolvedParent, []);
      assert.strictEqual(summary.drift, 6);
    });

  // The gate is the seed REGISTRY, not the published-Eagle set, and the two disagree on exactly
  // this row — the same distinction D6 pins on the document side. Track row 354's epic_guid no
  // longer resolves to a published Eagle project, but the registry still indexes it, so DEMI holds
  // a project row the mirror would have found. Gating on `eagleProjectIds` alone would file this
  // under `unresolvedParent` and lose it from the alert.
  await t.test('a period under a Track row\'s dangling epic_guid is drift, not unresolvable',
    async () => {
      const summary = await reconcile([], makeDeps({
        sources: stubSources({}, {
          ...EAGLE_BY_DATASET,
          CommentPeriod: [{ _id: 'CP1', project: 'P1' },
            { _id: 'CP-dangling', project: 'track-dangling' }]
        })
      }));

      assert.deepStrictEqual(summary.commentPeriods.eagleOnly, ['CP-dangling']);
      assert.deepStrictEqual(summary.commentPeriods.unresolvedParent, []);
      assert.strictEqual(summary.drift, 6);
    });

  // Eagle hangs periods off a ProjectNotification too, exactly as it does documents (D4 above).
  // The old gate tested `projectIndex` alone, so every one of those read as unresolvable and its
  // absence from DEMI never reached the alert.
  await t.test('a period under a ProjectNotification DEMI never mirrored is drift', async () => {
    const summary = await reconcile([], makeDeps({
      sources: stubSources({}, {
        ...EAGLE_BY_DATASET,
        CommentPeriod: [{ _id: 'CP1', project: 'P1' }, { _id: 'CP-pn', project: 'N1' }]
      })
    }));

    assert.deepStrictEqual(summary.commentPeriods.eagleOnly, ['CP-pn']);
    assert.deepStrictEqual(summary.commentPeriods.unresolvedParent, []);
    assert.strictEqual(summary.drift, 6);
  });

  // And the DEMI side of the same row. `commentPeriods` partitions on the parent, so a period
  // under a notification lives in the notification's partition and a sweep of the project
  // partitions alone never sees it — it would report as missing on every run.
  await t.test('a period DEMI holds under a ProjectNotification partition is clean', async () => {
    const summary = await reconcile([], makeDeps({
      sources: stubSources({}, {
        ...EAGLE_BY_DATASET,
        CommentPeriod: [{ _id: 'CP1', project: 'P1' }, { _id: 'CP-pn', project: 'N1' }]
      }),
      commentPeriods: {
        listByProject: async (projectId, access) => {
          assertSystem(access);
          return ({ ...PERIOD_ROWS, N1: [{ id: 'CP-pn', projectId: 'N1' }] })[projectId] || [];
        }
      }
    }));

    assert.strictEqual(summary.commentPeriods.inDemi, 2);
    assert.deepStrictEqual(summary.commentPeriods.eagleOnly, []);
    assert.deepStrictEqual(summary.commentPeriods.unresolvedParent, []);
    assert.deepStrictEqual(summary.commentPeriods.unpublishedOrDeleted, []);
    assert.strictEqual(summary.drift, 5);
  });

  // The class the sweep could not see: Track 353's epic_guid is the ProjectNotification's own _id,
  // so the registry resolves that ref to project '353' and the old rule stored the period there,
  // under the Track project's ACL. Both containers hold it, so every id-set diff read it as clean.
  await t.test('a period stored under a Track project that shadows its notification is misfiled',
    async () => {
      const summary = await reconcile([], makeDeps({
        sources: stubSources({
          loadTrackProjects: () => [...TRACK_PROJECTS,
            { track_project_id: 353, name: 'Shadow', epic_guid: 'N1' }]
        }, {
          ...EAGLE_BY_DATASET,
          CommentPeriod: [{ _id: 'CP1', project: 'P1' }, { _id: 'CP-pn', project: 'N1' }]
        }),
        projects: {
          listWithEagleId: async (access) => {
            assertSystem(access);
            return [...PROJECT_ROWS, { id: '353', eagleId: 'N1', sourceSystem: 'track' }];
          },
          countWithEagleId: async () => PROJECT_ROWS.length + 1
        },
        commentPeriods: {
          listByProject: async (projectId, access) => {
            assertSystem(access);
            return ({ ...PERIOD_ROWS, 353: [{ id: 'CP-pn', projectId: '353' }] })[projectId] || [];
          }
        }
      }));

      assert.deepStrictEqual(summary.commentPeriods.misfiledParent, ['CP-pn'],
        'the notification owns it, so the row in the project partition is drift');
      // Mirrored, not missing: the id is in both, which is why nothing else reports it.
      assert.deepStrictEqual(summary.commentPeriods.eagleOnly, []);
      assert.deepStrictEqual(summary.commentPeriods.unresolvedParent, []);
      assert.strictEqual(summary.drift, 6, 'and the alert line carries it');
      assert.match(report(summary), /misfiledParent \(mirrored, but stored under a parent.*\): 1 — CP-pn/);
    });

  // A period the rule DOES place where it sits reports nothing, or every clean run would alert.
  await t.test('a period under the notification partition is not misfiled', async () => {
    const summary = await reconcile([], makeDeps({
      sources: stubSources({}, {
        ...EAGLE_BY_DATASET,
        CommentPeriod: [{ _id: 'CP1', project: 'P1' }, { _id: 'CP-pn', project: 'N1' }]
      }),
      commentPeriods: {
        listByProject: async (projectId, access) => {
          assertSystem(access);
          return ({ ...PERIOD_ROWS, N1: [{ id: 'CP-pn', projectId: 'N1' }] })[projectId] || [];
        }
      }
    }));

    assert.deepStrictEqual(summary.commentPeriods.misfiledParent, []);
    assert.strictEqual(summary.drift, 5);
  });

  // A period carrying no project ref at all: the mirror has nothing to resolve, so it drops it.
  await t.test('a period with no project ref is unresolvedParent', async () => {
    const summary = await reconcile([], makeDeps({
      sources: stubSources({}, {
        ...EAGLE_BY_DATASET,
        CommentPeriod: [{ _id: 'CP1', project: 'P1' }, { _id: 'CP-nulled', project: null }]
      })
    }));

    assert.deepStrictEqual(summary.commentPeriods.unresolvedParent, ['CP-nulled']);
    assert.deepStrictEqual(summary.commentPeriods.eagleOnly, []);
    assert.strictEqual(summary.drift, 5);
  });

  // `updates` mirrors Eagle's RecentActivity and was the one public-read container the nightly
  // sweep never compared: drift there was invisible to the alert.
  await t.test('the updates container is swept in both directions', async () => {
    const summary = await reconcile([], makeDeps(updatesDrift()));

    assert.strictEqual(summary.updates.inDemi, 2);
    assert.strictEqual(summary.updates.inEagle, 2);
    assert.deepStrictEqual(summary.updates.unpublishedOrDeleted.map(r => r.id), ['U-gone']);
    assert.deepStrictEqual(summary.updates.eagleOnly, ['U2']);
    assert.strictEqual(summary.drift, 7, 'both directions count toward the alert total');
  });

  await t.test('a truncated updates enumeration is reported', async () => {
    const summary = await reconcile([], makeDeps({}, { updates: UPDATE_ROWS.length + 42 }));
    assert.ok(summary.failures.some(f =>
      /updates enumerated 1 rows but the container holds 43 — .*truncated read/.test(f)),
    `no truncation failure for updates: ${JSON.stringify(summary.failures)}`);
  });

  await t.test('updates drift renders in the report and in the alert line', async () => {
    const summary = await reconcile([], makeDeps(updatesDrift()));
    const rendered = report(summary);

    assert.match(rendered, /^updates: 2 mirrored in DEMI, 2 published in Eagle$/m,
      'the container needs its own section, or its drift is reported nowhere a human reads');
    assert.match(rendered, /updates: 2 mirrored[\s\S]*eagleOnly \(the push missed these\): 1 — U2/);
    assert.ok(summaryLine(summary).includes('updates: unpublishedOrDeleted=1 eagleOnly=1'),
      summaryLine(summary));
  });

  await t.test('a truncated enumeration is reported', async () => {
    const summary = await reconcile([], makeDeps({}, { documents: DOCUMENT_ROWS.length + 500 }));
    assert.match(summary.failures[0],
      /documents enumerated 3 rows but the container holds 503 — .*truncated read/);
  });

  // Both public-read ceilings guard ONE partition read: comment periods partition on project,
  // comments on period. Comparing the accumulated total against the per-partition cap fired on
  // every real run — DEMI holds ~1200 comment periods across ~500 projects.
  await t.test('the comment-period ceiling is per project, not the running total', async () => {
    const perProject = (byProject) => ({
      commentPeriods: {
        listByProject: async (projectId, access) => {
          assertSystem(access);
          return byProject[projectId] || [];
        }
      }
    });
    const half = Math.ceil(MAX_PAGE_SIZE / 2) + 1;

    const spread = await reconcile([], makeDeps(perProject({
      207: idRows('a', half), 'eagle-P2': idRows('b', half)
    })));
    assert.ok(spread.commentPeriods.inDemi > MAX_PAGE_SIZE,
      'more periods in all than one page holds, but no project filled a page');
    assert.deepStrictEqual(spread.failures.filter(f => /comment-period page/.test(f)), [],
      'a total spread across projects is not a truncated read');

    const filled = await reconcile([], makeDeps(perProject({ 207: idRows('a', MAX_PAGE_SIZE) })));
    assert.ok(filled.failures.some(f => /a project filled a comment-period page/.test(f)),
      'one project that filled its page IS a truncated read');
  });

  await t.test('the comment ceiling is per period, not the running total', async () => {
    const twoPeriods = {
      commentPeriods: {
        listByProject: async (projectId, access) => {
          assertSystem(access);
          return projectId === '207' ? [{ id: 'CP1' }, { id: 'CP2' }] : [];
        }
      }
    };
    const byPeriod = (rowsFor) => ({
      ...twoPeriods,
      comments: {
        listByPeriod: async (periodId, access) => { assertSystem(access); return rowsFor(periodId); }
      }
    });
    const half = Math.ceil(MAX_PAGE_SIZE / 2) + 1;

    const spread = await reconcile(['--comments'],
      makeDeps(byPeriod(periodId => idRows(periodId, half))));
    assert.ok(spread.comments.inDemi > MAX_PAGE_SIZE, 'more comments in all than one page holds');
    assert.deepStrictEqual(spread.failures.filter(f => /a period filled a comment page/.test(f)), []);

    const filled = await reconcile(['--comments'], makeDeps(byPeriod(periodId =>
      (periodId === 'CP1' ? idRows('CP1', MAX_PAGE_SIZE) : []))));
    assert.ok(filled.failures.some(f => /a period filled a comment page/.test(f)));
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

  await t.test('unresolvedParent renders in the text report and the --json block', async () => {
    const summary = await reconcile([], makeDeps());
    const rendered = report(summary, { json: true });
    assert.match(rendered, /unresolvedParent \(Eagle-only, but its own project is unpublished\/gone.*\): 1 — D3/);
    const parsed = JSON.parse(rendered.slice(rendered.indexOf('{')));
    assert.deepStrictEqual(parsed.documents.unresolvedParent, ['D3']);
  });
});

test('the admission rule is seed-nosql\'s own', async (t) => {
  await t.test('every document is classified the way seed-nosql would seed it', async () => {
    const src = stubSources();
    const { projects: registry } = buildRegistry(src.loadTrackProjects(), EAGLE_PROJECTS);
    // seed-nosql's own exported rule, over the registry seed-nosql builds. A copied rule in
    // reconcile-eagle.js disagreed with it on D6 and nothing caught it.
    const { admit } = await documentAdmission(src, buildProjectIndex(registry));
    const summary = await reconcile([], makeDeps());

    assert.strictEqual(admit('track-dangling'), '354', 'the dangling-guid class must resolve');
    for (const doc of EAGLE_DOCS) {
      assert.strictEqual(!summary.documents.unresolvedParent.includes(doc._id),
        admit(doc.project) !== null, `${doc._id} classified differently from seed-nosql`);
    }
  });

  // A Track `epic_guid` is sometimes a ProjectNotification _id (test 2026-09-08: Track 351 and
  // 353), and the merge puts it in the project row's `eagleId`, so the registry resolves it. The
  // seed must still file that notification's children under the notification.
  await t.test('a Track project holding a notification id does not claim its children', async () => {
    const shadowTrack = [{ track_project_id: 353, name: 'Shadow', epic_guid: 'N1' }];
    const index = buildProjectIndex(buildRegistry(shadowTrack, EAGLE_PROJECTS).projects);
    const { admit } = await documentAdmission(stubSources(), index);

    assert.strictEqual(index.resolve('N1'), '353',
      'the registry does resolve it — that is what makes the precedence load-bearing');
    assert.strictEqual(admit('N1'), 'N1');
    // And a populated ref answers the same, as it does in the push mirrors.
    assert.strictEqual(admit({ _id: 'N1' }), 'N1');
  });
});

test('summaryLine is the alert contract', async (t) => {
  await t.test('carries every count and a drift total', async () => {
    const summary = await reconcile([], makeDeps());
    assert.strictEqual(summaryLine(summary),
      '[reconcile] projects: unpublishedOrDeleted=1 eagleOnly=0 ' +
      'documents: unpublishedOrDeleted=1 eagleOnly=3 unresolvedParent=1 ' +
      'commentPeriods: unpublishedOrDeleted=0 eagleOnly=0 ' +
      'lists: unpublishedOrDeleted=0 eagleOnly=0 ' +
      'notifications: unpublishedOrDeleted=0 eagleOnly=0 ' +
      'updates: unpublishedOrDeleted=0 eagleOnly=0 ' +
      'comments: skipped drift=5');
  });

  // A container the run did not sweep must not read as a clean one: `comments` costs an eagle-api
  // round trip per period, so it is off unless asked for, and zeros there would say "no drift".
  await t.test('a container the run skipped says so instead of reporting zero', async () => {
    assert.match(summaryLine(await reconcile([], makeDeps())), /comments: skipped drift=/);
    assert.match(summaryLine(await reconcile(['--comments'], makeDeps())),
      /comments: unpublishedOrDeleted=1 eagleOnly=0 drift=6/);
  });

  await t.test('a clean run says drift=0', () => {
    assert.strictEqual(
      summaryLine({ projects: { unpublishedOrDeleted: [], eagleOnly: [] },
        documents: { unpublishedOrDeleted: [], eagleOnly: [], unresolvedParent: [] },
        drift: 0 }),
      '[reconcile] projects: unpublishedOrDeleted=0 eagleOnly=0 ' +
      'documents: unpublishedOrDeleted=0 eagleOnly=0 unresolvedParent=0 ' +
      'commentPeriods: skipped lists: skipped notifications: skipped updates: skipped ' +
      'comments: skipped drift=0');
  });

  // The alert rule reads `drift=` out of this line with a regex (azure/modules/observability.bicep).
  await t.test('the alert can always extract drift=', async () => {
    const line = summaryLine(await reconcile([], makeDeps()));
    assert.ok(line.includes('[reconcile] projects'), line);
    assert.strictEqual(/drift=([0-9]+)/.exec(line)[1], '5');
  });
});

// `run` is what BOTH callers go through — the CLI entry below `require.main` and the nightly
// timer trigger in api/index.js. The alert reads one line out of the application log, so a
// run that reported to its caller and logged nothing would leave the alarm permanently silent with
// every test still green.
test('run reports to its caller and to the log', async (t) => {
  const lines = [];
  t.mock.method(logger, 'info', (message) => { lines.push(message); });

  const summary = await run({ deps: makeDeps() });

  assert.strictEqual(summary.drift, 5, 'the summary is returned, not just printed');
  assert.deepStrictEqual(summary, await reconcile([], makeDeps()),
    'and it is the same object reconcile() computes — run() adds logging and nothing else');

  assert.ok(lines.includes(summaryLine(summary)),
    'the alert line must be logged AS ITS OWN RECORD: the rule extracts drift= from one message, ' +
    'so folding it into the report body would leave nothing for it to match');
  assert.ok(lines.some(line => line.startsWith('[reconcile] eagle=')), 'the report body too');
  assert.ok(!lines.some(line => line.includes('"eagleOnly"')),
    'and no id dump unless --json asked for one');
});

test('run passes --json through to the report', async (t) => {
  const lines = [];
  t.mock.method(logger, 'info', (message) => { lines.push(message); });

  await run({ json: true, deps: makeDeps() });

  assert.ok(lines.some(line => line.includes('"eagleOnly"')),
    '--json is the only way to get the full id sets, and the CLI still passes it');
});
