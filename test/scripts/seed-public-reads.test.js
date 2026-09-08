'use strict';

/**
 * The public-read backfill.
 *
 * What is asserted is what is SILENT when it breaks: a dry run that writes, a resume that reruns a
 * dataset it already finished, a comment page loop that stops early and calls a truncated period
 * complete, and the ACL a backfilled comment lands with — a comment under a period the public
 * cannot see must not become readable because it arrived through the backfill instead of a push.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ALL_STAGES, COMMENT_FIELDS, parseArgs, mirrorListItem, withinSince, stageLine, backfill
} = require('../../src/scripts/seed-public-reads');
const comments = require('../../src/repositories/comments');
const lists = require('../../src/repositories/lists');
const { logger } = require('../../src/utils/logger');
const {
  PERIOD_EAGLE_ID, PUBLIC_ACL, PRIVATE_ACL, eagleComment, storedPeriod
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
 * `src/seed/sources.js`, stubbed at the two functions the backfill reads through it.
 *
 * `fetchAllPages` is driven page by page, because the dataset stages hand it an `onPage` and never
 * accumulate; `fetchJsonWithHeaders` serves the comment endpoint, whose total lives in the header.
 */
function stubSources({ datasets = {}, commentItems = [], commentTotal = null } = {}) {
  const urls = [];
  return {
    EAGLE_API_BASE: BASE,
    PAGE_SIZE,
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
  // This script is the repair tool — a List migration in eagle-api writes to Mongo and fires no
  // push — and the stage needing repair has always completed before. Skipping it made
  // `--only lists` a no-op that exits 0 and reads like a successful backfill.
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
  // On test this stage dropped 19 comment periods, recorded itself complete because errors was 0,
  // and every plain rerun after that skipped it — the periods, and the 88 comments hanging off
  // them, were unreachable until the state file was deleted by hand. A drop is not a failure, but
  // it is a row still owed: the parent project can be published after this run.
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

test('comments', async (t) => {
  const period = { _id: PERIOD_EAGLE_ID };

  /** The real comment mirror, writing through a mocked repository. */
  const captureComments = async (t2, { items, total, periodRow }) => {
    const written = [];
    t2.mock.method(comments, 'getById', async () => null);
    t2.mock.method(comments, 'upsert', async (item) => { written.push(item); return item; });
    t2.mock.method(logger, 'error', () => {});

    const sources = stubSources({
      datasets: { CommentPeriod: [period] }, commentItems: items, commentTotal: total
    });
    const summary = await backfill(['--live', '--only', 'comments', '--state', statePath()], {
      sources,
      commentPeriodsRepo: { getById: async () => periodRow }
    });
    return { written, summary, urls: sources.urls };
  };

  await t.test('pages the period until the x-total-count header is satisfied', async (t2) => {
    const items = Array.from({ length: 5 }, (_, i) => eagleComment({ _id: `C${i}` }));
    const { written, summary, urls } = await captureComments(t2, {
      items, total: 5, periodRow: storedPeriod()
    });

    assert.strictEqual(written.length, 5, 'every comment on the period, across three pages');
    assert.strictEqual(summary.stages.comments.written, 5);
    assert.strictEqual(urls.length, 3, 'pages of 2, 2 and 1 — not one page read as the whole set');
    assert.ok(urls[0].includes('count=true'),
      'without count=true the body is not the comment array and the header is absent');
    // Unnamed fields come back as nulls, so the mirror would store a row of them.
    for (const field of COMMENT_FIELDS) assert.ok(urls[0].includes(encodeURIComponent(field)));
    t2.mock.restoreAll();
  });

  await t.test('a period that returns fewer comments than it promised is an error, not a success',
    async (t2) => {
      const items = Array.from({ length: 4 }, (_, i) => eagleComment({ _id: `C${i}` }));
      const state = statePath();
      t2.mock.method(comments, 'getById', async () => null);
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
    t2.mock.method(comments, 'getById', async () => null);
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
      // The row failure is swallowed into counts.errors rather than thrown, so the period looked
      // finished: the next run skipped it, reported a clean zero-row stage, and the comment was
      // gone for good.
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
      // The header promises `--only <stage>` re-runs the stages it names, checkpoint or no
      // checkpoint. The stage checkpoint was honoured; the per-period one was not, so the repair
      // walked every period, skipped all of them, and exited 0 looking like a completed backfill.
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
      // `Number(null)` is 0, which satisfies the truncation check, and without `count=true` the
      // body is the `[{ total_items, results }]` envelope whose rows carry no `_id` and filter
      // away to nothing. Either one alone records the period as holding zero comments, errors 0,
      // and checkpoints it — the period looks swept and its comments are gone from DEMI for good.
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

      // The envelope the endpoint answers without `count=true`: its one row has no `_id`, so the
      // filter empties the page. Reported as a truncated read, which sends the operator hunting a
      // withdrawn comment instead of the query that lost its flag.
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

  await t.test('a period DEMI has not mirrored is skipped whole, not written under nothing',
    async (t2) => {
      const { written, summary } = await captureComments(t2, {
        items: [eagleComment()], total: 1, periodRow: null
      });
      assert.deepStrictEqual(written, []);
      assert.strictEqual(summary.stages.comments.skipped, 1);
      assert.strictEqual(summary.stages.comments.errors, 0);
      t2.mock.restoreAll();
    });
});
