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
const FRESH = {
  status: 'success',
  startTime: '2026-09-08T21:00:00Z',
  itemsProcessed: 61587,
  itemsFailed: 0,
  initialTrackingState: null
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
    assert.match(r.out, /DEMI_RESULT name=documents-indexer status=success items=61587 failed=0 tracking=null/);
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
      initialTrackingState: '{"lastTs":123}'
    };
    const r = await drive(service({ history: [STALE, STALE, [started], [tick, FRESH]] }));
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /DEMI_RESULT name=documents-indexer status=success items=61587 failed=0 tracking=null/);
    assert.ok(!r.out.includes('DEMI_RESET_NOT_APPLIED'), r.out);
  });

  await t.test('fails when the execution kept its old tracking state', async () => {
    // initialTrackingState carries over when the reset did not take. The run then re-pulls nothing,
    // every new field stays null, and no other step of the apply reports a problem.
    const kept = { ...FRESH, initialTrackingState: '{"lastTs":123}' };
    const r = await drive(service({ history: [STALE, STALE, kept] }));
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /DEMI_RESET_NOT_APPLIED documents-indexer/);
  });

  await t.test('accepts an execution whose tracking state the API did not return', async () => {
    // We could not confirm that api-version 2024-07-01 returns initialTrackingState. When it is
    // absent the startTime comparison is the whole proof, and the run must not fail on a missing
    // field.
    const { initialTrackingState: _drop, ...noField } = FRESH;
    const r = await drive(service({ history: [STALE, STALE, noField] }));
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /tracking=absent/);
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
    const kept = { ...FRESH, initialTrackingState: '{"lastTs":123}' };
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
    const kept = { ...FRESH, initialTrackingState: '{"lastTs":123}' };
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
    const kept = { ...FRESH, initialTrackingState: '{"lastTs":123}' };
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
});
