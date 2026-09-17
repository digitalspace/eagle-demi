// Reset, run and wait for search indexers, all in one process on the devbox.
//
// Every `az vm run-command invoke` is a 20-45 s ARM long poll, so a poll loop driven from a
// workstation spends more time in round trips than the indexer spends indexing. Holding the wait
// here turns an apply's poll-per-tick into one call. Background: docs/runbook-search-outage.md.
'use strict';

const API = '2024-07-01';
// An execution that was already in flight when the reset landed writes its old high-water mark
// back when it finishes and silently undoes the clear (hit 2026-09-07). Wait for it to drain.
const SETTLE_MS = 60000;
// How many drain polls to take before giving up, so a zero poll sleep cannot spin.
const MAX_DRAIN_POLLS = 20;
// A reset is applied asynchronously, so a run posted right behind it can still consume the old
// high-water mark (hit 2026-09-17). One wait per attempt: wait, run, and if the execution still
// carried a tracking state, reset again and wait longer. Length = the attempt cap.
const RUN_WAIT_MS = [5000, 20000, 40000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const field = (v) => (v === undefined || v === null ? '-' : v);

const startedAt = (e) => (e && e.startTime ? Date.parse(e.startTime) : NaN);

// The run that was asked for is the FIRST execution to start after the reset. A scheduled tick can
// start on top of it between two polls, so executionHistory[0] is not it: that tick carries a
// tracking state and would report a reset that worked as DEMI_RESET_NOT_APPLIED.
// executionHistory is newest first, so the earliest match is the last one. Watch mode resets
// nothing and asks about the newest execution.
function pickRun(list, resetAt, pinnedStart) {
  if (!resetAt) return list[0] || {};
  if (pinnedStart !== null) return list.find((e) => startedAt(e) === pinnedStart) || {};
  const after = list.filter((e) => startedAt(e) >= resetAt);
  return after[after.length - 1] || {};
}

/**
 * Reset and run each indexer in turn, waiting for its execution.
 * Returns the process exit code: 0 when every indexer finished or timed out still running.
 */
async function resetAndRun(opts) {
  const {
    names,
    endpoint,
    token,
    fetchImpl = fetch,
    log = console.log,
    pollSleepMs = 30000,
    timeoutMs = 1800000,
    settleMs = SETTLE_MS,
    pollEvery = 4,
    noWait = false,
    mode = 'reset',
    now = Date.now,
    sleep: sleepImpl = sleep
  } = opts;

  const headers = { Authorization: `Bearer ${token}` };

  // executionHistory, never the top-level `status`: that reads `running` the whole time the
  // indexer is enabled on its schedule, reset or no reset.
  async function history(name) {
    const r = await fetchImpl(`${endpoint}/indexers/${name}/status?api-version=${API}`, { headers });
    if (r.status !== 200) throw new Error(`${name} status http${r.status}`);
    const body = await r.json();
    return body.executionHistory || [];
  }

  const status = async (name) => (await history(name))[0] || {};

  // POST with an empty string body, not a bare POST: the REST API answers 411 without a
  // content-length, and `body: ''` is what makes undici send `content-length: 0`.
  const post = (name, op) => fetchImpl(`${endpoint}/indexers/${name}/${op}?api-version=${API}`,
    { method: 'POST', headers, body: '' });

  // One deadline for the whole call, not one per indexer: run-command cuts the call off at 90
  // minutes however many indexers it carries. The retries below share it.
  const deadline = now() + timeoutMs;

  // `initialTrackingState` is null on an execution that started from a cleared high-water mark.
  // We could not confirm that api-version 2024-07-01 returns the field, so it only decides when
  // it is there; when it is absent the startTime comparison is the whole proof.
  const trackingOf = (e) => (e.initialTrackingState === undefined ? 'absent'
    : e.initialTrackingState === null ? 'null' : 'set');

  // An execution that was already in flight when the reset landed writes its old high-water mark
  // back when it finishes and silently undoes the clear. Wait for it to drain.
  async function drained(name, resetAt) {
    for (let i = 0; ; i += 1) {
      const e = await status(name);
      if (e.status !== 'inProgress') return true;
      if (i + 1 >= MAX_DRAIN_POLLS || now() >= resetAt + settleMs) {
        log(`DEMI_FAIL ${name} an execution was still running ${settleMs / 1000}s after the reset`);
        return false;
      }
      await sleepImpl(pollSleepMs);
    }
  }

  async function waitForRun(name, resetAt) {
    let tick = 0;
    let last;
    let pinnedStart = null;
    do {
      if (tick > 0) await sleepImpl(pollSleepMs);
      tick += 1;
      const list = await history(name);
      // The poll line and the "still running" warning below are about the indexer, so they read the
      // newest execution; only the verdict is pinned to the run that was asked for.
      last = list[0] || {};
      const e = pickRun(list, resetAt, pinnedStart);
      if (pinnedStart === null && resetAt && startedAt(e) >= resetAt) pinnedStart = startedAt(e);
      // run-command truncates at 4 KB, and a several-hour wait would fill that with poll lines
      // long before the result.
      if (tick % pollEvery === 0) {
        log(`DEMI_POLL ${name} ${last.status || 'none'} items=${field(last.itemsProcessed)}`);
      }
      if (startedAt(e) >= resetAt && e.status && e.status !== 'inProgress') return { done: e, last };
    } while (now() < deadline);
    return { done: null, last };
  }

  for (const name of names) {
    const before = await status(name);
    log(`DEMI_BEFORE ${name} status=${before.status || 'none'} start=${before.startTime || '-'}`);

    if (mode === 'reset' && before.status === 'inProgress') {
      log(`DEMI_BUSY ${name}`);
      return 1;
    }

    // In watch mode there is no reset to compare against, so the newest execution is the one asked
    // about.
    let resetAt = 0;
    let done = null;
    let last = {};

    for (let attempt = 1; ; attempt += 1) {
      if (mode === 'reset') {
        // A scheduled tick can start on top of the run a retry is about to replace. Resetting into
        // it is what DEMI_BUSY refuses on the first attempt, so wait it out here too.
        if (attempt > 1 && (await status(name)).status === 'inProgress') {
          const drain = await waitForRun(name, 0);
          if (!drain.done) {
            done = null;
            last = drain.last;
            break;
          }
        }

        const reset = await post(name, 'reset');
        log(`DEMI_RESET ${name} ${reset.status}`);
        if (reset.status >= 300) {
          log(`DEMI_FAIL ${name} reset ${reset.status}`);
          return 1;
        }
        resetAt = now();

        if (!await drained(name, resetAt)) return 1;

        const waitMs = RUN_WAIT_MS[attempt - 1];
        if (attempt > 1) log(`DEMI_RESET_RETRY ${name} attempt=${attempt} wait=${waitMs / 1000}s`);
        await sleepImpl(waitMs);

        let run = await post(name, 'run');
        log(`DEMI_RUN ${name} ${run.status}`);
        if (run.status === 409) {
          // Already running. It is the run that was asked for when it started after the reset;
          // otherwise let it drain and ask again, or the wait below watches a pre-reset execution.
          const e = await status(name);
          if (!(startedAt(e) >= resetAt)) {
            for (let i = 0; i < MAX_DRAIN_POLLS; i += 1) {
              await sleepImpl(pollSleepMs);
              const w = await status(name);
              if (w.status !== 'inProgress') break;
            }
            run = await post(name, 'run');
            log(`DEMI_RUN ${name} ${run.status}`);
          }
        }
        if (run.status >= 300 && run.status !== 409) {
          log(`DEMI_FAIL ${name} run ${run.status}`);
          return 1;
        }

        if (noWait) {
          log(`DEMI_NOWAIT ${name}`);
          break;
        }
      }

      ({ done, last } = await waitForRun(name, resetAt));
      // Only a finished execution can say whether the reset took; a deadline or a run that never
      // started is reported below instead of retried.
      if (done && mode === 'reset' && trackingOf(done) === 'set' && attempt < RUN_WAIT_MS.length) {
        continue;
      }
      break;
    }

    if (mode === 'reset' && noWait) continue;

    if (!done) {
      if (last && last.status === 'inProgress') {
        log(`DEMI_WARN ${name} still running after ${timeoutMs / 1000}s; check its status before resetting again`);
        continue;
      }
      log(`DEMI_FAIL ${name} no execution started within ${timeoutMs / 1000}s`);
      return 1;
    }

    const tracking = trackingOf(done);
    if (mode === 'reset' && tracking === 'set') {
      log(`DEMI_RESET_NOT_APPLIED ${name}`);
      return 1;
    }

    log(`DEMI_RESULT name=${name} status=${done.status} items=${field(done.itemsProcessed)}`
      + ` failed=${field(done.itemsFailed)} tracking=${tracking}`);

    if (/fail/i.test(done.status)) {
      log(`DEMI_FAIL ${name} ended ${done.status}`);
      return 1;
    }
  }

  return 0;
}

async function main() {
  const names = process.argv.slice(2).filter(Boolean);
  if (names.length === 0) {
    console.error('usage: node src/scripts/reset-and-run-indexers.js <indexer> [<indexer>...]');
    process.exit(2);
  }
  const endpoint = (process.env.SEARCH_ENDPOINT || '').replace(/\/+$/, '');
  if (!endpoint) {
    console.error('SEARCH_ENDPOINT is not set');
    process.exit(2);
  }
  const { getToken } = require('../search/ai-search');
  const code = await resetAndRun({
    names,
    endpoint,
    token: await getToken(),
    pollSleepMs: num(process.env.DEMI_POLL_SLEEP, 30) * 1000,
    timeoutMs: num(process.env.DEMI_TIMEOUT, 1800) * 1000,
    pollEvery: num(process.env.DEMI_POLL_EVERY, 4),
    noWait: process.env.DEMI_NO_WAIT === '1',
    mode: process.env.DEMI_MODE === 'watch' ? 'watch' : 'reset'
  });
  process.exit(code);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { resetAndRun };
