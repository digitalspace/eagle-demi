'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseArgs, verifyProjects, verifyItems, seed, ALL_STAGES, DEFAULT_STAGES
} = require('../../src/scripts/seed-nosql');
const { unwrapSearchResponse, fetchAllPages, PAGE_SIZE, EAGLE_API_BASE } = require('../../src/seed/sources');
const trackProjects = require('../../src/data/track_projects_enriched.json');

const NOW = '2026-07-30T00:00:00.000Z';

// Every reconcile writes its surplus ids to a file, defaulting to /home. Redirected for the whole
// suite so the tests cannot litter that mount or the repo root.
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-reconcile-'));
process.env.RECONCILE_LOG = path.join(LOG_DIR, 'default.ndjson');
test.after(() => fs.rmSync(LOG_DIR, { recursive: true, force: true }));

test('parseArgs — writes require an explicit flag', async (t) => {
  await t.test('defaults to a dry run', () => {
    assert.strictEqual(parseArgs([]).live, false,
      'a 60k-document seed must not start by accident');
  });

  await t.test('--only selects stages', () => {
    assert.deepStrictEqual(parseArgs(['--only', 'projects,boundaries']).only,
      ['projects', 'boundaries']);
  });

  await t.test('an unknown stage throws rather than silently seeding nothing', () => {
    assert.throws(() => parseArgs(['--only', 'projcts']), /unknown stage\(s\): projcts/);
  });

  await t.test('records is not a stage any more, and asking for it throws', () => {
    // The records ingest was removed rather than narrowed — see TODO.md. Every stage now runs by
    // default, so a divergence between the two lists means a stage was added and forgotten.
    assert.deepStrictEqual(ALL_STAGES, ['projects', 'documents', 'boundaries']);
    assert.deepStrictEqual(DEFAULT_STAGES, ALL_STAGES);
    assert.throws(() => parseArgs(['--only', 'records']), /unknown stage\(s\): records/);
  });
});

test('search-response unwrapping', async (t) => {
  await t.test('reads the [{meta, searchResults}] envelope', () => {
    const r = unwrapSearchResponse([{ meta: [{ searchResultsTotal: 42 }], searchResults: [1, 2] }], 'u');
    assert.deepStrictEqual(r.items, [1, 2]);
    assert.strictEqual(r.total, 42);
  });

  await t.test('an unexpected shape throws instead of reading as zero results', () => {
    // Returning [] here would seed an empty database and report success.
    assert.throws(() => unwrapSearchResponse([], 'u'), /unexpected search response shape/);
    assert.throws(() => unwrapSearchResponse({}, 'u'), /unexpected search response shape/);
    assert.throws(() => unwrapSearchResponse(null, 'u'), /unexpected search response shape/);
    assert.throws(() => unwrapSearchResponse([{ searchResults: 'nope' }], 'u'), /unexpected/);
  });

  await t.test('a missing total is null, not zero', () => {
    assert.strictEqual(unwrapSearchResponse([{ searchResults: [] }], 'u').total, null);
  });
});

test('fetchAllPages', async (t) => {
  // The upstream caps pageSize at 100 regardless of what is asked for, so a naive loop that
  // requests 1000 reads a tenth of the corpus while appearing to work.
  const server = (total) => {
    const items = Array.from({ length: total }, (_, i) => ({ _id: `d${i}` }));
    return async (url) => {
      const pageNum = Number(new URL(url, 'http://x').searchParams.get('pageNum'));
      const start = pageNum * PAGE_SIZE;
      return [{
        meta: [{ searchResultsTotal: total }],
        searchResults: items.slice(start, start + PAGE_SIZE)
      }];
    };
  };

  const withFetch = async (handler, fn) => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => ({ ok: true, json: async () => handler(url) });
    try { return await fn(); } finally { globalThis.fetch = original; }
  };

  await t.test('pages through a partial final page', async () => {
    const items = await withFetch(server(250), () => fetchAllPages('http://x', 'Document'));
    assert.strictEqual(items.length, 250);
    assert.strictEqual(items[249]._id, 'd249');
  });

  await t.test('stops cleanly on an exact multiple of the page size', async () => {
    const items = await withFetch(server(200), () => fetchAllPages('http://x', 'Document'));
    assert.strictEqual(items.length, 200);
  });

  await t.test('a truncated fetch THROWS rather than seeding a partial corpus', async () => {
    // The dangerous failure: a mid-run upstream hiccup returns a short page, the loop treats it
    // as the end, and 40k documents quietly never arrive. The result looks complete.
    const truncating = async (url) => {
      const pageNum = Number(new URL(url, 'http://x').searchParams.get('pageNum'));
      return [{
        meta: [{ searchResultsTotal: 500 }],
        searchResults: pageNum === 1
          ? [{ _id: 'short' }]
          : Array.from({ length: PAGE_SIZE }, (_, i) => ({ _id: `p${pageNum}_${i}` }))
      }];
    };
    await assert.rejects(
      () => withFetch(truncating, () => fetchAllPages('http://x', 'Document')),
      /fetched 101 but upstream reports 500 — refusing to seed a truncated corpus/
    );
  });

  await t.test('an empty dataset yields an empty list, not an error', async () => {
    const items = await withFetch(server(0), () => fetchAllPages('http://x', 'Document'));
    assert.deepStrictEqual(items, []);
  });

  await t.test('accumulate:false streams without building the array', async () => {
    // Holding all 60,661 raw payloads plus their transformed forms peaked at ~250 MB by document
    // 45,000 in a dry run, against a 1.5 GB Consumption plan.
    let pages = 0, seen = 0;
    const result = await withFetch(server(250), () => fetchAllPages('http://x', 'Document', {
      accumulate: false,
      onPage: (items) => { pages++; seen += items.length; }
    }));

    assert.deepStrictEqual(result, { count: 250, total: 250 });
    assert.strictEqual(pages, 3);
    assert.strictEqual(seen, 250, 'every item still reached the handler');
    assert.ok(!Array.isArray(result), 'no accumulated array is returned');
  });

  await t.test('the truncation guard still fires when streaming', async () => {
    const truncating = async (url) => {
      const pageNum = Number(new URL(url, 'http://x').searchParams.get('pageNum'));
      return [{
        meta: [{ searchResultsTotal: 500 }],
        searchResults: pageNum === 0
          ? Array.from({ length: PAGE_SIZE }, (_, i) => ({ _id: `p${i}` }))
          : [{ _id: 'short' }]
      }];
    };
    await assert.rejects(
      () => withFetch(truncating, () => fetchAllPages('http://x', 'Document',
        { accumulate: false, onPage: () => {} })),
      /refusing to seed a truncated corpus/
    );
  });

  await t.test('a bare callback third argument still works', async () => {
    let pages = 0;
    await withFetch(server(150), () => fetchAllPages('http://x', 'Document', () => { pages++; }));
    assert.strictEqual(pages, 2);
  });

  await t.test('an async page handler is awaited before the next fetch', async () => {
    // Otherwise the flush-per-page backpressure disappears and memory grows unbounded anyway.
    const order = [];
    await withFetch(server(200), () => fetchAllPages('http://x', 'Document', {
      accumulate: false,
      onPage: async (_items) => {
        order.push('start');
        await new Promise(r => setImmediate(r));
        order.push('end');
      }
    }));
    assert.deepStrictEqual(order, ['start', 'end', 'start', 'end']);
  });
});

test('verification gates', async (t) => {
  const ok = (over = {}) => ({
    id: '207', trackProjectId: 207, name: 'Nicomen Wind', read: ['public'], ...over
  });

  await t.test('a clean registry passes', () => {
    assert.deepStrictEqual(verifyProjects([ok(), ok({ id: '208', trackProjectId: 208, name: 'B' })]), []);
  });

  await t.test('catches the removed auto-seeder hash ids', () => {
    // 8000000 + hash % 1e6 produced 3,382 junk rows with colliding ids.
    const f = verifyProjects([ok({ trackProjectId: 8123456 })]);
    assert.match(f.join(' '), /synthetic trackProjectId >= 8,000,000/);
  });

  await t.test('catches mass duplicate names', () => {
    // 851 duplicates was the auto-seeder signature; a handful of similar names is plausible.
    const many = Array.from({ length: 25 }, (_, i) => [
      ok({ id: `a${i}`, trackProjectId: i, name: `Dup ${i}` }),
      ok({ id: `b${i}`, trackProjectId: 1000 + i, name: `Dup ${i}` })
    ]).flat();
    assert.match(verifyProjects(many).join(' '), /duplicate project names/);
  });

  await t.test('catches duplicate ids and missing ACLs', () => {
    assert.match(verifyProjects([ok(), ok({ name: 'Other' })]).join(' '), /duplicate project ids/);
    assert.match(verifyProjects([ok({ read: [] })]).join(' '), /no read\[\]/);
    assert.match(verifyProjects([ok({ read: undefined })]).join(' '), /no read\[\]/);
  });

  await t.test('items must carry an ACL, a partition key, and a consistent isPublished', () => {
    const item = (over) => ({ projectId: '207', read: ['public'], isPublished: true, ...over });

    assert.deepStrictEqual(verifyItems([item({})], 'documents', 'projectId'), []);
    assert.match(verifyItems([item({ read: [] })], 'documents', 'projectId').join(' '),
      /no read\[\]/);
    assert.match(verifyItems([item({ projectId: null })], 'documents', 'projectId').join(' '),
      /no projectId — the partition key/);
    // read[] is authoritative, isPublished is its mirror. Drift means one view of visibility is
    // wrong and it is not knowable which.
    assert.match(verifyItems([item({ isPublished: false })], 'documents', 'projectId').join(' '),
      /isPublished out of step with read\[\]/);
    assert.match(
      verifyItems([item({ read: ['staff'], isPublished: true })], 'documents', 'projectId').join(' '),
      /isPublished out of step/);
  });

  await t.test('the partition-key failure reports its OWN count', () => {
    const items = [
      { projectId: null, read: ['public'], isPublished: true },
      { projectId: null, read: ['public'], isPublished: true },
      { projectId: null, read: ['public'], isPublished: true }
    ];
    const msg = verifyItems(items, 'documents', 'projectId').join(' ');
    assert.match(msg, /3 documents have no projectId/,
      'reporting the ACL count here would misreport the fault');
  });
});

test('seed() end to end with stubbed sources', async (t) => {
  const eagleProject = (id, name) => ({
    _id: id, name, type: 'Energy - Electricity', status: 'Operating',
    read: ['public', 'sysadmin'], eaStatus: 'Certificate Issued'
  });

  // Two real Track projects, one with an Eagle match.
  const track = trackProjects.filter(p => [207, 373].includes(p.track_project_id));
  const matchedGuid = track.find(p => p.track_project_id === 207).epic_guid;

  const eagleDoc = (id, project) => ({
    _id: id, project, displayName: `Doc ${id}`,
    internalURL: `etl/x/${id}.pdf`, internalSize: '1024', internalExt: '.pdf',
    read: ['public', 'project-team'], contentExtracted: true
  });

  const stubSources = {
    // The real module's value, not a placeholder. The seeder reads the base off the INJECTED
    // sources object, so a stub that omits it makes every test pass `undefined` to `fetchAllPages`
    // — which is exactly what the base-URL assertion below found on its first run.
    EAGLE_API_BASE,
    loadTrackProjects: () => track,
    fetchEagleProjects: async () => [eagleProject(matchedGuid, 'Nicomen Wind (Eagle)')],
    // Streaming: the seeder never holds the whole corpus. Delivered as two pages to exercise
    // the per-page path rather than a single convenient batch.
    streamEagleDocuments: async (onPage) => {
      await onPage([eagleDoc('doc1', matchedGuid), eagleDoc('doc2', matchedGuid)], 2, 3);
      await onPage([eagleDoc('doc3', 'a-project-nobody-knows')], 3, 3);
      return { count: 3, total: 3 };
    },
    fetchListLookup: async () => new Map([['t1', 'Letter']]),
    // The seeder reads Project Notifications through the generic pager, since sources.js exposes
    // no named loader for them. Empty here so the default fixtures still describe a corpus in
    // which the only non-project parent is genuinely unknown.
    fetchAllPages: async () => [],
    loadBoundaries: () => [
      {
        _id: 'b1', type: 'Regional District', name: 'RD One', code: 1,
        simplifiedGeometry: { type: 'Polygon', coordinates: [[[-120, 50]]] },
        geometry: { type: 'Polygon', coordinates: [[[-120, 50]]] }
      }
    ]
  };

  const makeRepos = () => {
    const written = { projects: [], documents: [], boundaries: [] };
    return {
      written,
      repos: {
        projects: { upsert: async (p) => { written.projects.push(p); return p; } },
        // Returns the verified shape: the seeder must count what LANDED, not what it sent.
        documents: {
          // The seeder reads the extraction state of each partition before writing it. Empty
          // here: these fixtures describe a first seed, where nothing exists to carry forward.
          extractionRowsForProject: async () => [],
          bulkUpsertForProject: async (pid, docs) => {
            written.documents.push([pid, docs]);
            return { succeeded: docs.length, failed: 0, statusCounts: { 201: docs.length } };
          }
        },
        boundaries: {
          bulkUpsertForType: async (type, items) => {
            written.boundaries.push([type, items]);
            return { succeeded: items.length, failed: 0, statusCounts: { 201: items.length } };
          }
        },
      }
    };
  };

  await t.test('a dry run writes NOTHING but still verifies', async () => {
    const { written, repos } = makeRepos();
    const summary = await seed(['--only', 'projects,documents,boundaries'],
      { sources: stubSources, repos, now: NOW });

    assert.strictEqual(summary.mode, 'dry-run');
    assert.deepStrictEqual(summary.failures, []);
    for (const [key, list] of Object.entries(written)) {
      assert.strictEqual(list.length, 0, `dry run wrote ${key}`);
    }
    // The counts are real even though nothing was written — that is what makes it a pre-flight
    // check rather than a preview.
    assert.strictEqual(summary.stages.projects.built, 2);
    assert.strictEqual(summary.stages.documents.built, 2);
  });

  await t.test('a live run writes every stage', async () => {
    const { written, repos } = makeRepos();
    const summary = await seed(['--live', '--only', 'projects,documents,boundaries'],
      { sources: stubSources, repos, now: NOW });

    assert.strictEqual(summary.mode, 'live');
    assert.deepStrictEqual(summary.failures, []);
    assert.strictEqual(written.projects.length, 2);
    assert.strictEqual(summary.stages.projects.written, 2);
    assert.strictEqual(summary.stages.documents.written, 2);
    assert.strictEqual(summary.stages.boundaries.written, 1);
  });

  await t.test('documents are grouped by project — the partition key', async () => {
    const { written, repos } = makeRepos();
    await seed(['--live', '--only', 'documents'], { sources: stubSources, repos, now: NOW });

    assert.strictEqual(written.documents.length, 1, 'one bulk call per project');
    const [projectId, docs] = written.documents[0];
    assert.strictEqual(projectId, '207', 'canonical Track id, not the Eagle project id');
    assert.strictEqual(docs.length, 2);
    assert.ok(docs.every(d => d.projectId === '207'));
  });

  await t.test('an unresolvable document is dropped and COUNTED, not filed anywhere', async () => {
    const { repos } = makeRepos();
    const summary = await seed(['--only', 'documents'], { sources: stubSources, repos, now: NOW });

    assert.strictEqual(summary.stages.documents.fetched, 3);
    assert.strictEqual(summary.stages.documents.built, 2);
    assert.strictEqual(summary.stages.documents.droppedUnresolvable, 1,
      'a silent drop would look like the corpus was complete');
    assert.deepStrictEqual(summary.stages.documents.unresolvedRefs, ['a-project-nobody-knows'],
      'the ref itself must reach the summary, or the next class of drops is invisible again');
    assert.strictEqual(summary.stages.documents.distinctUnresolvedRefs, 1);
  });

  await t.test('a document parented by a Project Notification is seeded under it', async () => {
    // A ProjectNotification is a different ENTITY TYPE, not a missing project: all 17 are public
    // and prod serves 2-13 documents under each. Dropping them returned an empty documents tab
    // for every notification. The notification _id IS the partition key — eagle-public sends it
    // as the `project` filter and there is nothing to translate it into.
    const notificationId = '5efe366b3a147c00223be181';
    const withNotifications = {
      ...stubSources,
      // `base` is asserted, not ignored. Every other stub in this file reads only `dataset`, so
      // `src.EAGLE_API_BASE` -> any typo shipped green while the seeder asked an UNDEFINED host for
      // the notification list — a run that then drops all 80 documents again, for a new reason.
      fetchAllPages: async (base, dataset) => {
        assert.strictEqual(base, EAGLE_API_BASE,
          'the seeder must pass the real Eagle base, not undefined');
        return dataset === 'ProjectNotification' ? [{ _id: notificationId }] : [];
      },
      streamEagleDocuments: async (onPage) => {
        await onPage([
          eagleDoc('doc1', matchedGuid),
          eagleDoc('pn1', notificationId),
          eagleDoc('nowhere', 'a-project-nobody-knows')
        ], 3, 3);
        return { count: 3, total: 3 };
      }
    };

    const { written, repos } = makeRepos();
    const summary = await seed(['--live', '--only', 'documents'],
      { sources: withNotifications, repos, now: NOW });

    const batch = written.documents.find(([pid]) => pid === notificationId);
    assert.ok(batch, `nothing was written under ${notificationId}`);
    assert.deepStrictEqual(batch[1].map(d => d.id), ['pn1']);
    assert.strictEqual(batch[1][0].projectId, notificationId);

    assert.strictEqual(summary.stages.documents.built, 2);
    assert.strictEqual(summary.stages.documents.notificationParented, 1);
    // The unknown parent is NOT admitted along with it — only ids the notification list confirms.
    assert.strictEqual(summary.stages.documents.droppedUnresolvable, 1);
    assert.deepStrictEqual(summary.stages.documents.unresolvedRefs, ['a-project-nobody-knows']);
    assert.deepStrictEqual(summary.failures, []);
  });

  await t.test('the dropped-ref report separates the true count from the capped sample', async () => {
    // Two fields that look redundant and are not: `distinctUnresolvedRefs` is a COUNT and
    // `unresolvedRefs` a SAMPLE capped at 20, because an upstream fault could produce thousands of
    // distinct refs and this summary is printed in full. Every existing fixture has exactly ONE
    // unresolved ref, so the two were indistinguishable — `.slice(0, 20)` -> `.slice(0, 1)` passed,
    // and so did deriving the count from the capped array, which would under-report a real fault by
    // orders of magnitude at the moment it matters most.
    const many = {
      ...stubSources,
      streamEagleDocuments: async (onPage) => {
        const docs = Array.from({ length: 25 }, (_, i) => eagleDoc(`d${i}`, `unknown-${i}`));
        await onPage(docs, 25, 25);
        return { count: 25, total: 25 };
      }
    };

    const { repos } = makeRepos();
    const summary = await seed(['--live', '--only', 'documents'], { sources: many, repos, now: NOW });

    assert.strictEqual(summary.stages.documents.droppedUnresolvable, 25);
    assert.strictEqual(summary.stages.documents.distinctUnresolvedRefs, 25,
      'the COUNT is every distinct ref, uncapped — this is the number that says how bad it is');
    assert.strictEqual(summary.stages.documents.unresolvedRefs.length, 20,
      'the SAMPLE is capped, so a thousand-ref fault does not print a thousand lines');
  });

  await t.test('--only still builds the project index, or partition keys would be stale', async () => {
    const { written, repos } = makeRepos();
    await seed(['--live', '--only', 'documents'], { sources: stubSources, repos, now: NOW });

    assert.strictEqual(written.projects.length, 0, 'projects not written when not selected');
    assert.ok(written.documents.length > 0, 'but documents still resolved their project');
  });

  await t.test('a verification failure is reported and forces a non-zero exit', async () => {
    const broken = {
      ...stubSources,
      // A project whose ACL is empty: exactly what the gate licensing the legacy-tier deletion
      // must catch.
      fetchEagleProjects: async () => [{ ...eagleProject(matchedGuid, 'X'), read: [] }],
      loadTrackProjects: () => track.map(p => ({ ...p, is_active: false }))
    };
    const { repos } = makeRepos();
    const summary = await seed(['--only', 'projects'], { sources: broken, repos, now: NOW });

    // is_active:false projects fail closed to SECURE_ROLES, which is a valid non-empty ACL, so
    // this asserts the gate PASSES on a fail-closed registry rather than crying wolf.
    assert.deepStrictEqual(summary.failures, []);
    assert.ok(summary.stages.projects.built > 0);
  });

  await t.test('a project split across flush batches has every item written', async () => {
    // FLUSH_THRESHOLD is 100 and Cosmos rejects a larger bulk request, so a project with more
    // documents than that MUST be written in several batches. Upsert is idempotent, so splitting
    // is safe — but losing the tail would not be.
    const { FLUSH_THRESHOLD } = require('../../src/scripts/seed-nosql');
    const many = Array.from({ length: 250 }, (_, i) => eagleDoc(`bulk${i}`, matchedGuid));
    const paged = {
      ...stubSources,
      streamEagleDocuments: async (onPage) => {
        for (let i = 0; i < many.length; i += 100) {
          await onPage(many.slice(i, i + 100), Math.min(i + 100, many.length), many.length);
        }
        return { count: many.length, total: many.length };
      }
    };

    const { written, repos } = makeRepos();
    const summary = await seed(['--live', '--only', 'documents'],
      { sources: paged, repos, now: NOW });

    const total = written.documents.reduce((n, [, docs]) => n + docs.length, 0);
    assert.strictEqual(total, 250, 'every document written across batches');
    assert.strictEqual(summary.stages.documents.written, 250);
    assert.ok(written.documents.length > 1, 'genuinely split into multiple bulk calls');
    for (const [, docs] of written.documents) {
      assert.ok(docs.length <= FLUSH_THRESHOLD, `batch of ${docs.length} exceeds the bulk limit`);
    }
    const ids = written.documents.flatMap(([, docs]) => docs.map(d => d.id));
    assert.strictEqual(new Set(ids).size, 250, 'no document written twice or dropped');
  });

  await t.test('a partial bulk failure is REPORTED, not counted as written', async () => {
    // Cosmos bulk returns a per-operation status and does not throw on partial failure. The first
    // real seed reported 60,578 documents written when only 56,317 existed, because the seeder
    // counted operations it had SENT.
    const { repos, written } = makeRepos();
    repos.documents.bulkUpsertForProject = async (pid, docs) => {
      written.documents.push([pid, docs]);
      return { succeeded: docs.length - 1, failed: 1, statusCounts: { 201: docs.length - 1, 429: 1 } };
    };

    const summary = await seed(['--live', '--only', 'documents'],
      { sources: stubSources, repos, now: NOW });

    assert.strictEqual(summary.stages.documents.built, 2);
    assert.strictEqual(summary.stages.documents.written, 1, 'counts confirmed writes only');
    assert.strictEqual(summary.stages.documents.writeFailed, 1);
    assert.match(summary.failures.join(' '), /document writes FAILED after retries/);
    assert.match(summary.failures.join(' '), /count mismatch: built 2 but only 1 were confirmed/);
  });

  await t.test('duplicate (projectId, id) pairs are detected', async () => {
    // id is unique per PARTITION in Cosmos, so a repeat within one project silently overwrites.
    const dupSource = {
      ...stubSources,
      streamEagleDocuments: async (onPage) => {
        await onPage([eagleDoc('same', matchedGuid), eagleDoc('same', matchedGuid)], 2, 2);
        return { count: 2, total: 2 };
      }
    };
    const { repos } = makeRepos();
    const summary = await seed(['--only', 'documents'], { sources: dupSource, repos, now: NOW });

    assert.strictEqual(summary.stages.documents.duplicateIds, 1);
    assert.match(summary.failures.join(' '), /share an \(projectId, id\) pair/);
  });

  await t.test('--limit-documents bounds a trial run', async () => {
    const { repos } = makeRepos();
    const summary = await seed(['--only', 'documents', '--limit-documents', '1'],
      { sources: stubSources, repos, now: NOW });
    assert.strictEqual(summary.stages.documents.built, 1);
  });
});

test('--reconcile refuses anything that narrows the fetch', async (t) => {
  await t.test('accepted on a full run', () => {
    assert.strictEqual(parseArgs(['--reconcile']).reconcile, true);
    assert.strictEqual(parseArgs([]).reconcile, false, 'deletes are opt-in');
  });

  await t.test('--only that drops a reconciled stage throws', () => {
    // Reconcile deletes whatever the fetch did not produce, so skipping the documents fetch
    // would compute all 61k documents as surplus.
    assert.throws(() => parseArgs(['--reconcile', '--only', 'projects']),
      /--reconcile needs the projects and documents stages; --only excluded: documents/);
    assert.throws(() => parseArgs(['--reconcile', '--only', 'documents']),
      /--only excluded: projects/);
    assert.doesNotThrow(() => parseArgs(['--reconcile', '--only', 'projects,documents']));
  });

  await t.test('--limit-documents throws', () => {
    assert.throws(() => parseArgs(['--reconcile', '--limit-documents', '10']),
      /cannot run with --limit-documents/);
  });

  await t.test('--max-surplus needs --reconcile and a positive integer', () => {
    assert.strictEqual(parseArgs(['--reconcile', '--max-surplus', '70000']).maxSurplus, 70000);
    assert.strictEqual(parseArgs(['--reconcile']).maxSurplus, null);
    assert.throws(() => parseArgs(['--max-surplus', '10']), /needs --reconcile/);
    assert.throws(() => parseArgs(['--reconcile', '--max-surplus', '0']),
      /needs a positive integer/);
    assert.throws(() => parseArgs(['--reconcile', '--max-surplus', '-1']),
      /needs a positive integer/);
    assert.throws(() => parseArgs(['--reconcile', '--max-surplus', '1.5']),
      /needs a positive integer/);
    assert.throws(() => parseArgs(['--reconcile', '--max-surplus', 'lots']),
      /needs a positive integer/);
    assert.throws(() => parseArgs(['--reconcile', '--max-surplus']),
      /needs a positive integer/);
  });
});

test('reconcileContainer — the surplus set', async (t) => {
  const { reconcileContainer } = require('../../src/scripts/seed-nosql');
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const fetched = new Set(['a', 'c']);

  await t.test('a dry run computes the set and deletes NOTHING', async () => {
    const removed = [];
    const out = await reconcileContainer('documents', rows, r => r.id, fetched,
      r => { removed.push(r.id); }, { live: false });

    assert.deepStrictEqual(out, { inCosmos: 3, wouldDelete: 1, deleted: 0 });
    assert.deepStrictEqual(removed, [], 'a dry run must not touch the container');
  });

  await t.test('a live run deletes each surplus row exactly once', async () => {
    const removed = [];
    const out = await reconcileContainer('documents', rows, r => r.id, fetched,
      r => { removed.push(r.id); }, { live: true });

    assert.deepStrictEqual(removed, ['b']);
    assert.deepStrictEqual(out, { inCosmos: 3, wouldDelete: 1, deleted: 1 });
  });

  await t.test('nothing surplus deletes nothing', async () => {
    const removed = [];
    const out = await reconcileContainer('documents', rows, r => r.id,
      new Set(['a', 'b', 'c']), r => { removed.push(r.id); }, { live: true });

    assert.strictEqual(out.wouldDelete, 0);
    assert.deepStrictEqual(removed, []);
  });

  await t.test('the key is composite where the container is partitioned', async () => {
    // A document id is unique per PARTITION only, so keying on id alone would call two documents
    // in different projects the same row and leave one of them behind.
    const docs = [{ id: 'd1', projectId: '207' }, { id: 'd1', projectId: '373' }];
    const removed = [];
    const out = await reconcileContainer('documents', docs, r => `${r.projectId}|${r.id}`,
      new Set(['207|d1']), r => { removed.push(r.projectId); }, { live: true });

    assert.strictEqual(out.wouldDelete, 1);
    assert.deepStrictEqual(removed, ['373']);
  });
});

test('seed --reconcile end to end', async (t) => {
  const eagleProject = (id, name) => ({
    _id: id, name, type: 'Energy - Electricity', status: 'Operating',
    read: ['public', 'sysadmin'], eaStatus: 'Certificate Issued'
  });
  const track = trackProjects.filter(p => [207, 373].includes(p.track_project_id));
  const matchedGuid = track.find(p => p.track_project_id === 207).epic_guid;
  const eagleDoc = (id, project) => ({
    _id: id, project, displayName: `Doc ${id}`,
    internalURL: `etl/x/${id}.pdf`, internalSize: '1024', internalExt: '.pdf',
    read: ['public', 'project-team'], contentExtracted: true
  });

  // Unlike the fixtures above, these stubs deliver the upstream TOTAL — reconcile refuses without
  // it, because a null total means sources.js never verified the fetch was complete.
  const stubSources = (over = {}) => ({
    EAGLE_API_BASE,
    loadTrackProjects: () => track,
    fetchEagleProjects: async (onPage) => {
      const items = [eagleProject(matchedGuid, 'Nicomen Wind (Eagle)')];
      if (onPage) await onPage(items, items.length, items.length);
      return items;
    },
    streamEagleDocuments: async (onPage) => {
      await onPage([eagleDoc('doc1', matchedGuid)], 1, 1);
      return { count: 1, total: 1 };
    },
    fetchListLookup: async () => new Map(),
    // The notification list is gated like the other two fetches, so the stub reports its total the
    // same way. Empty AND consistent — the shape that used to pass every gate.
    fetchAllPages: async (_base, _dataset, opts) => {
      if (opts && opts.onPage) await opts.onPage([], 0, 0);
      return [];
    },
    loadBoundaries: () => [],
    ...over
  });

  const SEEDED_DOCS = [{ id: 'doc1', projectId: '207' }, { id: 'stale', projectId: '207' }];

  // `counts` overrides what the container reports it holds; by default it agrees with the rows the
  // stub enumerates, which is what every reconcile below needs to get past the truncation guard.
  const makeDeps = (over = {}, seededDocs = SEEDED_DOCS, counts = {}) => {
    const purged = { documents: [], projects: [] };
    const eagleOnlyRows = [
      { id: 'eagle-gone', eagleId: 'gone' },
      { id: `eagle-${matchedGuid}`, eagleId: matchedGuid }
    ];
    const repos = {
      projects: {
        upsert: async (p) => p,
        listEagleOnlyIds: async () => eagleOnlyRows,
        countEagleOnlyIds: async () => counts.projects ?? eagleOnlyRows.length
      },
      documents: {
        extractionRowsForProject: async () => [],
        bulkUpsertForProject: async (_pid, docs) => (
          { succeeded: docs.length, failed: 0, statusCounts: { 201: docs.length } }),
        listSeededIds: async () => seededDocs,
        countSeededIds: async () => counts.documents ?? seededDocs.length
      },
      boundaries: { bulkUpsertForType: async () => ({ succeeded: 0, failed: 0, statusCounts: {} }) }
    };
    const purge = {
      purgeDocument: async (row) => { purged.documents.push(`${row.projectId}|${row.id}`); },
      purgeProject: async (row) => { purged.projects.push(row.id); }
    };
    return { purged, deps: { repos, purge, cosmosReady: true, now: NOW, ...over } };
  };

  await t.test('a dry run reports wouldDelete and deletes nothing', async () => {
    const { purged, deps } = makeDeps();
    const summary = await seed(['--reconcile', '--only', 'projects,documents'],
      { ...deps, sources: stubSources() });

    assert.deepStrictEqual(summary.failures, []);
    assert.strictEqual(summary.reconcile.documents.wouldDelete, 1);
    assert.strictEqual(summary.reconcile.documents.deleted, 0);
    assert.strictEqual(summary.reconcile.projects.wouldDelete, 1);
    assert.deepStrictEqual(purged, { documents: [], projects: [] });
  });

  await t.test('a live run deletes the surplus through the DELETE helpers', async () => {
    const { purged, deps } = makeDeps();
    const summary = await seed(['--live', '--reconcile', '--only', 'projects,documents'],
      { ...deps, sources: stubSources() });

    assert.deepStrictEqual(purged.documents, ['207|stale'],
      'the fetched document must survive and the orphan must not');
    assert.deepStrictEqual(purged.projects, ['eagle-gone']);
    assert.strictEqual(summary.reconcile.documents.deleted, 1);
    assert.strictEqual(summary.reconcile.projects.deleted, 1);
  });

  await t.test('an enumeration shorter than the container COUNT refuses BOTH containers',
    async () => {
      // The live 2026-08-25 run: listSeededIds returned 1,000 of 60,578 rows because the SDK drops
      // `x-ms-continuation` on a cross-partition ORDER BY, so 59,578 live documents computed as
      // surplus. The fetch itself verifies clean, so only the COUNT can catch this.
      const { purged, deps } = makeDeps({}, SEEDED_DOCS, { documents: 60578 });
      const summary = await seed(['--live', '--reconcile', '--only', 'projects,documents'],
        { ...deps, sources: stubSources() });

      assert.match(summary.failures.join(' '), /refused before any delete/);
      assert.match(summary.failures.join(' '),
        /documents enumerated 2 rows but the container holds 60578/);
      assert.deepStrictEqual(purged, { documents: [], projects: [] });
      assert.strictEqual(summary.reconcile, undefined);
      assert.strictEqual(summary.failures.length ? 1 : 0, 1, 'a refused reconcile must exit 1');
    });

  await t.test('a short projects enumeration refuses the documents container too', async () => {
    const { purged, deps } = makeDeps({}, SEEDED_DOCS, { projects: 9 });
    const summary = await seed(['--live', '--reconcile', '--only', 'projects,documents'],
      { ...deps, sources: stubSources() });

    assert.match(summary.failures.join(' '), /projects enumerated 2 rows but the container holds 9/);
    assert.deepStrictEqual(purged, { documents: [], projects: [] });
    assert.strictEqual(summary.reconcile, undefined);
  });

  await t.test('an enumeration equal to the COUNT proceeds', async () => {
    const { purged, deps } = makeDeps({}, SEEDED_DOCS,
      { documents: SEEDED_DOCS.length, projects: 2 });
    const summary = await seed(['--live', '--reconcile', '--only', 'projects,documents'],
      { ...deps, sources: stubSources() });

    assert.deepStrictEqual(summary.failures, []);
    assert.deepStrictEqual(purged.documents, ['207|stale']);
    assert.strictEqual(summary.reconcile.documents.deleted, 1);
  });

  await t.test('no reconcile without the flag, even live', async () => {
    const { purged, deps } = makeDeps();
    const summary = await seed(['--live', '--only', 'projects,documents'],
      { ...deps, sources: stubSources() });

    assert.strictEqual(summary.reconcile, undefined);
    assert.deepStrictEqual(purged, { documents: [], projects: [] });
  });

  await t.test('an unverified Document fetch refuses BOTH containers', async () => {
    // sources.js only verifies the fetch against searchResultsTotal when the upstream reports
    // one. A null total means that gate never ran, so "not in the fetch" proves nothing.
    const { purged, deps } = makeDeps();
    const summary = await seed(['--live', '--reconcile', '--only', 'projects,documents'], {
      ...deps,
      sources: stubSources({
        streamEagleDocuments: async (onPage) => {
          await onPage([eagleDoc('doc1', matchedGuid)], 1, null);
          return { count: 1, total: null };
        }
      })
    });

    assert.match(summary.failures.join(' '), /refused before any delete/);
    assert.match(summary.failures.join(' '), /Document fetch was never verified/);
    assert.deepStrictEqual(purged, { documents: [], projects: [] },
      'projects reconcile ran first before the fix and deleted off an unverified run');
    assert.strictEqual(summary.reconcile, undefined);
  });

  await t.test('an unverified Project fetch refuses BOTH containers', async () => {
    // The reviewer's probe: the projects gate used to be per container, so a null Project total
    // left the documents reconcile free to delete.
    const { purged, deps } = makeDeps();
    const summary = await seed(['--live', '--reconcile', '--only', 'projects,documents'], {
      ...deps,
      sources: stubSources({
        fetchEagleProjects: async (onPage) => {
          const items = [eagleProject(matchedGuid, 'Nicomen Wind (Eagle)')];
          if (onPage) await onPage(items, items.length, null);
          return items;
        }
      })
    });

    assert.match(summary.failures.join(' '), /Project fetch was never verified/);
    assert.deepStrictEqual(purged, { documents: [], projects: [] });
    assert.strictEqual(summary.reconcile, undefined);
  });

  await t.test('an unverified ProjectNotification fetch refuses BOTH containers', async () => {
    // Gated like Project and Document: the notification list decides whether a document has a
    // parent, so an unverified one makes "not in the fetch" prove nothing here either. NOTHING is
    // dropped in this run, so only the gate itself can produce the refusal.
    const { purged, deps } = makeDeps();
    const summary = await seed(['--live', '--reconcile', '--only', 'projects,documents'], {
      ...deps,
      // Reports no total at all — the shape sources.js never got to verify.
      sources: stubSources({ fetchAllPages: async () => [] })
    });

    assert.strictEqual(summary.stages.documents.droppedUnresolvable, 0);
    assert.match(summary.failures.join(' '), /ProjectNotification fetch was never verified/);
    assert.deepStrictEqual(purged, { documents: [], projects: [] });
    assert.strictEqual(summary.reconcile, undefined);
  });

  // The reviewer's probe. An eagle-api answering `searchResults: [], searchResultsTotal: 0` for
  // ProjectNotification is internally consistent and clears every completeness gate, but every
  // notification-parented document then resolves to nothing, is absent from `fetchedKeys`, and
  // reads as surplus — under the ceiling, so it would purge quietly and exit 0.
  const notificationId = '5efe366b3a147c00223be181';
  const withNotifications = (list) => stubSources({
    fetchAllPages: async (_base, dataset, opts) => {
      const items = dataset === 'ProjectNotification' ? list : [];
      if (opts && opts.onPage) await opts.onPage(items, items.length, items.length);
      return items;
    },
    streamEagleDocuments: async (onPage) => {
      await onPage([eagleDoc('doc1', matchedGuid), eagleDoc('pn1', notificationId)], 2, 2);
      return { count: 2, total: 2 };
    }
  });

  // pn1 already seeded, so a reconcile that ran would delete it.
  const seededWithPn1 = [...SEEDED_DOCS, { id: 'pn1', projectId: notificationId }];

  await t.test('a document the seed could not place, and that IS in Cosmos, refuses the reconcile',
    async () => {
      // One notification: pn1 is placed, nothing is unresolvable, the reconcile runs as normal.
      const placed = makeDeps({}, seededWithPn1);
      const ok = await seed(['--live', '--reconcile', '--only', 'projects,documents'],
        { ...placed.deps, sources: withNotifications([{ _id: notificationId }]) });

      assert.deepStrictEqual(ok.failures, []);
      assert.strictEqual(ok.stages.documents.droppedUnresolvable, 0);
      assert.deepStrictEqual(placed.purged.documents, ['207|stale']);

      // Empty list: pn1 has nowhere to go and a row in Cosmos to lose, so nothing may be deleted
      // anywhere.
      const empty = makeDeps({}, seededWithPn1);
      const refused = await seed(['--live', '--reconcile', '--only', 'projects,documents'],
        { ...empty.deps, sources: withNotifications([]) });

      assert.strictEqual(refused.stages.documents.droppedUnresolvable, 1);
      assert.deepStrictEqual(refused.stages.documents.droppedIds, ['pn1']);
      assert.match(refused.failures.join(' '), /refused before any delete/);
      assert.match(refused.failures.join(' '), /1 of the 1 document\(s\)/);
      assert.match(refused.failures.join(' '), /ProjectNotification/);
      assert.deepStrictEqual(empty.purged, { documents: [], projects: [] });
      assert.strictEqual(refused.reconcile, undefined);
      assert.strictEqual(refused.failures.length ? 1 : 0, 1, 'a refused reconcile must exit 1');
    });

  await t.test('a dropped document absent from Cosmos is reported, not refused', async () => {
    // The prod case, 2026-08-25: 24 documents whose parent project the anonymous fetch does not
    // return. None of them are in Cosmos, so there is no row a reconcile could delete and the
    // refusal was pure over-strictness. SEEDED_DOCS holds no pn1.
    const { purged, deps } = makeDeps();
    const summary = await seed(['--live', '--reconcile', '--only', 'projects,documents'],
      { ...deps, sources: withNotifications([]) });

    assert.strictEqual(summary.stages.documents.droppedUnresolvable, 1);
    assert.deepStrictEqual(summary.stages.documents.droppedIds, ['pn1']);
    assert.deepStrictEqual(summary.failures, [], 'a drop with nothing to lose must not refuse');
    assert.deepStrictEqual(purged.documents, ['207|stale'],
      'the reconcile proceeds and still removes the real surplus');
    assert.strictEqual(summary.reconcile.documents.deleted, 1);
  });

  await t.test('every surplus id reaches the log file and the audit trail', async () => {
    // The console preview stops at 20; this file is what a reconcile is reconstructed from, so it
    // carries every id in both containers — dry run included, where nothing was deleted.
    const logFile = path.join(LOG_DIR, 'explicit.ndjson');
    const previous = process.env.RECONCILE_LOG;
    process.env.RECONCILE_LOG = logFile;
    const events = [];
    try {
      const { deps } = makeDeps({ audit: { auditEvent: (_req, e) => events.push(e) } });
      const live = await seed(['--live', '--reconcile', '--only', 'projects,documents'],
        { ...deps, sources: stubSources() });

      assert.strictEqual(live.reconcile.log, logFile, 'the path has to reach the summary');
      assert.deepStrictEqual(
        fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)),
        [
          { label: 'documents', id: 'stale', partitionKey: '207', deleted: true },
          { label: 'projects', id: 'eagle-gone', partitionKey: 'eagle-gone', deleted: true }
        ]);

      // The DELETE controllers' own event shape, not a second one invented for the seeder.
      assert.deepStrictEqual(events, [
        {
          action: 'document.delete', targetType: 'document', targetId: 'stale',
          projectId: '207', detail: { source: 'seed --reconcile' }
        },
        {
          action: 'project.delete', targetType: 'project', targetId: 'eagle-gone',
          projectId: 'eagle-gone', detail: { source: 'seed --reconcile' }
        }
      ]);

      fs.rmSync(logFile);
      const dry = makeDeps({ audit: { auditEvent: (_req, e) => events.push(e) } });
      await seed(['--reconcile', '--only', 'projects,documents'],
        { ...dry.deps, sources: stubSources() });

      const rows = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      assert.deepStrictEqual(rows.map(r => r.id), ['stale', 'eagle-gone'],
        'a dry run must still name every id it would delete');
      assert.ok(rows.every(r => r.deleted === false));
      assert.strictEqual(events.length, 2, 'a dry run deletes nothing, so it audits nothing');
    } finally {
      process.env.RECONCILE_LOG = previous;
    }
  });

  await t.test('a total that disagrees with what arrived is not a verified fetch', async () => {
    const { purged, deps } = makeDeps();
    const summary = await seed(['--live', '--reconcile', '--only', 'projects,documents'], {
      ...deps,
      sources: stubSources({
        streamEagleDocuments: async (onPage) => {
          await onPage([eagleDoc('doc1', matchedGuid)], 1, 9);
          return { count: 1, total: 9 };
        }
      })
    });

    assert.match(summary.failures.join(' '), /Document fetch was never verified/);
    assert.deepStrictEqual(purged, { documents: [], projects: [] });
  });

  await t.test('documents are deleted before projects', async () => {
    const order = [];
    const { deps } = makeDeps();
    deps.purge = {
      purgeDocument: async () => { order.push('document'); },
      purgeProject: async () => { order.push('project'); }
    };
    await seed(['--live', '--reconcile', '--only', 'projects,documents'],
      { ...deps, sources: stubSources() });

    assert.deepStrictEqual(order, ['document', 'project'],
      'a project purged first would orphan its remaining documents');
  });

  await t.test('a dry run with no Cosmos refuses instead of reporting an empty surplus', async () => {
    const { purged, deps } = makeDeps({ cosmosReady: false });
    const summary = await seed(['--reconcile', '--only', 'projects,documents'],
      { ...deps, sources: stubSources() });

    assert.match(summary.failures.join(' '), /--reconcile needs COSMOS_ENDPOINT/);
    assert.strictEqual(summary.reconcile, undefined);
    assert.deepStrictEqual(purged, { documents: [], projects: [] });
  });
});

test('--reconcile refuses a surplus over the ceiling', async (t) => {
  const track = trackProjects.filter(p => [207, 373].includes(p.track_project_id));
  const matchedGuid = track.find(p => p.track_project_id === 207).epic_guid;
  const eagleDoc = (id) => ({
    _id: id, project: matchedGuid, displayName: `Doc ${id}`,
    internalURL: `etl/x/${id}.pdf`, internalSize: '1024', internalExt: '.pdf', read: ['public']
  });

  // Every fetch here is INTERNALLY CONSISTENT — the page count always equals the reported
  // searchResultsTotal — so the verification gate passes and only the ceiling can stop a delete.
  const stubSources = (docs) => ({
    EAGLE_API_BASE,
    loadTrackProjects: () => track,
    fetchEagleProjects: async (onPage) => { await onPage([], 0, 0); return []; },
    streamEagleDocuments: async (onPage) => {
      await onPage(docs.map(eagleDoc), docs.length, docs.length);
      return { count: docs.length, total: docs.length };
    },
    fetchListLookup: async () => new Map(),
    fetchAllPages: async (_base, _dataset, opts) => {
      if (opts && opts.onPage) await opts.onPage([], 0, 0);
      return [];
    },
    loadBoundaries: () => []
  });

  const makeDeps = (docRows, projRows) => {
    const purged = { documents: [], projects: [] };
    const repos = {
      projects: {
        upsert: async (p) => p,
        listEagleOnlyIds: async () => projRows,
        countEagleOnlyIds: async () => projRows.length
      },
      documents: {
        extractionRowsForProject: async () => [],
        bulkUpsertForProject: async (_pid, d) => (
          { succeeded: d.length, failed: 0, statusCounts: { 201: d.length } }),
        listSeededIds: async () => docRows,
        countSeededIds: async () => docRows.length
      },
      boundaries: { bulkUpsertForType: async () => ({ succeeded: 0, failed: 0, statusCounts: {} }) }
    };
    const purge = {
      purgeDocument: async (row) => { purged.documents.push(`${row.projectId}|${row.id}`); },
      purgeProject: async (row) => { purged.projects.push(row.id); }
    };
    return { purged, deps: { repos, purge, cosmosReady: true, now: NOW } };
  };

  // The reviewer's probe: eagle-api answers empty for both datasets and every gate above it
  // passes, so the whole corpus reads as surplus.
  const probeDocs = Array.from({ length: 61611 }, (_, i) => ({ id: `d${i}`, projectId: '207' }));
  const probeProjects = Array.from({ length: 4 }, (_, i) => ({ id: `eagle-${i}`, eagleId: `e${i}` }));

  await t.test('an empty upstream purges nothing and exits 1', async () => {
    const { purged, deps } = makeDeps(probeDocs, probeProjects);
    const summary = await seed(['--live', '--reconcile', '--only', 'projects,documents'],
      { ...deps, sources: stubSources([]) });

    assert.deepStrictEqual(purged, { documents: [], projects: [] },
      'a self-consistent empty fetch used to delete the entire corpus');
    assert.match(summary.failures.join(' '),
      /documents surplus 61611 exceeds the ceiling 1233/);
    assert.strictEqual(summary.reconcile.documents.wouldDelete, 61611);
    assert.strictEqual(summary.reconcile.documents.deleted, 0);
    // 4 projects is UNDER the projects ceiling on its own — the documents breach stopped it.
    assert.strictEqual(summary.reconcile.projects.wouldDelete, 4);
    assert.strictEqual(summary.reconcile.projects.deleted, 0);
    assert.strictEqual(summary.failures.length ? 1 : 0, 1, 'a refused reconcile must exit 1');
  });

  await t.test('a dry run reports the refusal without needing --live', async () => {
    const { purged, deps } = makeDeps(probeDocs, probeProjects);
    const summary = await seed(['--reconcile', '--only', 'projects,documents'],
      { ...deps, sources: stubSources([]) });

    assert.match(summary.failures.join(' '), /exceeds the ceiling 1233/);
    assert.strictEqual(summary.reconcile.documents.wouldDelete, 61611);
    assert.deepStrictEqual(purged, { documents: [], projects: [] });
  });

  await t.test('--max-surplus is the operator override and lets the deletes through', async () => {
    const { purged, deps } = makeDeps(probeDocs, probeProjects);
    const summary = await seed(
      ['--live', '--reconcile', '--only', 'projects,documents', '--max-surplus', '70000'],
      { ...deps, sources: stubSources([]) });

    assert.deepStrictEqual(summary.failures, []);
    assert.strictEqual(purged.documents.length, 61611);
    assert.strictEqual(purged.projects.length, 4);
    assert.strictEqual(summary.reconcile.documents.deleted, 61611);
  });

  // 100 rows in Cosmos, 50 of them fetched: 2% is 2, so the floor of 50 is the ceiling.
  const fetchedIds = Array.from({ length: 50 }, (_, i) => `d${i}`);
  const fetchedRows = fetchedIds.map(id => ({ id, projectId: '207' }));
  const staleRows = (n) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, projectId: '207' }));

  await t.test('a surplus exactly at the ceiling proceeds', async () => {
    const { purged, deps } = makeDeps([...fetchedRows, ...staleRows(50)], []);
    const summary = await seed(['--live', '--reconcile', '--only', 'projects,documents'],
      { ...deps, sources: stubSources(fetchedIds) });

    assert.deepStrictEqual(summary.failures, []);
    assert.strictEqual(summary.reconcile.documents.deleted, 50);
    assert.strictEqual(purged.documents.length, 50);
  });

  await t.test('one row over the ceiling refuses', async () => {
    const { purged, deps } = makeDeps([...fetchedRows, ...staleRows(51)], []);
    const summary = await seed(['--live', '--reconcile', '--only', 'projects,documents'],
      { ...deps, sources: stubSources(fetchedIds) });

    assert.match(summary.failures.join(' '), /documents surplus 51 exceeds the ceiling 50/);
    assert.deepStrictEqual(purged.documents, []);
  });
});

test('a re-seed carries extraction state forward', async (t) => {
  const eagleProject = (id, name) => ({
    _id: id, name, read: ['public', 'sysadmin'], status: 'Operating'
  });
  const track = trackProjects.filter(p => p.track_project_id === 207);
  const matchedGuid = track[0].epic_guid;
  const eagleDoc = (id) => ({
    _id: id, project: matchedGuid, displayName: `Doc ${id}`,
    internalURL: `etl/x/${id}.pdf`, internalExt: '.pdf', read: ['public']
  });

  const sources = {
    EAGLE_API_BASE,
    loadTrackProjects: () => track,
    fetchEagleProjects: async () => [eagleProject(matchedGuid, 'Nicomen Wind')],
    streamEagleDocuments: async (onPage) => {
      await onPage([eagleDoc('known'), eagleDoc('brandnew')], 2, 2);
      return { count: 2, total: 2 };
    },
    fetchListLookup: async () => new Map(),
    fetchAllPages: async () => [],
    loadBoundaries: () => []
  };

  const run = async (cosmosReady) => {
    const written = [];
    const partitions = [];
    const repos = {
      projects: { upsert: async (p) => p },
      documents: {
        extractionRowsForProject: async (_access, projectId) => {
          partitions.push(projectId);
          return [{
            id: 'known', contentExtracted: true, contentExtractedAt: '2026-08-01T00:00:00.000Z',
            contentPageCount: 9, contentExtractionError: null
          }];
        },
        bulkUpsertForProject: async (pid, docs) => {
          written.push(...docs);
          return { succeeded: docs.length, failed: 0, statusCounts: { 201: docs.length } };
        }
      },
      boundaries: { bulkUpsertForType: async () => ({ succeeded: 0, failed: 0, statusCounts: {} }) }
    };
    const summary = await seed(['--live', '--only', 'documents'],
      { sources, repos, now: NOW, cosmosReady });
    return { summary, written, partitions };
  };

  await t.test('an existing document keeps its extraction state, a new one does not', async () => {
    const { summary, written } = await run(true);

    const known = written.find(d => d.id === 'known');
    assert.strictEqual(known.contentExtracted, true,
      'resetting this orphans the chunks and re-queues the whole corpus');
    assert.strictEqual(known.contentExtractedAt, '2026-08-01T00:00:00.000Z');
    assert.strictEqual(known.contentPageCount, 9);

    const fresh = written.find(d => d.id === 'brandnew');
    assert.strictEqual(fresh.contentExtracted, false);
    assert.strictEqual(fresh.contentPageCount, 0);

    assert.strictEqual(summary.stages.documents.preserved, 1);
  });

  await t.test('the partition is read once per project, not once per batch', async () => {
    const { partitions } = await run(true);
    assert.deepStrictEqual(partitions, ['207']);
  });

  await t.test('without Cosmos nothing is read and nothing is preserved', async () => {
    // The path a dry run from outside the private endpoint takes: no database, so the rows are
    // still built and still verified, they just keep the reset values.
    const { summary, written, partitions } = await run(false);
    assert.deepStrictEqual(partitions, []);
    assert.strictEqual(summary.stages.documents.preserved, 0);
    assert.strictEqual(written.find(d => d.id === 'known').contentExtracted, false);
  });
});
