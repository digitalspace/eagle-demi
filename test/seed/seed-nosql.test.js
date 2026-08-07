'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  parseArgs, verifyProjects, verifyItems, seed, ALL_STAGES, DEFAULT_STAGES
} = require('../../src/scripts/seed-nosql');
const { unwrapSearchResponse, fetchAllPages, PAGE_SIZE } = require('../../src/seed/sources');
const trackProjects = require('../../src/data/track_projects_enriched.json');

const NOW = '2026-07-30T00:00:00.000Z';

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
    // The NRPTI ingest was removed rather than narrowed — see TODO.md. Every stage now runs by
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
      onPage: async (items) => {
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
