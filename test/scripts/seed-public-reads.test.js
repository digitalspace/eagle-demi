'use strict';

// Pins what breaks silently: a dry run that writes, a resume that reruns, a truncated comment
// read, and a backfilled comment more readable than a pushed one.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ALL_STAGES, COMMENT_FIELDS, parseArgs, mirrorListItem, mirrorList, withinSince, stageLine, backfill, eachCommentPage
} = require('../../src/scripts/seed-public-reads');
const cosmos = require('../../src/db/cosmos-nosql');
const comments = require('../../src/repositories/comments');
const lists = require('../../src/repositories/lists');
const updatesRepo = require('../../src/repositories/updates');
const updateController = require('../../src/controllers/nosql/update');
const { updatesStore } = require('../helpers/updates-store');
const { parentProject, parentNotification } = require('../helpers/update-parents');
const { logger } = require('../../src/utils/logger');
const sources = require('../../src/seed/sources');
const {
  PERIOD_EAGLE_ID, PROJECT_EAGLE_ID, PUBLIC_ACL, PRIVATE_ACL, SEALED_AT, eagleComment, eagleUpdate, eagleUpdateWithoutRead,
  storedPeriod
} = require('../helpers/eagle-mirror-fixtures');

const BASE = 'https://eagle-test.example/api/public';
const PAGE_SIZE = 2;

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-backfill-'));
test.after(() => fs.rmSync(STATE_DIR, { recursive: true, force: true }));

let stateSeq = 0;
const statePath = () => path.join(STATE_DIR, `state-${stateSeq++}.json`);

/** The comment stage's per-period checkpoint — `[]` when the run recorded no state at all. */
function checkpointedPeriods(state) {
  if (!fs.existsSync(state)) return [];
  return (JSON.parse(fs.readFileSync(state, 'utf8')).comments || {}).periods || [];
}

/**
 * `src/seed/sources.js` with real count helpers and stubbed fetches: `fetchAllPages` page by page,
 * `fetchJsonWithHeaders` for the comment endpoint, whose total lives in the header.
 */
function stubSources({ datasets = {}, commentItems = [], commentTotal = null } = {}) {
  const urls = [];
  return {
    EAGLE_API_BASE: BASE,
    PAGE_SIZE,
    freshById: sources.freshById,
    settledTotal: sources.settledTotal,
    urls,
    fetchAllPages: async (base, dataset, opts = {}) => {
      assert.strictEqual(base, BASE);
      const rows = datasets[dataset] || [];
      if (opts.accumulate === false) {
        for (let i = 0; i < rows.length; i += PAGE_SIZE) {
          await opts.onPage(rows.slice(i, i + PAGE_SIZE));
        }
        return { count: rows.length, total: rows.length };
      }
      return rows;
    },
    fetchJsonWithHeaders: async (url) => {
      urls.push(url);
      const pageNum = Number(new URL(url).searchParams.get('pageNum'));
      const total = commentTotal === null ? commentItems.length : commentTotal;
      return {
        body: commentItems.slice(pageNum * PAGE_SIZE, (pageNum + 1) * PAGE_SIZE),
        headers: new Headers({ 'x-total-count': String(total) })
      };
    }
  };
}

/** A mirror that records instead of writing, so "did it write" is observable. */
function recordingMirror(name, into) {
  return {
    mirrorFromEagle: async (eagleId, doc) => {
      into.push([name, eagleId, doc]);
      return { saved: { id: eagleId, isPublished: false }, existing: null };
    }
  };
}

test('parseArgs', async (t) => {
  await t.test('defaults to a dry run', () => {
    // A backfill that writes by accident republishes the whole corpus under whatever ACL it
    // computed. Same default as seed-nosql.js.
    assert.strictEqual(parseArgs([]).live, false);
    assert.deepStrictEqual(parseArgs([]).only, ALL_STAGES);
  });

  await t.test('--live and --dry-run cannot both be asked for', () => {
    assert.throws(() => parseArgs(['--live', '--dry-run']), /contradict/);
    assert.strictEqual(parseArgs(['--dry-run']).live, false);
    assert.strictEqual(parseArgs(['--live']).live, true);
  });

  await t.test('--only selects stages and never reorders them', () => {
    // Run order IS the dependency order: a comment needs its period mirrored first.
    assert.deepStrictEqual(parseArgs(['--only', 'comments,lists']).only, ['lists', 'comments']);
  });

  await t.test('an unknown stage or flag throws rather than doing nothing quietly', () => {
    assert.throws(() => parseArgs(['--only', 'listz']), /unknown stage\(s\): listz/);
    assert.throws(() => parseArgs(['--force']), /unknown argument/);
  });

  await t.test('--only with no stages is the same usage error, not a run that does nothing', () => {
    // A typo'd invocation that selects nothing exits 0 and looks like a completed backfill.
    assert.throws(() => parseArgs(['--only']), /--only needs at least one stage/);
    assert.throws(() => parseArgs(['--only', '']), /--only needs at least one stage/);
    assert.throws(() => parseArgs(['--only', ' , ']), /--only needs at least one stage/);
  });

  await t.test('--since must be a date', () => {
    assert.throws(() => parseArgs(['--since', 'last tuesday']), /not a date/);
    assert.strictEqual(parseArgs(['--since', '2026-01-01']).since, '2026-01-01T00:00:00.000Z');
  });
});

test('--since narrows what is written, and fails open', () => {
  const since = '2026-06-01T00:00:00.000Z';
  assert.strictEqual(withinSince({ dateUpdated: '2026-07-01T00:00:00.000Z' }, since), true);
  assert.strictEqual(withinSince({ dateAdded: '2026-01-01T00:00:00.000Z' }, since), false);
  // A row with no usable timestamp is written: one wasted upsert beats a row left missing.
  assert.strictEqual(withinSince({}, since), true);
  assert.strictEqual(withinSince({ dateAdded: 'nonsense' }, since), true);
});

test('the List row this script owns', async (t) => {
  await t.test('derives isPublished from the ACL, as every mirror does', () => {
    const doc = { _id: 'L1', name: 'Amendment', type: 'doctype', item: 'Order', listOrder: 3 };
    const published = mirrorListItem('L1', doc, ['public', 'staff'], null);
    assert.strictEqual(published.kind, lists.KINDS.LIST);
    assert.strictEqual(published.isPublished, true);
    assert.strictEqual(published.listOrder, 3);
    assert.deepStrictEqual(published.sources.eagle, doc);
    assert.strictEqual(mirrorListItem('L1', doc, ['staff'], null).isPublished, false);
  });

  // A row the ACL hides from systemAccess still exists: read as absent, its create 409'd forever.
  await t.test('replaces a stored row that has no read[], under its etag', async () => {
    t.after(() => t.mock.restoreAll());
    const stored = { id: 'L1', kind: lists.KINDS.LIST, name: 'Old', _etag: '"v1"' };
    const writes = [];
    t.mock.method(cosmos, 'readItem', async (_c, id, pk) =>
      (id === 'L1' && pk === lists.KINDS.LIST ? { ...stored } : null));
    t.mock.method(cosmos, 'create', async (_c, item) => {
      writes.push(['create', item.id]);
      throw Object.assign(new Error('conflict'), { code: 409 });
    });
    t.mock.method(cosmos, 'replace', async (_c, id, _pk, item, etag) => {
      writes.push(['replace', id, etag]);
      return item;
    });

    const written = await mirrorList('L1', { _id: 'L1', name: 'Amendment', read: PUBLIC_ACL });

    assert.strictEqual(written.saved.name, 'Amendment');
    assert.deepStrictEqual(writes, [['replace', 'L1', '"v1"']]);
  });
});

test('a dry run counts and writes nothing', async () => {
  const wrote = [];
  const state = statePath();
  const sources = stubSources({ datasets: { Organization: [{ _id: 'O1' }, { _id: 'O2' }, { _id: 'O3' }] } });

  const summary = await backfill(['--only', 'organizations', '--state', state],
    { sources, organizationMirror: recordingMirror('organizations', wrote) });

  assert.deepStrictEqual(wrote, [], 'a dry run must not reach a mirror at all');
  assert.strictEqual(summary.stages.organizations.fetched, 3);
  assert.strictEqual(summary.stages.organizations.written, 3, 'it still counts what it would write');
  assert.match(stageLine('organizations', summary.stages.organizations, false), /would-write=3/);
  assert.strictEqual(fs.existsSync(state), false,
    'and it checkpoints nothing, or the live run behind it would skip the dataset');
});

test('--live writes every row and checkpoints the dataset', async () => {
  const wrote = [];
  const state = statePath();
  const sources = stubSources({ datasets: { Organization: [{ _id: 'O1' }, { _id: 'O2' }, { _id: 'O3' }] } });

  const summary = await backfill(['--live', '--only', 'organizations', '--state', state],
    { sources, organizationMirror: recordingMirror('organizations', wrote) });

  assert.deepStrictEqual(wrote.map(w => w[1]), ['O1', 'O2', 'O3']);
  assert.strictEqual(summary.stages.organizations.written, 3);
  assert.ok(JSON.parse(fs.readFileSync(state, 'utf8')).organizations.completedAt);
});

test('a rerun skips a dataset the state file already calls done', async () => {
  const wrote = [];
  const state = statePath();
  fs.writeFileSync(state, JSON.stringify({
    organizations: { completedAt: '2026-09-01T00:00:00.000Z' }
  }));
  // No `--only`: this is the resume, and every other stage has an empty dataset behind it.
  const sources = stubSources({
    datasets: {
      List: [], Organization: [{ _id: 'O1' }], ProjectNotification: [{ _id: 'N1' }],
      RecentActivity: [], CommentPeriod: []
    }
  });

  const summary = await backfill(['--live', '--state', state], {
    sources,
    organizationMirror: recordingMirror('organizations', wrote),
    notificationMirror: recordingMirror('notifications', wrote)
  });

  assert.deepStrictEqual(summary.skipped, ['organizations']);
  assert.deepStrictEqual(wrote.map(w => w[0]), ['notifications'],
    'the finished dataset is not refetched, the unfinished one still runs');
});

test('--only re-runs a stage the state file calls done', async () => {
  // `--only lists` is the List-migration repair and that stage has always completed before;
  // skipping it would make the repair a no-op that exits 0.
  const wrote = [];
  const state = statePath();
  fs.writeFileSync(state, JSON.stringify({
    organizations: { completedAt: '2026-09-01T00:00:00.000Z' }
  }));
  const sources = stubSources({ datasets: { Organization: [{ _id: 'O1' }] } });

  const summary = await backfill(['--live', '--only', 'organizations', '--state', state],
    { sources, organizationMirror: recordingMirror('organizations', wrote) });

  assert.deepStrictEqual(summary.skipped, []);
  assert.deepStrictEqual(wrote.map(w => w[1]), ['O1']);
  assert.strictEqual(summary.stages.organizations.written, 1);
});

test('a mirror that answers null is a skip, not a write', async () => {
  // Null means the row's parent is not in DEMI — an unpublished project's comment period, and the
  // main path of this stage. Counting it as written reports a backfill that wrote nothing as clean.
  const state = statePath();
  const sources = stubSources({ datasets: { CommentPeriod: [{ _id: 'CP1' }, { _id: 'CP2' }] } });

  const summary = await backfill(['--live', '--only', 'commentPeriods', '--state', state], {
    sources,
    commentPeriodMirror: {
      mirrorFromEagle: async (eagleId) =>
        (eagleId === 'CP1' ? null : { saved: { id: eagleId }, existing: null })
    }
  });

  assert.strictEqual(summary.stages.commentPeriods.fetched, 2);
  assert.strictEqual(summary.stages.commentPeriods.written, 1, 'only the row the mirror wrote');
  assert.strictEqual(summary.stages.commentPeriods.skipped, 1, 'the parentless row is skipped');
  assert.strictEqual(summary.stages.commentPeriods.errors, 0, 'and a missing parent is not an error');
});

test('a stage that dropped a row for want of a parent is not checkpointed complete', async () => {
  // A drop is a row still owed (its parent can be published later), so it must not checkpoint
  // the stage, or every plain rerun skips it.
  const state = statePath();
  fs.writeFileSync(state, JSON.stringify({
    organizations: { completedAt: '2026-09-01T00:00:00.000Z' }
  }));
  const attempts = [];
  const deps = () => ({
    sources: stubSources({
      datasets: {
        List: [], Organization: [{ _id: 'O1' }], ProjectNotification: [], RecentActivity: [],
        CommentPeriod: [{ _id: 'CP1' }, { _id: 'CP2' }]
      }
    }),
    // CP1's project is not in DEMI, so its mirror answers null. CP2 lands.
    commentPeriodMirror: {
      mirrorFromEagle: async (eagleId) => {
        attempts.push(eagleId);
        return eagleId === 'CP1' ? null : { saved: { id: eagleId }, existing: null };
      }
    }
  });

  const first = await backfill(['--live', '--state', state], deps());
  assert.strictEqual(first.stages.commentPeriods.dropped, 1, 'the parentless row is a drop');
  assert.strictEqual(first.stages.commentPeriods.errors, 0, 'and still not an error');
  assert.strictEqual(JSON.parse(fs.readFileSync(state, 'utf8')).commentPeriods, undefined,
    'a stage owing rows must stay off the checkpoint');

  const second = await backfill(['--live', '--state', state], deps());
  assert.ok(second.skipped.includes('organizations'),
    'the stage that finished clean is still skipped — the rerun is not a full replay');
  assert.ok(!second.skipped.includes('commentPeriods'), 'only the stage owing rows runs again');
  assert.deepStrictEqual(attempts, ['CP1', 'CP2', 'CP1', 'CP2'],
    'and the dropped row is walked again rather than left behind a completedAt');
});

test('a stage that logged errors is NOT checkpointed', async (t) => {
  t.mock.method(logger, 'error', () => {});
  const state = statePath();
  const sources = stubSources({ datasets: { Organization: [{ _id: 'O1' }] } });

  const summary = await backfill(['--live', '--only', 'organizations', '--state', state], {
    sources,
    organizationMirror: { mirrorFromEagle: async () => { throw new Error('cosmos said no'); } }
  });

  assert.strictEqual(summary.stages.organizations.errors, 1);
  assert.strictEqual(fs.existsSync(state), false,
    'checkpointing a stage that failed rows would leave them missing for good');
});

const readSummary = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('--summary needs a path', async () => {
  // The reseed gate reads this file; a run that wrote it nowhere would read as a missing summary.
  assert.throws(() => parseArgs(['--summary']), /--summary needs a path/);
  assert.throws(() => parseArgs(['--summary', '']), /--summary needs a path/);
  // Taking the next flag as the path would also swallow `--live` and run dry.
  assert.throws(() => parseArgs(['--summary', '--live']), /--summary needs a path/);
  assert.strictEqual(parseArgs(['--summary', 'out.json']).summary, 'out.json');
});

test('--summary lists a stage with drops as unfinished', async () => {
  const summaryFile = statePath();
  const sources = stubSources({
    datasets: { Organization: [{ _id: 'O1' }], CommentPeriod: [{ _id: 'CP1' }, { _id: 'CP2' }] }
  });

  await backfill(['--live', '--only', 'organizations,commentPeriods', '--state', statePath(),
    '--summary', summaryFile], {
    sources,
    organizationMirror: recordingMirror('organizations', []),
    commentPeriodMirror: {
      mirrorFromEagle: async (eagleId) =>
        (eagleId === 'CP1' ? null : { saved: { id: eagleId }, existing: null })
    }
  });

  const written = readSummary(summaryFile);
  assert.deepStrictEqual(written.unfinished, ['commentPeriods'],
    'the clean stage is finished, the one owing a row is not');
  assert.strictEqual(written.stages.commentPeriods.dropped, 1);
});

test('--summary lists a stage with errors as unfinished', async (t) => {
  t.mock.method(logger, 'error', () => {});
  const summaryFile = statePath();
  const sources = stubSources({ datasets: { Organization: [{ _id: 'O1' }] } });

  await backfill(['--live', '--only', 'organizations', '--state', statePath(),
    '--summary', summaryFile], {
    sources,
    organizationMirror: { mirrorFromEagle: async () => { throw new Error('cosmos said no'); } }
  });

  assert.deepStrictEqual(readSummary(summaryFile).unfinished, ['organizations']);
});

test('--summary records the target, mode, counts and resumed stages of a clean run', async () => {
  const state = statePath();
  const summaryFile = statePath();
  fs.writeFileSync(state, JSON.stringify({ lists: { completedAt: '2026-09-01T00:00:00.000Z' } }));
  const sources = stubSources({
    datasets: { Organization: [{ _id: 'O1' }, { _id: 'O2' }], ProjectNotification: [], RecentActivity: [], CommentPeriod: [] }
  });

  await backfill(['--live', '--state', state, '--summary', summaryFile], {
    sources,
    organizationMirror: recordingMirror('organizations', []),
    notificationMirror: recordingMirror('notifications', [])
  });

  const written = readSummary(summaryFile);
  assert.strictEqual(written.eagle, BASE);
  assert.strictEqual(written.live, true);
  assert.deepStrictEqual(written.skipped, ['lists']);
  assert.deepStrictEqual(written.unfinished, []);
  assert.strictEqual(written.stages.organizations.written, 2);
});

test('--summary is written when a stage throws, naming that stage unfinished', async () => {
  // A short read throws out of the run; the gate must still find a summary that says why.
  const summaryFile = statePath();
  const sources = {
    ...stubSources(),
    fetchAllPages: async () => { throw new Error('fetched 3 of 5 rows'); }
  };

  await assert.rejects(
    backfill(['--only', 'organizations', '--state', statePath(), '--summary', summaryFile], { sources }),
    /fetched 3 of 5 rows/);

  const written = readSummary(summaryFile);
  assert.strictEqual(written.live, false);
  assert.deepStrictEqual(written.unfinished, ['organizations']);
});

test('comments', async (t) => {
  const period = { _id: PERIOD_EAGLE_ID };

  /** The real comment mirror, writing through a mocked repository. */
  const captureComments = async (t2, { items, total, periodRow }) => {
    const written = [];
    t2.mock.method(comments, 'readForWrite', async () => null);
    t2.mock.method(comments, 'upsert', async (item) => { written.push(item); return item; });
    t2.mock.method(logger, 'error', () => {});

    const state = statePath();
    const sources = stubSources({
      datasets: { CommentPeriod: [period] }, commentItems: items, commentTotal: total
    });
    const summary = await backfill(['--live', '--only', 'comments', '--state', state], {
      sources,
      commentPeriodsRepo: { getById: async () => periodRow }
    });
    return { written, summary, urls: sources.urls, state };
  };

  await t.test('pages the period until the x-total-count header is satisfied', async (t2) => {
    const items = Array.from({ length: 5 }, (_, i) => eagleComment({ _id: `C${i}` }));
    const { written, summary, urls } = await captureComments(t2, {
      items, total: 5, periodRow: storedPeriod()
    });

    assert.strictEqual(written.length, 5, 'every comment on the period, across three pages');
    assert.strictEqual(summary.stages.comments.written, 5);
    assert.strictEqual(urls.length, 4,
      'pages of 2, 2 and 1, then the total re-read — not one page read as the whole set');
    assert.ok(urls[3].includes('pageNum=0&pageSize=1'), 'the re-read asks for one row');
    assert.ok(urls[0].includes('count=true'),
      'without count=true the body is not the comment array and the header is absent');
    // Unnamed fields come back as nulls, so the mirror would store a row of them.
    for (const field of COMMENT_FIELDS) assert.ok(urls[0].includes(encodeURIComponent(field)));
    t2.mock.restoreAll();
  });

  await t.test('a comment repeated across a page boundary is written once and the period passes',
    async (t2) => {
      // Raw rows 5, header 4: offset paging repeated C1 when a comment landed before the cursor.
      const items = ['C0', 'C1', 'C1', 'C2', 'C3'].map(_id => eagleComment({ _id }));
      const { written, summary } = await captureComments(t2, {
        items, total: 4, periodRow: storedPeriod()
      });
      assert.deepStrictEqual(written.map(c => c.id).sort(), ['C0', 'C1', 'C2', 'C3']);
      assert.strictEqual(summary.stages.comments.errors, 0);
      t2.mock.restoreAll();
    });

  await t.test('a period that returns fewer comments than it promised is an error, not a success',
    async (t2) => {
      const items = Array.from({ length: 4 }, (_, i) => eagleComment({ _id: `C${i}` }));
      const state = statePath();
      t2.mock.method(comments, 'readForWrite', async () => null);
      t2.mock.method(comments, 'upsert', async (item) => item);
      t2.mock.method(logger, 'error', () => {});

      const summary = await backfill(['--live', '--only', 'comments', '--state', state], {
        sources: stubSources({
          datasets: { CommentPeriod: [period] }, commentItems: items, commentTotal: 5
        }),
        commentPeriodsRepo: { getById: async () => storedPeriod() }
      });

      assert.strictEqual(summary.stages.comments.errors, 1);
      assert.strictEqual(fs.existsSync(state), false,
        'the period must stay off the checkpoint so the next run retries it');
      t2.mock.restoreAll();
    });

  // Pages answer `first` in x-total-count, the pageSize=1 re-read answers `reread`.
  const pagedComments = (count, first, reread) => {
    const items = Array.from({ length: count }, (_, i) => eagleComment({ _id: `C${i}` }));
    const urls = [];
    const deps = { sources: { ...stubSources(), fetchJsonWithHeaders: async (url) => {
      urls.push(url);
      const params = new URL(url).searchParams;
      const size = Number(params.get('pageSize'));
      const pageNum = Number(params.get('pageNum'));
      return {
        body: items.slice(pageNum * size, (pageNum + 1) * size),
        headers: new Headers({ 'x-total-count': String(size === 1 ? reread : first) })
      };
    } } };
    return { deps, urls };
  };

  await t.test('a period that grew during the read passes with the re-read total', async (t2) => {
    t2.mock.method(logger, 'info', () => {});
    const { deps, urls } = pagedComments(4, 3, 4);
    assert.deepStrictEqual(await eachCommentPage('CP1', deps, async () => {}), { count: 4, total: 4 });
    assert.strictEqual(urls.length, 3, 'two pages, then the re-read');
    t2.mock.restoreAll();
  });

  await t.test('a short period throws without spending a request on the re-read', async () => {
    const { deps, urls } = pagedComments(3, 5, 3);
    await assert.rejects(eachCommentPage('CP1', deps, async () => {}),
      /fetched 3 comments but eagle-api reports 5/);
    assert.strictEqual(urls.length, 2);
  });

  await t.test('a one-page period skips the re-read', async () => {
    const { deps, urls } = pagedComments(1, 1, 9);
    assert.deepStrictEqual(await eachCommentPage('CP1', deps, async () => {}), { count: 1, total: 1 });
    assert.strictEqual(urls.length, 1);
  });

  await t.test('a comment never out-ranks its period, whichever way it arrived', async (t2) => {
    // The comment says public; the period the public cannot see says otherwise, and the period
    // wins. This is `constrainToProject` inside the real mirror, not a rule restated here.
    assert.deepStrictEqual(eagleComment().read, PUBLIC_ACL, 'the fixture must claim public');
    const { written } = await captureComments(t2, {
      items: [eagleComment()], total: 1, periodRow: storedPeriod(PRIVATE_ACL)
    });

    assert.strictEqual(written.length, 1);
    assert.ok(!written[0].read.includes('public'));
    assert.strictEqual(written[0].isPublished, false);
    t2.mock.restoreAll();
  });

  await t.test('and a comment under a published period keeps public', async (t2) => {
    const { written } = await captureComments(t2, {
      items: [eagleComment()], total: 1, periodRow: storedPeriod()
    });
    assert.ok(written[0].read.includes('public'));
    assert.strictEqual(written[0].isPublished, true);
    assert.strictEqual(written[0].projectId, '207', 'the project axis is carried from the period');
    t2.mock.restoreAll();
  });

  await t.test('the per-period checkpoint survives the stage checkpoint', async (t2) => {
    const state = statePath();
    t2.mock.method(comments, 'readForWrite', async () => null);
    t2.mock.method(comments, 'upsert', async (item) => item);

    await backfill(['--live', '--only', 'comments', '--state', state], {
      sources: stubSources({ datasets: { CommentPeriod: [period] }, commentItems: [eagleComment()] }),
      commentPeriodsRepo: { getById: async () => storedPeriod() }
    });

    const saved = JSON.parse(fs.readFileSync(state, 'utf8')).comments;
    assert.ok(saved.completedAt, 'the stage is recorded');
    assert.deepStrictEqual(saved.periods, [PERIOD_EAGLE_ID],
      'and so are its periods — losing them makes the next run walk every period again');
    t2.mock.restoreAll();
  });

  await t.test('a period holding a comment that failed is retried, not checkpointed',
    async (t2) => {
      // writeRow swallows the row failure, so without this guard the period is checkpointed and
      // the comment lost for good.
      t2.mock.method(logger, 'error', () => {});
      const state = statePath();
      const attempts = [];
      const commentMirror = {
        mirrorFromEagle: async (eagleId) => {
          attempts.push(eagleId);
          if (attempts.length === 1) throw new Error('cosmos said no');
          return { saved: { id: eagleId }, existing: null };
        }
      };
      const deps = () => ({
        sources: stubSources({
          datasets: { CommentPeriod: [period] }, commentItems: [eagleComment({ _id: 'C1' })]
        }),
        commentPeriodsRepo: { getById: async () => storedPeriod() },
        commentMirror
      });

      const first = await backfill(['--live', '--only', 'comments', '--state', state], deps());
      assert.strictEqual(first.stages.comments.errors, 1);
      assert.deepStrictEqual(checkpointedPeriods(state), [],
        'a period whose comment failed must stay off the checkpoint');

      const second = await backfill(['--live', '--only', 'comments', '--state', state], deps());
      assert.deepStrictEqual(attempts, ['C1', 'C1'], 'the failed comment is re-attempted');
      assert.strictEqual(second.stages.comments.written, 1);
      assert.strictEqual(second.stages.comments.errors, 0);
      assert.deepStrictEqual(checkpointedPeriods(state), [PERIOD_EAGLE_ID],
        'and only the clean run records the period');
      t2.mock.restoreAll();
    });

  await t.test('--only comments ignores the per-period checkpoint, so a repair can reach a period',
    async () => {
      // `--only` re-runs a named stage whatever its checkpoints say, the per-period one included.
      const state = statePath();
      fs.writeFileSync(state, JSON.stringify({
        comments: { completedAt: '2026-09-01T00:00:00.000Z', periods: [PERIOD_EAGLE_ID] }
      }));
      const wrote = [];

      const summary = await backfill(['--live', '--only', 'comments', '--state', state], {
        sources: stubSources({
          datasets: { CommentPeriod: [period] }, commentItems: [eagleComment({ _id: 'C1' })]
        }),
        commentPeriodsRepo: { getById: async () => storedPeriod() },
        commentMirror: recordingMirror('comments', wrote)
      });

      assert.deepStrictEqual(wrote.map(w => w[1]), ['C1'],
        'the comment under the already-checkpointed period is re-mirrored');
      assert.strictEqual(summary.stages.comments.written, 1);
      assert.deepStrictEqual(checkpointedPeriods(state), [PERIOD_EAGLE_ID],
        'and the repaired period is recorded again');
    });

  await t.test('a comment page that lost its total or its shape is an error, not a zero',
    async (t2) => {
      // `Number(null)` is 0 and an envelope body filters to nothing; either alone would record zero
      // comments and checkpoint the period.
      const logged = [];
      t2.mock.method(logger, 'error', (msg, meta) => logged.push(meta && meta.error));

      const runWith = async (fetchJsonWithHeaders) => {
        logged.length = 0;
        const state = statePath();
        const wrote = [];
        const summary = await backfill(['--live', '--only', 'comments', '--state', state], {
          sources: { ...stubSources({ datasets: { CommentPeriod: [period] } }),
            fetchJsonWithHeaders },
          commentPeriodsRepo: { getById: async () => storedPeriod() },
          commentMirror: recordingMirror('comments', wrote)
        });
        return { summary, wrote, periods: checkpointedPeriods(state), logged: [...logged] };
      };

      // No header and an empty body: the truncation check reads 0 against 0 and is satisfied, so
      // the period was recorded swept with zero comments — indistinguishable from a real one.
      const noHeader = await runWith(async () => ({ body: [], headers: new Headers({}) }));
      assert.strictEqual(noHeader.summary.stages.comments.errors, 1,
        'a missing x-total-count is an error for the period, not a total of zero');
      assert.match(noHeader.logged[0], /x-total-count/, 'and it says which contract broke');
      assert.deepStrictEqual(noHeader.periods, [], 'so the period is not checkpointed');

      // Envelope body (no `count=true`): its row has no `_id`. It must be named as the wrong shape;
      // a short-read message sends the operator hunting a withdrawn comment.
      const envelope = await runWith(async () => ({
        body: [{ total_items: 88, results: [eagleComment({ _id: 'C1' })] }],
        headers: new Headers({ 'x-total-count': '88' })
      }));
      assert.strictEqual(envelope.summary.stages.comments.errors, 1);
      assert.match(envelope.logged[0], /count=true contract/,
        'the wrong shape is named as the wrong shape, not as a short read');
      assert.deepStrictEqual(envelope.wrote, [], 'nothing is mirrored out of either answer');
      assert.deepStrictEqual(envelope.periods, []);
      t2.mock.restoreAll();
    });

  await t.test('a page row with no _id is dropped from the page, not mirrored under "undefined"',
    async (t2) => {
      // `String(row._id)` on a row without one is the literal "undefined", which is a legal Cosmos
      // id: the row lands, and every later page carrying junk overwrites the same document.
      t2.mock.method(logger, 'error', () => {});
      const wrote = [];

      const summary = await backfill(['--live', '--only', 'comments', '--state', statePath()], {
        sources: {
          ...stubSources({ datasets: { CommentPeriod: [period] } }),
          // The header counts the one real comment; the junk row is not part of the total.
          fetchJsonWithHeaders: async () => ({
            body: [{ text: 'no id here' }, eagleComment({ _id: 'C1' })],
            headers: new Headers({ 'x-total-count': '1' })
          })
        },
        commentPeriodsRepo: { getById: async () => storedPeriod() },
        commentMirror: recordingMirror('comments', wrote)
      });

      assert.deepStrictEqual(wrote.map(w => w[1]), ['C1'], 'only the row that has an id');
      assert.strictEqual(summary.stages.comments.written, 1, 'and the count agrees');
      assert.strictEqual(summary.stages.comments.errors, 0);
      t2.mock.restoreAll();
    });

  await t.test('a period DEMI has not mirrored is skipped whole, not written under nothing',
    async (t2) => {
      const { written, summary, state } = await captureComments(t2, {
        items: [eagleComment()], total: 1, periodRow: null
      });
      assert.deepStrictEqual(written, []);
      assert.strictEqual(summary.stages.comments.skipped, 1);
      assert.strictEqual(summary.stages.comments.errors, 0);
      // The period is owed, not refused: `commentPeriods` can mirror it on a later run, so the
      // stage must not carry a completedAt that would skip it.
      assert.strictEqual(summary.stages.comments.dropped, 1);
      assert.strictEqual(fs.existsSync(state), false, 'the stage is not checkpointed complete');
      t2.mock.restoreAll();
    });
});

test('the updates stage spends the claim on live rows only, marked backfill', async (t) => {
  t.after(() => t.mock.restoreAll());
  const { row, store } = updatesStore(t, []);
  const past = '2020-01-01T00:00:00.000Z';
  const rows = {
    live: { isPublished: true, status: 'published', publishDate: past },
    legacy: { isPublished: true, status: null, publishDate: null, dateAdded: past },
    scheduled: { isPublished: true, status: 'published', publishDate: '2999-01-01T00:00:00.000Z' },
    draft: { isPublished: false, status: 'draft', publishDate: past }
  };
  const updateMirror = {
    mirrorFromEagle: async (eagleId) => {
      const saved = { id: eagleId, notifiedAt: null, ...rows[eagleId] };
      store.set(eagleId, saved);
      return { saved, existing: null };
    }
  };

  await backfill(['--live', '--only', 'updates', '--state', statePath()], {
    sources: stubSources({ datasets: { RecentActivity: Object.keys(rows).map(_id => ({ _id })) } }),
    updateMirror,
    updatesRepo
  });

  assert.strictEqual(row('live').notifiedBy, 'backfill');
  assert.strictEqual(row('legacy').notifiedBy, 'backfill');
  assert.strictEqual(row('scheduled').notifiedAt, null, 'still news: the timer announces it when due');
  assert.strictEqual(row('draft').notifiedAt, null);
});

test('the updates stage heals an Update an Eagle push sealed, under a project still stored so', async (t) => {
  t.after(() => t.mock.restoreAll());
  const EAGLE_READ = ['compliance', 'public'];
  const sealedRow = (id, extra = {}) => ({
    id, projectId: PROJECT_EAGLE_ID, read: ['compliance'], isPublished: false,
    sources: { eagle: { _id: id, read: EAGLE_READ } }, _etag: `"${id}"`, ...extra
  });
  const { row } = updatesStore(t, [sealedRow('U-eagle'), sealedRow('U-demi', { sealedAt: SEALED_AT })]);
  // Sealed by an earlier compliance push and not yet pushed again: it caps at its Eagle read.
  parentProject(t, {
    id: '207', eagleId: PROJECT_EAGLE_ID, read: ['compliance'], isPublished: false,
    sources: { eagle: { _id: PROJECT_EAGLE_ID, read: EAGLE_READ } }
  });
  parentNotification(t, null);

  await backfill(['--live', '--only', 'updates', '--state', statePath()], {
    sources: stubSources({ datasets: {
      RecentActivity: ['U-eagle', 'U-demi'].map(_id => eagleUpdate({ _id, read: EAGLE_READ }))
    } }),
    updateMirror: updateController,
    updatesRepo
  });

  assert.deepStrictEqual(row('U-eagle').read, ['public']);
  assert.strictEqual(row('U-eagle').isPublished, true);
  assert.deepStrictEqual(row('U-demi').read, ['compliance'], 'a DEMI seal is only lifted by a release');
  assert.strictEqual(row('U-demi').isPublished, false);
});

test('a rerun of the updates stage rewrites a legacy open Update stored before the inherit rule', async (t) => {
  t.after(() => t.mock.restoreAll());
  // As the mirror stored both shapes before: `[]` for a missing read and an empty one alike.
  const stored = (id) => ({
    id, projectId: PROJECT_EAGLE_ID, read: [], isPublished: false, status: null,
    sources: { eagle: { _id: id, read: [], status: null, active: true } }, _etag: `"${id}"`
  });
  const { row } = updatesStore(t, [stored('U-legacy'), stored('U-empty')]);
  parentProject(t, { id: '207', eagleId: PROJECT_EAGLE_ID, read: PUBLIC_ACL, isPublished: true });
  parentNotification(t, null);
  const lines = [];
  t.mock.method(logger, 'info', (msg) => lines.push(msg));

  await backfill(['--live', '--only', 'updates', '--state', statePath()], {
    sources: stubSources({ datasets: {
      RecentActivity: [
        eagleUpdateWithoutRead({ _id: 'U-legacy', status: null, active: true }),
        eagleUpdate({ _id: 'U-empty', read: [], status: null, active: true })
      ]
    } }),
    updateMirror: updateController,
    updatesRepo
  });

  assert.deepStrictEqual(row('U-legacy').read, PUBLIC_ACL);
  assert.strictEqual(row('U-legacy').isPublished, true);
  assert.strictEqual(row('U-legacy').sources.eagle.read, null, 'a missing read is stored apart from []');
  // eagle-api pruned `read: []` with no status for an anonymous caller, so DEMI keeps it unpublished.
  assert.deepStrictEqual(row('U-empty').read, []);
  assert.strictEqual(row('U-empty').isPublished, false);
  assert.deepStrictEqual(row('U-empty').sources.eagle.read, []);
  assert.ok(lines.some(l => /updates \(this run\): fetched=2 written=2 skipped=0/.test(l)), lines.join('\n'));
});
