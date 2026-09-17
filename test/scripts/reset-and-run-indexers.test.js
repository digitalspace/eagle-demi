'use strict';

/**
 * The reset-run-wait loop that runs on the devbox.
 *
 * It exists because the search data plane is private and every definition call from a workstation
 * is a 20-45 s ARM round trip, so the whole wait has to happen in one process on the VM. That also
 * means nothing here can be tried out by hand: the decisions worth pinning are the ones that cost
 * a re-pull of 1.1M rows when they are wrong — refusing to reset an indexer that is mid-run,
 * waiting for a straddling execution to drain before asking for a new one, and never reporting a
 * pre-reset execution as the run that was asked for.
 */

const test = require('node:test');
const assert = require('node:assert');

const { resetAndRun } = require('../../src/scripts/reset-and-run-indexers');

const NAME = 'documents-indexer';
// The clock is fixed, so an execution is "after the reset" purely by its startTime.
const NOW = Date.parse('2026-09-08T20:30:00Z');
const STALE = { status: 'success', startTime: '2026-09-08T20:00:00Z', itemsProcessed: 0, itemsFailed: 0 };
const RUNNING = { status: 'inProgress', startTime: '2026-09-08T20:00:00Z', itemsProcessed: 0 };
// The shapes demi-search-test returns (api-version 2024-07-01, read 2026-09-17): a JSON string,
// pretty-printed with \r\n, never null. A run that started from a cleared mark reports
// highWaterMark -1; an ordinary PT5M tick reports the container's own `_ts`.
const CLEARED = '{\r\n  "highWaterMark": -1,\r\n  "upperLimit": 1789669673\r\n}';
const KEPT = '{\r\n  "highWaterMark": 1789669219,\r\n  "upperLimit": 1789669273\r\n}';
const FRESH = {
  status: 'success',
  startTime: '2026-09-08T21:00:00Z',
  itemsProcessed: 61587,
  itemsFailed: 0,
  initialTrackingState: CLEARED
};

/**
 * A search service that answers status reads from a script, one entry per call, repeating the last.
 * `calls` is the transcript, so "did it post the reset before it read again" is readable.
 */
function service({ history, reset = 204, run = [202] } = {}) {
  const calls = [];
  const runCodes = [...run];
  let i = 0;
  const fetchImpl = async (url, init = {}) => {
    const [, name, kind] = url.match(/\/indexers\/([^/]+)\/([a-z]+)\?/);
    calls.push(`${init.method || 'GET'} ${name} ${kind}`);
    if (kind === 'status') {
      // An entry may be an array when a poll has to see more than the newest execution.
      const e = history[Math.min(i, history.length - 1)];
      i += 1;
      const list = Array.isArray(e) ? e : e ? [e] : [];
      return { status: 200, json: async () => ({ executionHistory: list }) };
    }
    if (kind === 'reset') return { status: reset, text: async () => 'reset body' };
    return { status: runCodes.length > 1 ? runCodes.shift() : runCodes[0], text: async () => 'run body' };
  };
  return { fetchImpl, calls };
}

async function drive(svc, opts = {}) {
  const lines = [];
  const code = await resetAndRun({
    names: [NAME],
    endpoint: 'https://demi-search-test.search.windows.net',
    token: 'fake',
    fetchImpl: svc.fetchImpl,
    log: (l) => lines.push(l),
    pollSleepMs: 0,
    timeoutMs: 600000,
    settleMs: 0,
    pollEvery: 1,
    now: () => NOW,
    sleep: async () => {},
    ...opts
  });
  return { code, lines, out: lines.join('\n'), calls: svc.calls };
}

test('reset-and-run-indexers', async (t) => {
  await t.test('reports the execution that started after the reset, not the one already there', async () => {
    // The PT5M schedule keeps appending steady-state ticks with itemsProcessed 0. "success" on its
    // own would report a finish that never happened, with the row count of a tick that did nothing.
    const r = await drive(service({ history: [STALE, STALE, STALE, FRESH] }));
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /DEMI_RESULT name=documents-indexer status=success items=61587 failed=0 tracking=cleared/);
  });

  await t.test('refuses to reset an indexer that is mid-run', async () => {
    // A tick already in flight writes its old high-water mark back when it finishes and silently
    // undoes the clear, so the run that follows re-pulls nothing.
    const r = await drive(service({ history: [RUNNING] }));
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /DEMI_BUSY documents-indexer/);
    assert.ok(!r.calls.includes(`POST ${NAME} reset`), `no reset may be posted: ${r.calls.join(' | ')}`);
  });

  await t.test('waits for an execution that straddles the reset before asking for a run', async () => {
    // Same failure as above, one step later: a tick that started just before the reset landed is
    // still holding the old high-water mark. Asking for a run while it drains is what produced the
    // runs that finished with items=0.
    const r = await drive(service({ history: [STALE, RUNNING, STALE, FRESH] }), { settleMs: 60000 });
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual(r.calls.slice(0, 5), [
      `GET ${NAME} status`,
      `POST ${NAME} reset`,
      `GET ${NAME} status`,
      `GET ${NAME} status`,
      `POST ${NAME} run`
    ], r.calls.join(' | '));
  });

  await t.test('gives up when the straddling execution never drains', async () => {
    const r = await drive(service({ history: [STALE, RUNNING] }), { settleMs: 0 });
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /DEMI_FAIL documents-indexer an execution was still running/);
    assert.ok(!r.calls.includes(`POST ${NAME} run`), 'the run must not be posted over a live execution');
  });

  await t.test('a 409 on an execution that started after the reset is the run that was asked for', async () => {
    // 409 means the service started one of its own between the reset and the POST. It is the right
    // execution, so posting again would only queue a second full re-pull.
    const svc = service({ history: [STALE, STALE, FRESH], run: [409] });
    const r = await drive(svc);
    assert.strictEqual(r.code, 0, r.out);
    assert.strictEqual(r.calls.filter(c => c === `POST ${NAME} run`).length, 1, r.calls.join(' | '));
  });

  await t.test('a 409 over a pre-reset execution is re-posted once it drains', async () => {
    const svc = service({ history: [STALE, STALE, RUNNING, STALE, FRESH], run: [409, 202] });
    const r = await drive(svc);
    assert.strictEqual(r.code, 0, r.out);
    assert.strictEqual(r.calls.filter(c => c === `POST ${NAME} run`).length, 2, r.calls.join(' | '));
  });

  await t.test('a scheduled tick that lands on top of the reset run does not hide it', async () => {
    // The PT5M schedule can start a tick between two polls. That tick is newer than the reset run
    // and carries a tracking state, so reading executionHistory[0] reports a reset that worked as
    // DEMI_RESET_NOT_APPLIED and sends the operator back to reset an indexer that is already clean.
    const started = { status: 'inProgress', startTime: FRESH.startTime, itemsProcessed: 120 };
    const tick = {
      status: 'success',
      startTime: '2026-09-08T21:00:20Z',
      itemsProcessed: 0,
      itemsFailed: 0,
      initialTrackingState: KEPT
    };
    const r = await drive(service({ history: [STALE, STALE, [started], [tick, FRESH]] }));
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /DEMI_RESULT name=documents-indexer status=success items=61587 failed=0 tracking=cleared/);
    assert.ok(!r.out.includes('DEMI_RESET_NOT_APPLIED'), r.out);
  });

  await t.test('fails when the execution kept its old tracking state', async () => {
    // initialTrackingState carries over when the reset did not take. The run then re-pulls nothing,
    // every new field stays null, and no other step of the apply reports a problem.
    const kept = { ...FRESH, initialTrackingState: KEPT };
    const r = await drive(service({ history: [STALE, STALE, kept] }));
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /DEMI_RESET_NOT_APPLIED documents-indexer/);
  });

  await t.test('accepts an execution whose tracking state the API did not return', async () => {
    // 2024-07-01 returns initialTrackingState on every execution, but an older or newer api-version
    // need not, and then the startTime comparison is the whole proof.
    const { initialTrackingState: _drop, ...noField } = FRESH;
    const r = await drive(service({ history: [STALE, STALE, noField] }));
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /tracking=absent/);
  });

  await t.test('a cleared state reads as cleared however the service spaces the JSON', async () => {
    // The service pretty-prints the state with \r\n inside the string. What decides is
    // highWaterMark -1, and a run that has it must not be reset a second time.
    for (const state of [CLEARED, '{"highWaterMark":-1,"upperLimit":1789669673}']) {
      const svc = service({ history: [STALE, STALE, { ...FRESH, initialTrackingState: state }] });
      const r = await drive(svc);
      assert.strictEqual(r.code, 0, r.out);
      assert.match(r.out, /tracking=cleared/);
      assert.strictEqual(r.calls.filter(c => c === `POST ${NAME} reset`).length, 1, r.calls.join(' | '));
    }
  });

  await t.test('a tracking state it cannot read is warned about and accepted', async () => {
    // Another reset cannot make the field readable, so the ladder has nothing to offer and the only
    // thing three more attempts would buy is three more full re-pulls.
    for (const state of ['not json at all', '{"upperLimit":1789669673}']) {
      const svc = service({ history: [STALE, STALE, { ...FRESH, initialTrackingState: state }] });
      const r = await drive(svc);
      assert.strictEqual(r.code, 0, r.out);
      assert.match(r.out, /DEMI_WARN documents-indexer tracking state unreadable/);
      assert.match(r.out, /tracking=unknown/);
      assert.ok(!r.out.includes('DEMI_RESET_RETRY'), r.out);
      assert.strictEqual(r.calls.filter(c => c === `POST ${NAME} reset`).length, 1, r.calls.join(' | '));
    }
  });

  await t.test('the reset entry is not the run, whichever side of resetAt it is stamped', async () => {
    // POST /reset appends an entry of its own, stamped from the service's clock: half a second
    // before the client's resetAt on test, and after it whenever the client clock lags. It reports
    // status reset with items 0, so taking it as the verdict passes an indexer that never ran.
    const at = (ms) => new Date(NOW + ms).toISOString();
    const entry = (ms) => ({
      status: 'reset', startTime: at(ms), itemsProcessed: 0, initialTrackingState: null
    });
    for (const skew of [-500, 500]) {
      const run = { ...FRESH, startTime: at(skew + 400) };
      const svc = service({ history: [STALE, [entry(skew), STALE], [run, entry(skew), STALE]] });
      const r = await drive(svc);
      assert.strictEqual(r.code, 0, r.out);
      assert.match(r.out, /DEMI_RESULT name=documents-indexer status=success items=61587 failed=0 tracking=cleared/);
      assert.ok(!r.out.includes('status=reset'), r.out);
    }
  });

  await t.test('the reset entry does not pass for a drained indexer', async () => {
    // The reset entry is newer than the tick that straddled it, so reading only the newest entry
    // reports nothing running while that tick still holds the old high-water mark.
    const entry = {
      status: 'reset', startTime: new Date(NOW - 500).toISOString(), itemsProcessed: 0,
      initialTrackingState: null
    };
    const r = await drive(service({ history: [STALE, [entry, RUNNING]] }), { settleMs: 0 });
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /DEMI_FAIL documents-indexer an execution was still running/);
    assert.ok(!r.calls.includes(`POST ${NAME} run`), r.calls.join(' | '));
  });

  await t.test('a run that ends in a failure status exits non-zero and still reports its counts', async () => {
    const failed = { ...FRESH, status: 'transientFailure', itemsProcessed: 12, itemsFailed: 30 };
    const r = await drive(service({ history: [STALE, STALE, failed] }));
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /DEMI_RESULT name=documents-indexer status=transientFailure items=12 failed=30/);
    assert.match(r.out, /DEMI_FAIL documents-indexer ended transientFailure/);
  });

  await t.test('an indexer still running at the deadline warns instead of failing', async () => {
    // The run was posted and the indexer is working. Exiting 1 here reads as "the apply failed",
    // which is what stopped the chunks chain at its 30-minute deadline.
    const r = await drive(service({ history: [STALE, STALE, RUNNING] }), { timeoutMs: 0 });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /DEMI_WARN documents-indexer still running after 0s/);
    assert.ok(!r.out.includes('DEMI_RESULT'), 'nothing finished, so there is no result to report');
  });

  await t.test('a deadline with no new execution at all is a failure', async () => {
    // Nothing started: the run was swallowed. That is not the same as "still going" and must not
    // pass for one.
    const r = await drive(service({ history: [STALE] }), { timeoutMs: 0 });
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /DEMI_FAIL documents-indexer no execution started/);
  });

  await t.test('--no-wait stops after the run is posted', async () => {
    const svc = service({ history: [STALE, STALE, FRESH] });
    const r = await drive(svc, { noWait: true });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /DEMI_NOWAIT documents-indexer/);
    assert.strictEqual(r.calls[r.calls.length - 1], `POST ${NAME} run`, r.calls.join(' | '));
  });

  await t.test('watch mode writes nothing', async () => {
    const svc = service({ history: [FRESH] });
    const r = await drive(svc, { mode: 'watch' });
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(r.calls.every(c => c.startsWith('GET')), `watch is read-only: ${r.calls.join(' | ')}`);
    assert.match(r.out, /DEMI_RESULT name=documents-indexer status=success items=61587/);
  });

  await t.test('watch mode reports an execution that kept its tracking state', async () => {
    // Watch resets nothing, so every ordinary tick it follows has initialTrackingState set. Failing
    // on that would make watch unusable for the runs it exists to follow.
    const kept = { ...FRESH, initialTrackingState: KEPT };
    const r = await drive(service({ history: [kept] }), { mode: 'watch' });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /DEMI_RESULT name=documents-indexer status=success items=61587 failed=0 tracking=set/);
    assert.ok(!r.out.includes('DEMI_RESET_RETRY'), r.out);
    assert.ok(r.calls.every(c => c.startsWith('GET')), r.calls.join(' | '));
  });

  await t.test('the timeout covers the whole call, not each indexer in turn', async () => {
    // demi-devbox.sh gives every indexer in the list the long deadline, and run-command itself cuts
    // the call off at 90 minutes. A deadline taken per indexer lets one call outlive the call that
    // carries it, and the "still running is only a warning" result never comes back.
    const TICK_MS = 30000;
    const timeoutMs = 300000;
    const script = [STALE, STALE, RUNNING];
    const seen = {};
    let clock = NOW;
    const fetchImpl = async (url) => {
      const [, name, kind] = url.match(/\/indexers\/([^/]+)\/([a-z]+)\?/);
      if (kind !== 'status') return { status: 202, text: async () => '' };
      // Every status read is an ARM round trip on the VM, so the reads are the wall clock.
      clock += TICK_MS;
      const n = seen[name] || 0;
      seen[name] = n + 1;
      return {
        status: 200,
        json: async () => ({ executionHistory: [script[Math.min(n, script.length - 1)]] })
      };
    };
    const lines = [];
    const code = await resetAndRun({
      names: ['documents-indexer', 'chunks-indexer'],
      endpoint: 'https://demi-search-test.search.windows.net',
      token: 'fake',
      fetchImpl,
      log: (l) => lines.push(l),
      pollSleepMs: 0,
      timeoutMs,
      settleMs: 0,
      pollEvery: 1,
      now: () => clock,
      sleep: async () => {}
    });
    const out = lines.join('\n');
    assert.strictEqual(code, 0, out);
    assert.strictEqual(lines.filter(l => l.startsWith('DEMI_WARN')).length, 2, out);
    // Outside the budget there are only the second indexer's two setup reads and its first poll.
    const elapsed = clock - NOW;
    assert.ok(elapsed <= timeoutMs + 4 * TICK_MS,
      `waited ${elapsed / 1000}s on a ${timeoutMs / 1000}s budget: ${out}`);
  });

  await t.test('a reset the service refuses stops the run', async () => {
    const svc = service({ history: [STALE], reset: 403 });
    const r = await drive(svc);
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /DEMI_FAIL documents-indexer reset 403/);
    assert.ok(!svc.calls.includes(`POST ${NAME} run`));
  });

  await t.test('every indexer in the list is handled, in order', async () => {
    const svc = service({ history: [STALE, STALE, FRESH] });
    const lines = [];
    const code = await resetAndRun({
      names: ['projects-indexer', 'documents-indexer'],
      endpoint: 'https://demi-search-test.search.windows.net',
      token: 'fake',
      fetchImpl: svc.fetchImpl,
      log: (l) => lines.push(l),
      pollSleepMs: 0,
      timeoutMs: 600000,
      settleMs: 0,
      pollEvery: 1,
      now: () => NOW,
      sleep: async () => {}
    });
    assert.strictEqual(code, 0, lines.join('\n'));
    const results = lines.filter(l => l.startsWith('DEMI_RESULT')).map(l => l.split(' ')[1]);
    assert.deepStrictEqual(results, ['name=projects-indexer', 'name=documents-indexer']);
  });
  await t.test('resets again when the run kept its tracking state', async () => {
    // AI Search applies a reset asynchronously, so a run posted seconds later can still consume the
    // old high-water mark (test, 2026-09-17). One more reset, given longer, clears it.
    const kept = { ...FRESH, initialTrackingState: KEPT };
    const svc = service({ history: [STALE, STALE, kept, STALE, FRESH] });
    const r = await drive(svc);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /DEMI_RESET_RETRY documents-indexer attempt=2 wait=20s/);
    assert.ok(!r.out.includes('DEMI_RESET_NOT_APPLIED'), r.out);
    assert.strictEqual(r.calls.filter(c => c === `POST ${NAME} reset`).length, 2, r.calls.join(' | '));
    assert.strictEqual(r.calls.filter(c => c === `POST ${NAME} run`).length, 2, r.calls.join(' | '));
  });

  await t.test('gives up after three resets that all kept the tracking state', async () => {
    // The retry is bounded: a fourth reset would queue another full re-pull for an indexer whose
    // high-water mark is not clearing, and the operator has to look at it instead.
    const kept = { ...FRESH, initialTrackingState: KEPT };
    const svc = service({ history: [STALE, STALE, kept, STALE, kept, STALE, kept] });
    const r = await drive(svc);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /DEMI_RESET_RETRY documents-indexer attempt=3 wait=40s/);
    assert.match(r.out, /DEMI_RESET_NOT_APPLIED documents-indexer/);
    assert.strictEqual(r.calls.filter(c => c === `POST ${NAME} reset`).length, 3, r.calls.join(' | '));
    assert.strictEqual(r.calls.filter(c => c === `POST ${NAME} run`).length, 3, r.calls.join(' | '));
  });

  await t.test('waits before the first run, not only before a retry', async () => {
    // Most of these races clear in a few seconds, so the cheap wait removes more of them than the
    // retry does.
    const svc = service({ history: [STALE, STALE, FRESH] });
    const waits = [];
    const r = await drive(svc, {
      sleep: async (ms) => {
        waits.push({ ms, runs: svc.calls.filter(c => c === `POST ${NAME} run`).length });
      }
    });
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual(waits[0], { ms: 5000, runs: 0 }, JSON.stringify(waits));
  });

  await t.test('a retry waits for a scheduled run instead of resetting into it', async () => {
    // The tick that starts on top of the kept run is the same hazard DEMI_BUSY refuses on the first
    // attempt: it writes its old high-water mark back when it finishes and undoes the clear.
    const kept = { ...FRESH, initialTrackingState: KEPT };
    const svc = service({ history: [STALE, STALE, kept, RUNNING, RUNNING, STALE, STALE, FRESH] });
    const r = await drive(svc);
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual(r.calls, [
      `GET ${NAME} status`,
      `POST ${NAME} reset`,
      `GET ${NAME} status`,
      `POST ${NAME} run`,
      `GET ${NAME} status`,
      // The retry reads the indexer again and keeps reading until the tick is gone.
      `GET ${NAME} status`,
      `GET ${NAME} status`,
      `GET ${NAME} status`,
      `POST ${NAME} reset`,
      `GET ${NAME} status`,
      `POST ${NAME} run`,
      `GET ${NAME} status`
    ], r.calls.join(' | '));
    assert.match(r.out, /DEMI_POLL documents-indexer inProgress/);
    assert.match(r.out, /DEMI_RESULT name=documents-indexer status=success items=61587 failed=0 tracking=cleared/);
  });

  await t.test('each retry waits longer than the one before it', async () => {
    // The log line says 20s and 40s whatever the script actually sleeps, and the wait is the whole
    // fix: a reset that did not take in 5 s needs longer, not another try at the same length.
    const kept = { ...FRESH, initialTrackingState: KEPT };
    const waits = [];
    const r = await drive(service({ history: [STALE, STALE, kept] }),
      { sleep: async (ms) => { waits.push(ms); } });
    assert.strictEqual(r.code, 1, r.out);
    assert.deepStrictEqual(waits, [5000, 20000, 40000], r.out);
  });

  await t.test('a retry judges its own run, not one that started before its reset', async () => {
    // A retry that keeps the first attempt's resetAt accepts the tick that ran between the two
    // resets, reports its row count and never looks at the run it asked for.
    const at = (ms) => new Date(NOW + ms).toISOString();
    const counted = (ms, itemsProcessed, initialTrackingState) => ({
      status: 'success', startTime: at(ms), itemsProcessed, itemsFailed: 0, initialTrackingState
    });
    const kept = counted(70000, 3, KEPT);
    const between = counted(90000, 7, CLEARED);
    const own = counted(150000, 61587, CLEARED);
    const svc = service({ history: [STALE, STALE, kept, kept, kept, between, own] });
    let clock = NOW;
    const fetchImpl = async (url, init) => {
      const res = await svc.fetchImpl(url, init);
      // A reset takes wall clock, so each attempt's resetAt lands after the last attempt's run.
      if (/\/reset\?/.test(url)) clock += 60000;
      return res;
    };
    const r = await drive({ fetchImpl, calls: svc.calls }, { now: () => clock });
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual(r.lines.filter((l) => l.startsWith('DEMI_RESULT')),
      ['DEMI_RESULT name=documents-indexer status=success items=61587 failed=0 tracking=cleared'], r.out);
  });

  await t.test('a retry that runs out of deadline while waiting warns instead of resetting', async () => {
    const kept = { ...FRESH, initialTrackingState: KEPT };
    const svc = service({ history: [STALE, STALE, kept, RUNNING, RUNNING] });
    const r = await drive(svc, { timeoutMs: 0 });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /DEMI_WARN documents-indexer still running after 0s/);
    assert.strictEqual(r.calls.filter(c => c === `POST ${NAME} reset`).length, 1, r.calls.join(' | '));
  });
});
