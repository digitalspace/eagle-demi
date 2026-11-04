'use strict';

const PROBE_TIMEOUT_MS = 15000;

/** True when stamper and checker agree on the live value, seen through the public path. */
// analytics passes on anything but 401: the empty body is refused only after the header was accepted.
function createProbe({ demiUrl, analyticsUrl, fetchImpl = fetch } = {}) {
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
    analytics: async () => {
      const res = await call(analyticsUrl, { method: 'POST', body: '' });
      return Boolean(res) && res.status !== 401;
    }
  };

  return async function probe(kind) {
    const run = probes[kind];
    if (!run) throw new Error(`unknown probe ${kind}`);
    return run();
  };
}

const PROBES = Object.freeze(['demi-edge', 'demi-gateway', 'analytics', 'none']);

module.exports = { createProbe, PROBES };
