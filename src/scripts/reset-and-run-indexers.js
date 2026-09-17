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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const field = (v) => (v === undefined || v === null ? '-' : v);

const startedAt = (e) => (e && e.startTime ? Date.parse(e.startTime) : NaN);

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
    now = Date.now
  } = opts;

  const headers = { Authorization: `Bearer ${token}` };

  // executionHistory[0], never the top-level `status`: that reads `running` the whole time the
  // indexer is enabled on its schedule, reset or no reset.
  async function status(name) {
    const r = await fetchImpl(`${endpoint}/indexers/${name}/status?api-version=${API}`, { headers });
    if (r.status !== 200) throw new Error(`${name} status http${r.status}`);
    const body = await r.json();
    return (body.executionHistory || [])[0] || {};
  }

  // POST with an empty string body, not a bare POST: the REST API answers 411 without a
  // content-length, and `body: ''` is what makes undici send `content-length: 0`.
  const post = (name, op) => fetchImpl(`${endpoint}/indexers/${name}/${op}?api-version=${API}`,
    { method: 'POST', headers, body: '' });

  for (const name of names) {
    const before = await status(name);
    log(`DEMI_BEFORE ${name} status=${before.status || 'none'} start=${before.startTime || '-'}`);

    // In watch mode there is no reset to compare against, so the newest execution is the one asked
    // about.
    let resetAt = 0;

    if (mode === 'reset') {
      if (before.status === 'inProgress') {
        log(`DEMI_BUSY ${name}`);
        return 1;
      }
      const reset = await post(name, 'reset');
      log(`DEMI_RESET ${name} ${reset.status}`);
      if (reset.status >= 300) {
        log(`DEMI_FAIL ${name} reset ${reset.status}`);
        return 1;
      }
      resetAt = now();

      for (let i = 0; ; i += 1) {
        const e = await status(name);
        if (e.status !== 'inProgress') break;
        if (i + 1 >= MAX_DRAIN_POLLS || now() >= resetAt + settleMs) {
          log(`DEMI_FAIL ${name} an execution was still running ${settleMs / 1000}s after the reset`);
          return 1;
        }
        await sleep(pollSleepMs);
      }

      let run = await post(name, 'run');
      log(`DEMI_RUN ${name} ${run.status}`);
      if (run.status === 409) {
        // Already running. It is the run that was asked for when it started after the reset;
        // otherwise let it drain and ask again, or the wait below watches a pre-reset execution.
        const e = await status(name);
        if (!(startedAt(e) >= resetAt)) {
          for (let i = 0; i < MAX_DRAIN_POLLS; i += 1) {
            await sleep(pollSleepMs);
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
        continue;
      }
    }

    const deadline = now() + timeoutMs;
    let tick = 0;
    let last;
    let done = null;
    do {
      if (tick > 0) await sleep(pollSleepMs);
      tick += 1;
      const e = await status(name);
      last = e;
      // run-command truncates at 4 KB, and a several-hour wait would fill that with poll lines
      // long before the result.
      if (tick % pollEvery === 0) {
        log(`DEMI_POLL ${name} ${e.status || 'none'} items=${field(e.itemsProcessed)}`);
      }
      if (startedAt(e) >= resetAt && e.status && e.status !== 'inProgress') {
        done = e;
        break;
      }
    } while (now() < deadline);

    if (!done) {
      if (last && last.status === 'inProgress') {
        log(`DEMI_WARN ${name} still running after ${timeoutMs / 1000}s; check its status before resetting again`);
        continue;
      }
      log(`DEMI_FAIL ${name} no execution started within ${timeoutMs / 1000}s`);
      return 1;
    }

    // `initialTrackingState` is null on an execution that started from a cleared high-water mark.
    // We could not confirm that api-version 2024-07-01 returns the field, so it only decides when
    // it is there; when it is absent the startTime comparison above is the whole proof.
    const tracking = done.initialTrackingState === undefined ? 'absent'
      : done.initialTrackingState === null ? 'null' : 'set';
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
