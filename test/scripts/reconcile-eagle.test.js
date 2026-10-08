'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  parseArgs, diff, aclMismatch, summaryLine, reconcile, report, run, slugOf
} = require('../../src/scripts/reconcile-eagle');
const { logger } = require('../../src/utils/logger');
const { documentAdmission } = require('../../src/scripts/seed-nosql');
const { buildRegistry, buildProjectIndex } = require('../../src/merge/project');
const { readForLevel, systemAccess } = require('../../src/helpers/access-sql');
const { ids, pagedCosmos } = require('../helpers/paged-cosmos');
const updatesRepo = require('../../src/repositories/updates');
const notificationsRepo = require('../../src/repositories/notifications');
const listsRepo = require('../../src/repositories/lists');
const periodsRepo = require('../../src/repositories/comment-periods');
const commentsRepo = require('../../src/repositories/comments');
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

/**
 * A per-partition COUNT for a fake that overrides only the read: what that read returns, unless
 * `counted[partition]` says the partition holds more.
 */
const countOfRead = (read, counted = {}) => async (partition, access) =>
  counted[partition] ?? (await read(partition, access)).length;

/** A users, groups or inspections fake: the reconcile reads each whole, once, as the system. */
const storedRows = (rows) => ({
  listAclRows: async (access) => { assertSystem(access); return rows; }
});

function makeDeps(over = {}, counts = {}) {
  const deps = {
    sources: stubSources(),
    projects: {
      listWithEagleId: async (access) => { assertSystem(access); return PROJECT_ROWS; },
      countWithEagleId: async () => counts.projects ?? PROJECT_ROWS.length
    },
    documents: {
      listSeededIds: async (access) => { assertSystem(access); return DOCUMENT_ROWS; },
      countSeededIds: async () => counts.documents ?? DOCUMENT_ROWS.length,
      countParentFieldsPending: async (access) => {
        assertSystem(access);
        return counts.parentFieldsPending ?? 0;
      }
    },
    commentPeriods: {
      listEveryByProject: async (projectId, access) => {
        assertSystem(access);
        return PERIOD_ROWS[projectId] || [];
      }
    },
    lists: {
      KINDS: { LIST: 'List', ORGANIZATION: 'Organization' },
      listEveryOfKind: async (kind, access) => { assertSystem(access); return LIST_ROWS[kind]; },
      countByKind: async (kind) => counts[kind] ?? LIST_ROWS[kind].length
    },
    notifications: {
      listEvery: async (access) => { assertSystem(access); return NOTIFICATION_ROWS; },
      count: async () => counts.notifications ?? NOTIFICATION_ROWS.length
    },
    updates: {
      listEvery: async (access) => { assertSystem(access); return UPDATE_ROWS; },
      count: async () => counts.updates ?? UPDATE_ROWS.length
    },
    comments: {
      listEveryByPeriod: async (periodId, access) => { assertSystem(access); return [{ id: 'C1' }]; }
    },
    users: storedRows([]),
    groups: storedRows([]),
    inspections: storedRows([]),
    ...over
  };
  deps.commentPeriods = {
    countByProject: countOfRead(deps.commentPeriods.listEveryByProject, counts.commentPeriods),
    ...deps.commentPeriods
  };
  deps.comments = {
    countByPeriod: countOfRead(deps.comments.listEveryByPeriod, counts.comments),
    ...deps.comments
  };
  return deps;
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
      listEvery: async (access) => { assertSystem(access); return [{ id: 'U1' }, { id: 'U-gone' }]; },
      count: async () => 2
    }
  };
}

test('parseArgs', async (t) => {
  await t.test('takes --json, --comments, --engage, --drop-orphans and --store', () => {
    const base = { json: false, comments: false, engage: false, dropOrphans: false, store: false };
    assert.deepStrictEqual(parseArgs([]), base);
    assert.deepStrictEqual(parseArgs(['--json']), { ...base, json: true });
    assert.deepStrictEqual(parseArgs(['--store']), { ...base, store: true });
    assert.deepStrictEqual(parseArgs(['--comments']), { ...base, comments: true });
    assert.deepStrictEqual(parseArgs(['--engage']), { ...base, engage: true });
    // The delete flag IMPLIES the sweep: there is nothing to drop without one, and a
    // `--drop-orphans` that quietly did nothing is worse than one that refuses.
    assert.deepStrictEqual(parseArgs(['--drop-orphans']),
      { ...base, engage: true, dropOrphans: true });
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

test('aclMismatch', async (t) => {
  const PUBLIC = readForLevel(4);
  const STAFF = readForLevel(2);
  const byId = row => row.id;
  const eagle = (read) => new Map([['a', read]]);

  await t.test('compares read[] as sets, not in order', () => {
    const rows = [{ id: 'a', read: [...PUBLIC].reverse(), isPublished: true }];
    assert.deepStrictEqual(aclMismatch(rows, byId, eagle(PUBLIC)), []);
  });

  await t.test('public in Eagle but private in DEMI is a mismatch', () => {
    const rows = [{ id: 'a', read: STAFF, isPublished: false }];
    assert.deepStrictEqual(aclMismatch(rows, byId, eagle(PUBLIC)), ['a']);
  });

  await t.test('private in Eagle but public in DEMI is a mismatch', () => {
    const rows = [{ id: 'a', read: PUBLIC, isPublished: true }];
    assert.deepStrictEqual(aclMismatch(rows, byId, eagle(STAFF)), ['a']);
  });

  for (const parent of [['team'], ['sysadmin'], [], ['project-team']]) {
    await t.test(`a no-ladder row stored privileged-only under level-1 parent ${JSON.stringify(parent)} is not drift`, () => {
      const rows = [{ id: 'a', read: ['sysadmin'], isPublished: false }];
      assert.deepStrictEqual(aclMismatch(rows, byId, eagle(['sysadmin']), () => parent), []);
    });
  }

  await t.test('a no-ladder row under a staff parent is drift until it carries staff', () => {
    const parentOf = () => STAFF;
    assert.deepStrictEqual(aclMismatch([{ id: 'a', read: ['sysadmin'], isPublished: false }], byId, eagle(['sysadmin']), parentOf), ['a']);
    assert.deepStrictEqual(aclMismatch([{ id: 'a', read: STAFF, isPublished: false }], byId, eagle(['sysadmin']), parentOf), []);
  });

  await t.test('isPublished out of step with its own read[] is a mismatch', () => {
    const rows = [{ id: 'a', read: PUBLIC, isPublished: false }];
    assert.deepStrictEqual(aclMismatch(rows, byId, eagle(PUBLIC)), ['a']);
  });

  await t.test('a row narrowed to its DEMI parent is what the mirror writes, not a mismatch', () => {
    const rows = [{ id: 'a', read: STAFF, isPublished: false }];
    assert.deepStrictEqual(aclMismatch(rows, byId, eagle(PUBLIC), () => STAFF), []);
  });

  await t.test('an Eagle record carrying no read[] is not compared', () => {
    const rows = [{ id: 'a', read: STAFF, isPublished: false }];
    assert.deepStrictEqual(aclMismatch(rows, byId, new Map()), []);
  });

  // The early seed stored Eagle's role names; the mirror now writes ladder tokens under a parent.
  const RAW_PUBLIC = ['public', 'sysadmin', 'staff'];
  const RAW_STAFF = ['sysadmin', 'staff'];
  const underPublic = () => PUBLIC;

  await t.test('a raw seed read at level 4 under a project is in step with the ladder', () => {
    const rows = [{ id: 'a', read: RAW_PUBLIC, isPublished: true }];
    assert.deepStrictEqual(aclMismatch(rows, byId, eagle(RAW_PUBLIC), underPublic), []);
  });

  await t.test('a raw staff-only read is in step with ladder level 2', () => {
    const rows = [{ id: 'a', read: RAW_STAFF, isPublished: false }];
    assert.deepStrictEqual(aclMismatch(rows, byId, eagle(RAW_STAFF), underPublic), []);
  });

  await t.test('a raw public row Eagle has since made private is a mismatch', () => {
    const rows = [{ id: 'a', read: RAW_PUBLIC, isPublished: true }];
    assert.deepStrictEqual(aclMismatch(rows, byId, eagle(RAW_STAFF), underPublic), ['a']);
  });

  await t.test('a raw private row Eagle has since published is a mismatch', () => {
    const rows = [{ id: 'a', read: RAW_STAFF, isPublished: false }];
    assert.deepStrictEqual(aclMismatch(rows, byId, eagle(RAW_PUBLIC), underPublic), ['a']);
  });

  await t.test('isPublished out of step on a raw-shape row is still a mismatch', () => {
    const rows = [{ id: 'a', read: RAW_PUBLIC, isPublished: false }];
    assert.deepStrictEqual(aclMismatch(rows, byId, eagle(RAW_PUBLIC), underPublic), ['a']);
  });

  await t.test('two different level 1 reads are a mismatch', () => {
    const rows = [{ id: 'a', read: ['team'], isPublished: false }];
    assert.deepStrictEqual(aclMismatch(rows, byId, eagle(['sysadmin'])), ['a']);
  });

  await t.test('the same level 1 read is not a mismatch', () => {
    const rows = [{ id: 'a', read: ['team'], isPublished: false }];
    assert.deepStrictEqual(aclMismatch(rows, byId, eagle(['team'])), []);
  });

  // Same level, but a caller the ladder row turns away still gets in (or the reverse).
  await t.test('a level 2 row carrying an unprivileged role name is a mismatch', () => {
    const rows = [{ id: 'a', read: ['staff', 'project-team'], isPublished: false }];
    assert.deepStrictEqual(aclMismatch(rows, byId, eagle(RAW_PUBLIC), () => STAFF), ['a']);
  });

  await t.test('a level 2 row carrying team opens it to the team arm, a mismatch', () => {
    const rows = [{ id: 'a', read: ['staff', 'team'], isPublished: false }];
    assert.deepStrictEqual(aclMismatch(rows, byId, eagle(RAW_PUBLIC), () => STAFF), ['a']);
  });

  await t.test('a level 3 row without staff shuts out a staff caller, a mismatch', () => {
    const rows = [{ id: 'a', read: ['idir', 'sysadmin'], isPublished: false }];
    assert.deepStrictEqual(
      aclMismatch(rows, byId, eagle(RAW_PUBLIC), () => readForLevel(3)), ['a']);
  });
});

test('reconcile', async (t) => {
  // Every id here is in both Eagle and DEMI, so each id-set diff reads them as clean.
  await t.test('reports ACL drift on ids both sides hold', async () => {
    const PUBLIC = readForLevel(4);
    const STAFF = readForLevel(2);
    const withRead = (rows, reads) => rows.map(row => ({ ...row, ...reads[row._id || row.id] }));
    const summary = await reconcile([], makeDeps({
      sources: stubSources({
        fetchEagleProjects: async () => EAGLE_PROJECTS.map(p => ({ ...p, read: PUBLIC })),
        streamEagleDocuments: async (onPage) => {
          await onPage(EAGLE_DOCS.map(d => ({ ...d, read: PUBLIC })));
          return { count: EAGLE_DOCS.length, total: EAGLE_DOCS.length };
        }
      }, { ...EAGLE_BY_DATASET, List: [{ _id: 'L1', read: STAFF }] }),
      projects: {
        listWithEagleId: async () => withRead(PROJECT_ROWS, {
          207: { read: PUBLIC, isPublished: true },
          // Public in Eagle, private in DEMI.
          'eagle-P2': { read: STAFF, isPublished: false }
        }),
        countWithEagleId: async () => PROJECT_ROWS.length
      },
      documents: {
        ...makeDeps().documents,
        listSeededIds: async () => withRead(DOCUMENT_ROWS, {
          // Under public 207, so it should be public too.
          D1: { read: STAFF, isPublished: false },
          // Under private eagle-P2: the mirror narrows it to staff. The early seed's raw spelling
          // of that level grants the same callers, so this is in step.
          D2: { read: ['sysadmin', 'staff'], isPublished: false }
        })
      },
      lists: {
        ...makeDeps().lists,
        // Private in Eagle, public in DEMI.
        listEveryOfKind: async (kind) => kind === 'List'
          ? [{ id: 'L1', kind: 'List', read: PUBLIC, isPublished: true }]
          : LIST_ROWS[kind]
      }
    }));

    assert.deepStrictEqual(summary.projects.aclMismatch, ['P2']);
    assert.deepStrictEqual(summary.documents.aclMismatch, ['D1']);
    assert.deepStrictEqual(summary.lists.aclMismatch, ['L1']);
    assert.strictEqual(summary.drift, 8, 'the five id-set drifts plus three ACL mismatches');
    assert.match(summaryLine(summary),
      /projects: unpublishedOrDeleted=1 eagleOnly=0 aclMismatch=1 /);
    assert.match(report(summary), /aclMismatch \(in both, .*\): 1 — D1/);
    assert.match(report(summary, { json: true }), /"aclMismatch": \[\s*"P2"\s*\]/);
  });

  await t.test('an eagleOnly set says level-0 rows are counted there, and which a re-push repairs', async () => {
    const rendered = report(await reconcile([], makeDeps()));
    // Per container: projects has no eagleOnly in these fixtures, documents does.
    const section = (label) => rendered.split(/\n(?=\w+: \d+ mirrored in DEMI)/)
      .find(part => part.startsWith(`${label}:`));
    const NOTE = /eagleOnly \(the push missed these\): [^\n]+\n {4}rows stored at level 0 are not read here and count as missing; a re-push repairs those an Eagle push sealed, a DEMI seal \(sealedAt\) stays\n/;

    assert.match(section('documents'), NOTE);
    assert.doesNotMatch(section('projects'), /rows stored at level 0/);
  });

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
        listEveryByProject: async (projectId, access) => {
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
          listEveryByProject: async (projectId, access) => {
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
        listEveryByProject: async (projectId, access) => {
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

  await t.test('an Update the push capped by its project or notification is not ACL drift', async () => {
    const eaglePublic = ['public', 'sysadmin', 'staff'];
    const summary = await reconcile([], makeDeps({
      sources: stubSources({}, { ...EAGLE_BY_DATASET, RecentActivity: [
        { _id: 'U-proj', project: 'P2', read: eaglePublic },
        { _id: 'U-note', project: 'N1', read: eaglePublic },
        { _id: 'U-open', project: 'P1', read: eaglePublic },
        { _id: 'U-admin', project: 'P1', read: ['sysadmin'] }
      ] }),
      projects: {
        ...makeDeps().projects,
        listWithEagleId: async () => PROJECT_ROWS.map(row => ({
          ...row, read: row.eagleId === 'P1' ? ['staff', 'idir', 'public'] : ['staff']
        }))
      },
      notifications: {
        ...makeDeps().notifications,
        listEvery: async () => [{ id: 'N1', read: ['staff'] }]
      },
      updates: {
        listEvery: async () => [
          // Capped to staff under private eagle-P2 and private N1: in step.
          { id: 'U-proj', projectId: 'P2', read: ['staff'], isPublished: false },
          { id: 'U-note', projectId: 'N1', read: ['staff'], isPublished: false },
          // Under public P1, so Eagle's own read verbatim; staff here is drift.
          { id: 'U-open', projectId: 'P1', read: ['staff'], isPublished: false },
          // No ladder token from Eagle, so staff is added (`withEagleStaff`): in step.
          { id: 'U-admin', projectId: 'P1', read: ['sysadmin', 'staff'], isPublished: false }
        ],
        count: async () => 4
      }
    }));

    assert.deepStrictEqual(summary.updates.aclMismatch, ['U-open']);
  });

  await t.test('an Update whose Eagle read carries compliance is compared stripped', async () => {
    const summary = await reconcile([], makeDeps({
      sources: stubSources({}, { ...EAGLE_BY_DATASET, RecentActivity: [
        { _id: 'U-comp', project: 'P1', read: ['compliance', 'public'] },
        { _id: 'U-only', project: 'P1', read: ['compliance'] }
      ] }),
      projects: {
        ...makeDeps().projects,
        listWithEagleId: async () => PROJECT_ROWS.map(row => ({ ...row, read: ['staff', 'idir', 'public'] }))
      },
      updates: {
        listEvery: async () => [
          // What the push stores: the token dropped, and sysadmin plus staff when nothing else is left.
          { id: 'U-comp', projectId: 'P1', read: ['public'], isPublished: true },
          { id: 'U-only', projectId: 'P1', read: ['sysadmin', 'staff'], isPublished: false }
        ],
        count: async () => 2
      }
    }));

    assert.deepStrictEqual(summary.updates.aclMismatch, []);
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

  // Prod, 2026-10-03: a one-page read of 2,543 updates printed `updates eagleOnly=1543`.
  await t.test('updates past one page are read whole, so matching sides report eagleOnly=0',
    async (tt) => {
      const rows = ids('U', 2500);
      pagedCosmos(tt, container => (container === updatesRepo.CONTAINER ? rows : []));
      const summary = await reconcile([], makeDeps({
        sources: stubSources({}, {
          ...EAGLE_BY_DATASET, RecentActivity: rows.map(row => ({ _id: row.id }))
        }),
        updates: updatesRepo
      }));

      assert.strictEqual(summary.updates.inDemi, rows.length);
      assert.deepStrictEqual(summary.updates.eagleOnly, []);
      assert.deepStrictEqual(summary.updates.unpublishedOrDeleted, []);
      assert.deepStrictEqual(summary.failures.filter(f => /^updates/.test(f)), []);
    });

  await t.test('every DEMI enumeration reads past one page', async (tt) => {
    const rows = ids('r', 2500);
    const seen = pagedCosmos(tt, () => rows);
    const access = systemAccess();
    // `crossPartition`: unsorted, because a cross-partition ORDER BY loses its continuation.
    const reads = [
      ['notifications.listEvery', notificationsRepo.CONTAINER, true,
        () => notificationsRepo.listEvery(access)],
      ['updates.listEvery', updatesRepo.CONTAINER, true, () => updatesRepo.listEvery(access)],
      ['lists.listEveryOfKind', listsRepo.CONTAINER, false,
        () => listsRepo.listEveryOfKind(listsRepo.KINDS.ORGANIZATION, access)],
      ['commentPeriods.listEveryByProject', periodsRepo.CONTAINER, false,
        () => periodsRepo.listEveryByProject('207', access)],
      ['comments.listEveryByPeriod', commentsRepo.CONTAINER, false,
        () => commentsRepo.listEveryByPeriod('CP1', access)]
    ];
    for (const [name, container, crossPartition, read] of reads) {
      const before = seen.length;
      assert.strictEqual((await read()).length, rows.length, `${name} stopped at one page`);
      if (crossPartition) {
        const own = seen.slice(before).filter(s => s.container === container);
        assert.ok(own.length > 0 && own.every(s => !/ORDER BY/.test(s.spec.query)),
          `${name} must not sort`);
      }
    }
  });

  await t.test('a comment-period partition read short of its COUNT is reported', async () => {
    const summary = await reconcile([], makeDeps({}, { commentPeriods: { 207: 1001 } }));
    assert.ok(summary.failures.some(f =>
      /commentPeriods enumerated 1 rows but the container holds 1001 — .*truncated read/.test(f)),
    JSON.stringify(summary.failures));
  });

  await t.test('a comment partition read short of its COUNT is reported', async () => {
    const summary = await reconcile(['--comments'], makeDeps({}, { comments: { CP1: 1001 } }));
    assert.ok(summary.failures.some(f =>
      /comments enumerated 1 rows but the container holds 1001 — .*truncated read/.test(f)),
    JSON.stringify(summary.failures));
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
      '[reconcile] projects: unpublishedOrDeleted=1 eagleOnly=0 aclMismatch=0 ' +
      'documents: unpublishedOrDeleted=1 eagleOnly=3 unresolvedParent=1 aclMismatch=0 ' +
      'commentPeriods: unpublishedOrDeleted=0 eagleOnly=0 aclMismatch=0 ' +
      'lists: unpublishedOrDeleted=0 eagleOnly=0 aclMismatch=0 ' +
      'notifications: unpublishedOrDeleted=0 eagleOnly=0 aclMismatch=0 ' +
      'updates: unpublishedOrDeleted=0 eagleOnly=0 aclMismatch=0 ' +
      'users: aclMismatch=0 missingParent=0 groups: aclMismatch=0 missingParent=0 ' +
      'inspections: aclMismatch=0 missingParent=0 inspectionElements: aclMismatch=0 missingParent=0 ' +
      'inspectionItems: aclMismatch=0 missingParent=0 ' +
      'comments: skipped engageOrphans: skipped parentFieldsPending=0 drift=5');
  });

  // A container the run did not sweep must not read as a clean one: `comments` costs an eagle-api
  // round trip per period, so it is off unless asked for, and zeros there would say "no drift".
  await t.test('a container the run skipped says so instead of reporting zero', async () => {
    assert.match(summaryLine(await reconcile([], makeDeps())),
      /comments: skipped engageOrphans: skipped parentFieldsPending=0 drift=/);
    assert.match(summaryLine(await reconcile(['--comments'], makeDeps())),
      /comments: unpublishedOrDeleted=1 eagleOnly=0 aclMismatch=0 engageOrphans: skipped parentFieldsPending=0 drift=6/);
  });

  await t.test('documents whose chunks never got re-stamped reach the alert line', async () => {
    // A lost re-stamp is not push drift, so it is its own number — but it has to be ON the line the
    // nightly alert reads, or nothing ever looks at it. `demi-reconcile-drift-<env>` extracts both.
    const summary = await reconcile([], makeDeps({}, { parentFieldsPending: 12 }));

    assert.strictEqual(summary.parentFieldsPending, 12);
    assert.match(summaryLine(summary), /parentFieldsPending=12/);
    assert.strictEqual(summary.drift, 5, 'it must not be folded into the push drift total');
  });

  await t.test('a clean run says drift=0', () => {
    assert.strictEqual(
      summaryLine({ projects: { unpublishedOrDeleted: [], eagleOnly: [] },
        documents: { unpublishedOrDeleted: [], eagleOnly: [], unresolvedParent: [] },
        drift: 0, parentFieldsPending: 0 }),
      '[reconcile] projects: unpublishedOrDeleted=0 eagleOnly=0 aclMismatch=0 ' +
      'documents: unpublishedOrDeleted=0 eagleOnly=0 unresolvedParent=0 aclMismatch=0 ' +
      'commentPeriods: skipped lists: skipped notifications: skipped updates: skipped ' +
      'users: skipped groups: skipped inspections: skipped inspectionElements: skipped ' +
      'inspectionItems: skipped ' +
      'comments: skipped engageOrphans: skipped parentFieldsPending=0 drift=0');
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

/**
 * The drift classes. Fixture ids here are real ObjectIds, because a parent ref that is not one is
 * a malformed ref the push refuses, and so classes as an orphan.
 *
 * Eagle publishes PUB and PUB_UNMIRRORED. DEMI holds PUB and HIDDEN (Eagle no longer publishes
 * it) plus a Track row Eagle never had. Track holds nothing, so no ref resolves through it.
 */
const oid = n => n.toString(16).padStart(24, '0');
const PUB = oid(1);
const HIDDEN = oid(2);
const ABSENT = oid(3);
const PUB_UNMIRRORED = oid(4);
// Not an ObjectId, so the push refuses it, even though a DEMI row carries it as its eagleId.
const BAD_REF = 'not-an-object-id';
const DOC = { missed: oid(10), underHidden: oid(11), underGone: oid(12), noRef: oid(13),
  badRef: oid(14), underUnmirrored: oid(15) };

function classDeps({ docs = [
  { _id: DOC.missed, project: PUB }, { _id: DOC.underHidden, project: HIDDEN },
  { _id: DOC.underGone, project: ABSENT }, { _id: DOC.noRef, project: null },
  { _id: DOC.badRef, project: BAD_REF }, { _id: DOC.underUnmirrored, project: PUB_UNMIRRORED }
], periods = [], sourcesOver = {}, over = {} } = {}) {
  const projectRows = [
    { id: `eagle-${PUB}`, eagleId: PUB, sourceSystem: 'eagle' },
    { id: `eagle-${HIDDEN}`, eagleId: HIDDEN, sourceSystem: 'eagle' },
    { id: '354', eagleId: oid(99), sourceSystem: 'track' },
    { id: `eagle-${BAD_REF}`, eagleId: BAD_REF, sourceSystem: 'eagle' }
  ];
  return makeDeps({
    sources: stubSources({
      loadTrackProjects: () => [],
      fetchEagleProjects: async () => [{ _id: PUB }, { _id: PUB_UNMIRRORED }],
      streamEagleDocuments: async (onPage) => { await onPage(docs); return { count: docs.length, total: docs.length }; },
      ...sourcesOver
    }, { ...EAGLE_BY_DATASET, CommentPeriod: periods }),
    projects: {
      listWithEagleId: async () => projectRows,
      countWithEagleId: async () => projectRows.length
    },
    documents: {
      listSeededIds: async () => [],
      countSeededIds: async () => 0,
      countParentFieldsPending: async () => 0
    },
    ...over
  });
}

test('every drifted id is classed by what its parent ref names', async (t) => {
  const classesOf = async () => (await reconcile([], classDeps())).classes;

  await t.test('a document whose project row DEMI holds is a retryable push miss', async () => {
    const { documents } = await classesOf();
    assert.deepStrictEqual(documents['push-missed-parent-in-demi'], [DOC.missed]);
  });

  await t.test('a document under a project DEMI holds but Eagle does not publish is parent-not-public', async () => {
    const { documents } = await classesOf();
    assert.deepStrictEqual(documents['parent-not-public'], [DOC.underHidden]);
  });

  await t.test('a document whose project is in none of Eagle, DEMI or Track is an orphan, as is an empty or malformed ref', async () => {
    const { documents } = await classesOf();
    assert.deepStrictEqual(documents['orphan-parent-missing-in-eagle'].sort(),
      [DOC.underGone, DOC.noRef, DOC.badRef].sort());
  });

  // Its parent is itself drift, so re-pushing the child alone would be refused again.
  await t.test('a document whose published project DEMI never mirrored is a plain push miss', async () => {
    const { documents } = await classesOf();
    assert.deepStrictEqual(documents['push-missed'], [DOC.underUnmirrored]);
  });

  await t.test('a Track-sourced project gone from Eagle is demi-only', async () => {
    const { projects } = await classesOf();
    assert.deepStrictEqual(projects['demi-only'], ['354']);
  });

  await t.test('the classes leave the alert line as it was', async () => {
    const plain = await reconcile([], makeDeps());
    assert.ok(plain.classes, 'the existing fixtures are classed too');
    assert.strictEqual(/drift=([0-9]+)/.exec(summaryLine(plain))[1], '5');
  });
});

test('run logs the classes on their own line, which the alert cannot match', async (t) => {
  const lines = [];
  t.mock.method(logger, 'info', (message) => { lines.push(message); });

  await run({ deps: classDeps() });

  const line = lines.find(l => l.startsWith('[reconcile] classes '));
  assert.ok(line, lines.join('\n'));
  assert.match(line, /documents: .*orphan-parent-missing-in-eagle=3/);
  assert.ok(!line.includes('[reconcile] projects') && !line.includes('drift='),
    'the alert matches "[reconcile] projects" and reads drift=; this line must trip neither');
});

/**
 * Comment classes under `--comments`. DEMI mirrors one period, under PUB, and one of its two
 * comments. Eagle also publishes a period under ABSENT (in no system) and one under HIDDEN (DEMI
 * holds the project, Eagle does not publish it): the mirror resolves neither period, so their
 * comments class by the period's own project ref.
 */
const CP = { pub: oid(20), underGone: oid(21), underHidden: oid(22) };
const COMMENT = { mirrored: oid(30), missed: oid(31), underGone: oid(32), underHidden: oid(33) };

function commentClassDeps() {
  const eagleComments = {
    [CP.pub]: [{ _id: COMMENT.mirrored }, { _id: COMMENT.missed }],
    [CP.underGone]: [{ _id: COMMENT.underGone }],
    [CP.underHidden]: [{ _id: COMMENT.underHidden }]
  };
  return classDeps({
    periods: [{ _id: CP.pub, project: PUB }, { _id: CP.underGone, project: ABSENT },
      { _id: CP.underHidden, project: HIDDEN }],
    sourcesOver: {
      fetchJsonWithHeaders: async (url) => {
        const body = eagleComments[new URL(url).searchParams.get('period')] || [];
        return { body, headers: new Headers({ 'x-total-count': String(body.length) }) };
      }
    },
    over: {
      commentPeriods: {
        listEveryByProject: async (projectId) =>
          (projectId === `eagle-${PUB}` ? [{ id: CP.pub, projectId }] : [])
      },
      comments: {
        listEveryByPeriod: async (periodId) => (periodId === CP.pub ? [{ id: COMMENT.mirrored }] : [])
      }
    }
  });
}

test('--comments classes each drifted comment by the parent its period resolves to', async (t) => {
  const classesOf = async () => (await reconcile(['--comments'], commentClassDeps())).classes.comments;

  await t.test('a comment under an unresolved period whose project is in no system is an orphan', async () => {
    const comments = await classesOf();
    assert.deepStrictEqual(comments['orphan-parent-missing-in-eagle'], [COMMENT.underGone]);
  });

  await t.test('a comment under an unresolved period whose project Eagle does not publish is parent-not-public', async () => {
    const comments = await classesOf();
    assert.deepStrictEqual(comments['parent-not-public'], [COMMENT.underHidden]);
  });

  await t.test('a comment missing under a period DEMI holds is a retryable push miss', async () => {
    const comments = await classesOf();
    assert.deepStrictEqual(comments['push-missed-parent-in-demi'], [COMMENT.missed]);
  });
});

test('run --store', async (t) => {
  const quiet = () => t.mock.method(logger, 'info', () => {});
  const recordingCache = (put = async () => {}) => {
    const puts = [];
    return { puts, put: async (id, doc) => { puts.push({ id, doc }); return put(id, doc); } };
  };

  await t.test('writes one report row holding each class count and its ids', async () => {
    quiet();
    const cacheDouble = recordingCache();
    await run({ store: true, deps: { ...classDeps(), cache: cacheDouble } });

    assert.strictEqual(cacheDouble.puts.length, 1);
    const [{ id, doc }] = cacheDouble.puts;
    assert.strictEqual(id, 'reconcile-report');
    assert.ok(!Number.isNaN(Date.parse(doc.body.ranAt)));
    assert.strictEqual(doc.body.documents.counts['orphan-parent-missing-in-eagle'], 3);
    assert.deepStrictEqual(doc.body.documents.ids['push-missed-parent-in-demi'], [DOC.missed]);
    assert.strictEqual(doc.body.documents.truncated, false);
  });

  await t.test('keeps at most 200 ids per class, and says so, while the count stays whole', async () => {
    quiet();
    const docs = Array.from({ length: 201 }, (_, i) => ({ _id: oid(1000 + i), project: PUB }));
    const cacheDouble = recordingCache();
    await run({ store: true, deps: { ...classDeps({ docs }), cache: cacheDouble } });

    const { documents } = cacheDouble.puts[0].doc.body;
    assert.strictEqual(documents.counts['push-missed-parent-in-demi'], 201);
    assert.strictEqual(documents.ids['push-missed-parent-in-demi'].length, 200);
    assert.strictEqual(documents.truncated, true);
  });

  await t.test('keeps exactly 200 ids whole, with no truncation flag', async () => {
    quiet();
    const docs = Array.from({ length: 200 }, (_, i) => ({ _id: oid(1000 + i), project: PUB }));
    const cacheDouble = recordingCache();
    await run({ store: true, deps: { ...classDeps({ docs }), cache: cacheDouble } });

    const { documents } = cacheDouble.puts[0].doc.body;
    assert.strictEqual(documents.ids['push-missed-parent-in-demi'].length, 200);
    assert.strictEqual(documents.truncated, false);
  });

  await t.test('a failed write is logged and the run still resolves', async () => {
    quiet();
    const errors = [];
    t.mock.method(logger, 'error', (message, meta) => { errors.push({ message, meta }); });
    const cacheDouble = recordingCache(async () => { throw new Error('cosmos unavailable'); });

    const summary = await run({ store: true, deps: { ...classDeps(), cache: cacheDouble } });

    assert.ok(summary.classes, 'the run resolved with its summary');
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /\[reconcile\] report store failed/);
    assert.strictEqual(errors[0].meta.error, 'cosmos unavailable');
  });

  await t.test('without it, nothing is written', async () => {
    quiet();
    const cacheDouble = recordingCache();
    await run({ deps: { ...classDeps(), cache: cacheDouble } });
    assert.strictEqual(cacheDouble.puts.length, 0);
  });
});

/**
 * The ENGAGE dead-slug guard.
 *
 * ENGAGE deletes an engagement without telling DEMI when its `delete_from_epic` returns early on an
 * unset `project_tracking_id`, so the mirror keeps a period whose `metURL` 404s for every visitor.
 * The id-set diffs cannot see it — the row is in Eagle AND in DEMI — so this is the only thing that
 * looks, and it is also the only thing in this script that can delete.
 *
 * `fetch` is the stub point rather than the repository, because what decides whether a row lives or
 * dies is how an ENGAGE RESPONSE is read: the production hazard is a 200 of SPA HTML from
 * `engage.eao.gov.bc.ca`, which is not the API and answers every path that way.
 */
const ENGAGE_BASE = 'https://engage-api.example/api';

const GONE = (slug) => ({
  status: 400, ok: false,
  text: async () => JSON.stringify({ message: `No engagement slug found for ${slug}` })
});
const LIVE = { status: 200, ok: true, text: async () => '{"id":1}' };

/** `metURL`s pointing at ENGAGE, plus the `isMet: false` row that has no slug to resolve. */
const MET_PERIODS = [
  { id: 'CP-live', projectId: '207', isMet: true, metURL: 'https://engage.example/alive-slug' },
  { id: 'CP-dead', projectId: '207', isMet: true, metURL: 'https://engage.example/dead-slug' },
  { id: 'CP-here', projectId: '207', isMet: false, metURL: '' }
];

/** The same deps as every other case, with the periods and the ENGAGE responses swapped in. */
function engageDeps({ rows = MET_PERIODS, respond, deleted = [] } = {}) {
  return makeDeps({
    engageApiBase: ENGAGE_BASE,
    fetch: async (url) => respond(url),
    commentPeriods: {
      listEveryByProject: async (projectId, access) => {
        assertSystem(access);
        return projectId === '207' ? rows : [];
      },
      deleteById: async (id, projectId) => { deleted.push(`${id}@${projectId}`); }
    }
  });
}

/** ENGAGE knows `alive-slug` and nothing else. */
const respondOnlyAliveSlug = (url) =>
  (url.endsWith('/slugs/alive-slug') ? LIVE : GONE(url.split('/').pop()));

test('the ENGAGE dead-slug guard', async (t) => {
  await t.test('resolves only isMet periods, and reports the dead one without touching it',
    async () => {
      const deleted = [];
      const summary = await reconcile(['--engage'],
        engageDeps({ respond: respondOnlyAliveSlug, deleted }));

      assert.deepStrictEqual(summary.engageOrphans.dead, ['CP-dead']);
      assert.strictEqual(summary.engageOrphans.checked, 2,
        'the isMet: false period has no engagement and costs no round trip');
      // REPORT-ONLY IS THE DEFAULT. `--engage` sweeps; only `--drop-orphans` writes.
      assert.deepStrictEqual(deleted, []);
      assert.deepStrictEqual(summary.engageOrphans.dropped, []);
    });

  await t.test('--drop-orphans deletes the dead row at its own partition, and only that row',
    async () => {
      const deleted = [];
      const summary = await reconcile(['--drop-orphans'],
        engageDeps({ respond: respondOnlyAliveSlug, deleted }));

      // The partition key rides along: `commentPeriods` is partitioned on the parent, and a delete
      // aimed at the wrong one is a 404 that reads as a successful no-op.
      assert.deepStrictEqual(deleted, ['CP-dead@207']);
      assert.deepStrictEqual(summary.engageOrphans.dropped, ['CP-dead']);
    });

  // THE PRODUCTION HAZARD. `engage.eao.gov.bc.ca` is the single-page app, and its nginx answers 200
  // with index.html for every unknown path — so a check pointed there calls every slug alive, and
  // one pointed at the test host gets 401 for all of them. Neither may ever delete anything.
  await t.test('an answer that is not ENGAGE saying "gone" is UNKNOWN, never an orphan',
    async () => {
      for (const [label, response] of [
        ['SPA index.html on 200', { status: 200, ok: true, text: async () => '<!DOCTYPE html>' }],
        ['basic auth on the test host', { status: 401, ok: false, text: async () => 'nope' }],
        ['a 400 from something that is not ENGAGE',
          { status: 400, ok: false, text: async () => 'Bad Request' }],
        ['a 5xx', { status: 502, ok: false, text: async () => 'gateway' }]
      ]) {
        const deleted = [];
        const summary = await reconcile(['--drop-orphans'],
          engageDeps({ respond: async () => response, deleted }));

        assert.deepStrictEqual(deleted, [], `${label} must delete nothing`);
        assert.deepStrictEqual(summary.engageOrphans.dead, [], `${label} is not an orphan`);
        // A 200 is a LIVE slug and says nothing is wrong; the rest are answers nobody can act on.
        assert.deepStrictEqual(summary.engageOrphans.unknown,
          response.status === 200 ? [] : ['CP-live', 'CP-dead'],
          `${label} is reported as unresolved`);
      }
    });

  await t.test('a thrown fetch is unknown too, not an orphan', async () => {
    const deleted = [];
    const summary = await reconcile(['--drop-orphans'], engageDeps({
      respond: async () => { throw new Error('ENOTFOUND'); }, deleted
    }));

    assert.deepStrictEqual(deleted, []);
    assert.deepStrictEqual(summary.engageOrphans.dead, []);
    assert.strictEqual(summary.engageOrphans.unknown.length, 2);
  });

  // A SLOW ENGAGE IS NOT AN UNREACHABLE ONE. Both are unresolved and both stay untouched, but the
  // report has to tell them apart or a run that is merely slow reads identically to one where the
  // host is down.
  await t.test('a timeout and a network failure are both unknown, for different reasons', async () => {
    const timedOut = await reconcile(['--engage'], engageDeps({
      respond: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    }));
    assert.strictEqual(timedOut.engageOrphans.unknownReasons['CP-live'], 'timeout');
    assert.strictEqual(timedOut.engageOrphans.unknownReasons['CP-dead'], 'timeout');

    const unreachable = await reconcile(['--engage'], engageDeps({
      respond: async () => { throw new Error('ENOTFOUND'); }
    }));
    assert.strictEqual(unreachable.engageOrphans.unknownReasons['CP-live'], 'ENOTFOUND');
    assert.notStrictEqual(
      timedOut.engageOrphans.unknownReasons['CP-live'],
      unreachable.engageOrphans.unknownReasons['CP-live'],
      'the same "unknown" state must not erase which failure caused it');
  });

  await t.test('an isMet period whose metURL carries no slug is unknown, and costs no round trip',
    async () => {
      let calls = 0;
      const summary = await reconcile(['--engage'], engageDeps({
        rows: [{ id: 'CP-nourl', projectId: '207', isMet: true, metURL: '' }],
        respond: async () => { calls++; return LIVE; }
      }));

      assert.strictEqual(calls, 0);
      assert.deepStrictEqual(summary.engageOrphans.unknown, ['CP-nourl']);
      assert.deepStrictEqual(summary.engageOrphans.dead, []);
    });

  await t.test('a reported orphan is drift; a dropped one is not', async () => {
    const reported = await reconcile(['--engage'], engageDeps({ respond: respondOnlyAliveSlug }));
    const dropped = await reconcile(['--drop-orphans'],
      engageDeps({ respond: respondOnlyAliveSlug }));

    assert.strictEqual(reported.drift, dropped.drift + 1,
      'the alert must stay lit while a dead link is still in the mirror, and go out once it is not');
    assert.match(summaryLine(reported), /engageOrphans: dead=1 dropped=0 unknown=0/);
  });

  await t.test('without ENGAGE_API_BASE the sweep does not run, and says so', async () => {
    const summary = await reconcile(['--engage'],
      makeDeps({ engageApiBase: '', fetch: async () => LIVE }));

    assert.strictEqual(summary.engageOrphans, undefined);
    // `skipped`, not zero — the same rule `comments` follows.
    assert.match(summaryLine(summary), /engageOrphans: skipped/);
    assert.ok(summary.failures.some(f => /ENGAGE_API_BASE is unset/.test(f)));
  });

  await t.test('no flag means no ENGAGE traffic at all', async () => {
    let calls = 0;
    const summary = await reconcile([],
      engageDeps({ respond: async () => { calls++; return LIVE; } }));

    assert.strictEqual(calls, 0);
    assert.strictEqual(summary.engageOrphans, undefined);
  });
});

test('slugOf reads the engagement slug off a metURL', async (t) => {
  await t.test('takes the last path segment, whatever rides after it', () => {
    assert.strictEqual(slugOf('https://engage.example/my-engagement'), 'my-engagement');
    assert.strictEqual(slugOf('https://engage.example/e/my-engagement/'), 'my-engagement');
    assert.strictEqual(slugOf('https://engage.example/my-engagement?utm=x'), 'my-engagement');
    assert.strictEqual(slugOf('https://engage.example/my-engagement#top'), 'my-engagement');
    assert.strictEqual(slugOf('https://engage.example/a%20slug'), 'a slug');
  });

  await t.test('answers null rather than a guess when there is no segment', () => {
    const noSlug = ['', null, undefined, '   ', 'https://engage.example', 'https://engage.example/'];
    for (const raw of noSlug) {
      assert.strictEqual(slugOf(raw), null, `${JSON.stringify(raw)} carries no slug`);
    }
  });

  await t.test('answers null, not a throw, on a malformed percent escape', () => {
    assert.strictEqual(slugOf('https://engage.example/bad%zz'), null);
  });
});

test('a malformed metURL escape is unknown, and does not fail the sibling period', async () => {
  const summary = await reconcile(['--engage'], engageDeps({
    rows: [
      { id: 'CP-badescape', projectId: '207', isMet: true, metURL: 'https://engage.example/bad%zz' },
      MET_PERIODS[0]
    ],
    respond: respondOnlyAliveSlug
  }));

  assert.deepStrictEqual(summary.engageOrphans.unknown, ['CP-badescape']);
  // The sibling with a good slug still made its round trip and resolved live.
  assert.strictEqual(summary.engageOrphans.checked, 1);
  assert.deepStrictEqual(summary.engageOrphans.dead, []);
});

/**
 * Users, groups and inspections: eagle-api publishes none of them, so each row is checked against
 * the rule applied to its own stored Eagle read and its stored parent. Every fixture row below is
 * what the mirror writes, except the ones named as planted drift.
 */
test('the user, group and inspection mirrors are checked against their stored Eagle copy', async (t) => {
  const projectsWithRead = {
    listWithEagleId: async () => [{ id: '207', eagleId: 'P1', sourceSystem: 'track', read: ['staff', 'idir', 'public'] }],
    countWithEagleId: async () => 1
  };
  const cleanUser = { id: 'U-ok', read: ['sysadmin', 'staff'], isPublished: false, eagleRead: ['sysadmin'] };
  const cleanChain = [
    { id: 'I1', kind: 'Inspection', projectId: '207', inspection: 'I1', read: ['staff'], isPublished: false, eagleRead: ['sysadmin', 'inspector'] },
    { id: 'E1', kind: 'InspectionElement', projectId: '207', inspection: 'I1', read: ['staff'], isPublished: false, eagleRead: ['sysadmin', 'inspector'] },
    { id: 'IT1', kind: 'InspectionItem', projectId: '207', inspection: 'I1', element: 'E1', read: ['staff'], isPublished: false, eagleRead: ['sysadmin', 'inspector'] }
  ];
  const deps = (over) => makeDeps({ projects: projectsWithRead, ...over });

  await t.test('a clean set reports nothing', async () => {
    const summary = await reconcile([], deps({
      users: storedRows([cleanUser]),
      groups: storedRows([{ id: 'G1', projectId: '207', read: ['staff'], isPublished: false, eagleRead: ['sysadmin'] }]),
      inspections: storedRows(cleanChain)
    }));
    for (const label of ['users', 'groups', 'inspections', 'inspectionElements', 'inspectionItems']) {
      assert.deepStrictEqual(summary[label].aclMismatch, [], label);
      assert.deepStrictEqual(summary[label].missingParent, [], label);
    }
  });

  await t.test('a user stored public that Eagle keeps at sysadmin is drift', async () => {
    const planted = { id: 'U-leak', read: ['staff', 'idir', 'public'], isPublished: true, eagleRead: ['sysadmin'] };
    const summary = await reconcile([], deps({ users: storedRows([cleanUser, planted]) }));
    assert.deepStrictEqual(summary.users.aclMismatch, ['U-leak']);
    assert.match(summaryLine(summary), /users: aclMismatch=1 missingParent=0 /);
    assert.match(report(summary), /users: 2 mirrored in DEMI[\s\S]*aclMismatch[^\n]*: 1 — U-leak/);
  });

  await t.test('an item wider than its element is drift, and so is one whose element is gone', async () => {
    const wider = { ...cleanChain[2], id: 'IT-wide', read: ['staff', 'idir'], eagleRead: ['public'] };
    const orphan = { ...cleanChain[2], id: 'IT-orphan', element: 'E-gone' };
    const summary = await reconcile([], deps({ inspections: storedRows([...cleanChain, wider, orphan]) }));
    assert.deepStrictEqual(summary.inspectionItems.aclMismatch, ['IT-wide']);
    assert.deepStrictEqual(summary.inspectionItems.missingParent, ['IT-orphan']);
    const clean = await reconcile([], deps({ inspections: storedRows(cleanChain) }));
    assert.strictEqual(summary.drift - clean.drift, 2, 'both reach the alert total');
  });

  const failing = (container, err) => ({ CONTAINER: container, listAclRows: async () => { throw err; } });

  await t.test('a container not provisioned yet reads `skipped`; the rest of the run still reports', async () => {
    const notFound = Object.assign(new Error('Resource Not Found'), { code: 404 });
    const summary = await reconcile([], deps({
      users: failing('users', notFound),
      inspections: failing('inspections', notFound),
      groups: storedRows([{ id: 'G1', projectId: '207', read: ['staff', 'idir', 'public'], isPublished: true, eagleRead: ['sysadmin'] }])
    }));
    assert.strictEqual(summary.users, undefined);
    assert.strictEqual(summary.inspectionItems, undefined);
    assert.deepStrictEqual(summary.groups.aclMismatch, ['G1'], 'a provisioned kind is still checked');
    assert.ok(summary.documents.unpublishedOrDeleted.length > 0, 'the Eagle-diffed kinds still report');
    const line = summaryLine(summary);
    assert.match(line, /users: skipped groups: aclMismatch=1 missingParent=0 inspections: skipped /);
    assert.match(line, /inspectionItems: skipped /);
  });

  await t.test('any other error from those containers still fails the run', async () => {
    const throttled = Object.assign(new Error('throttled'), { code: 429 });
    await assert.rejects(reconcile([], deps({ users: failing('users', throttled) })), /throttled/);
  });

  await t.test('a deleted row is held to the deleted ceiling, not to its Eagle read', async () => {
    const deleted = { id: 'U-del', read: ['staff'], isPublished: false, isDeleted: true, eagleRead: ['public', 'sysadmin'] };
    const summary = await reconcile([], deps({ users: storedRows([deleted]) }));
    assert.deepStrictEqual(summary.users.aclMismatch, []);
  });
});

/** ENGAGE-owned periods belong to reconcile-engage.js: Eagle holds only the copy DEMI sent it. */
test('ENGAGE-owned periods stay out of the Eagle diff', async (t) => {
  const ENGAGE_ROW = {
    id: 'engage-42', projectId: '207', sourceSystem: 'engage', eagleId: 'CP-E', isMet: true,
    metURL: 'https://engage.example/dead-slug'
  };
  const withEngageRow = (extra = {}) => engageDeps({
    rows: [...PERIOD_ROWS[207], ENGAGE_ROW], respond: respondOnlyAliveSlug, ...extra
  });

  await t.test('neither the row nor its Eagle copy is drift, and the row is counted apart', async () => {
    const deps = withEngageRow();
    deps.sources = stubSources({}, {
      ...EAGLE_BY_DATASET, CommentPeriod: [{ _id: 'CP1', project: 'P1' }, { _id: 'CP-E', project: 'P1' }]
    });
    const summary = await reconcile([], deps);

    assert.strictEqual(summary.commentPeriods.engageOwned, 1);
    assert.strictEqual(summary.commentPeriods.inDemi, 1);
    assert.deepStrictEqual(summary.commentPeriods.unpublishedOrDeleted, []);
    assert.deepStrictEqual(summary.commentPeriods.eagleOnly, []);
    assert.deepStrictEqual(summary.failures, [], 'the truncation guard still counts the ENGAGE row');
    assert.match(report(summary), /engageOwned \(ENGAGE-owned, left out of this diff and never dropped\): 1/);
  });

  await t.test('--drop-orphans never deletes one, even when its slug is gone', async () => {
    const deleted = [];
    const summary = await reconcile(['--drop-orphans'], withEngageRow({ deleted }));

    assert.deepStrictEqual(deleted, []);
    assert.deepStrictEqual(summary.engageOrphans.dead, []);
    assert.strictEqual(summary.engageOrphans.checked, 0);
  });
});
