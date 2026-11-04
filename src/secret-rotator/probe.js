'use strict';

const { setTimeout: sleep } = require('node:timers/promises');

const PROBE_TIMEOUT_MS = 15000;

/** True when stamper and checker agree on the live value, seen through the public path. */
// Retries cover a DEMI cold start (~50 s): one slow first request must not count as a rejection.
function createProbe({ demiUrl, analyticsUrl, fetchImpl = fetch, attempts = 3, delayMs = 20000 } = {}) {
  const call = async (url, init) => {
    if (!url) return null;
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    } catch {
      return null;
    }
  };

  const trust = async (key) => {
    const res = await call(demiUrl, { method: 'GET' });
    if (!res || !res.ok) return false;
    const body = await res.json().catch(() => null);
    return Boolean(body && body[key] === true);
  };

  const probes = {
    none: async () => true,
    'demi-edge': () => trust('edge'),
    'demi-gateway': () => trust('gateway'),
    // The empty body is refused only after the shared header was accepted, so anything but 401 passes.
    analytics: async () => {
      const res = await call(analyticsUrl, { method: 'POST', body: '' });
      return Boolean(res) && res.status !== 401;
    }
  };

  return async function probe(kind) {
    const once = probes[kind];
    if (!once) throw new Error(`unknown probe ${kind}`);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (await once()) return true;
      if (attempt < attempts) await sleep(delayMs);
    }
    return false;
  };
}

const PROBES = Object.freeze(['demi-edge', 'demi-gateway', 'analytics', 'none']);

module.exports = { createProbe, PROBES };
