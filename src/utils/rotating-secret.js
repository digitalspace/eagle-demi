'use strict';

// Accepts `<name>` and `<name>-standby` from Key Vault so a rotation swaps values with no failed request.
// The env value (a reference App Service caches up to 24 h) counts only until the first vault read succeeds.

const azureCredential = require('./azure-credential');
const config = require('../config');
const { logger } = require('./logger');
const { isKeyVaultReference } = require('./key-vault-reference');

const TTL_MS = 5 * 60_000;
const READY_CAP_MS = 3_000;
const READ_TIMEOUT_MS = 10_000;
const VAULT_SCOPE = 'https://vault.azure.net/.default';

/** Setting name → its versionless vault URI and the value the environment holds. */
const SECRETS = {
  EDGE_SECRET: {
    uri: () => config.edgeSecretUri,
    env: () => config.edgeSecret
  },
  APIM_GATEWAY_SECRET: {
    uri: () => config.apimGatewaySecretUri,
    env: () => config.secretFromEnv('APIM_GATEWAY_SECRET')
  }
};

// Keyed by URI, so a changed setting starts cold instead of serving another secret's values.
const states = new Map();

/** One secret's current value, null when it does not exist. Never puts the body in an error. */
async function readSecret(uri, token, signal) {
  const res = await fetch(`${uri}?api-version=7.4`, { headers: { authorization: `Bearer ${token}` }, signal });
  if (res.status === 404 || !res.ok) {
    await res.body?.cancel();
    if (res.status === 404) return null;
    throw new Error(`vault answered ${res.status}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    // A JSON parse error quotes the text it choked on, and that text is a secret.
    throw new Error('vault answered a body that is not JSON');
  }
  return body && typeof body.value === 'string' && body.value ? body.value : null;
}

/** Rejects when `signal` aborts, so a hung token call fails the read instead of pinning it. */
function untilAborted(signal) {
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('vault read timed out')), { once: true });
  });
}

async function readSet(uri, signal) {
  const token = await azureCredential.getToken(VAULT_SCOPE);
  // Name first: the rotator writes standby := O before name := N, so a later standby read still
  // holds O whichever side of the promote the name read landed on.
  const latest = await readSecret(uri, token, signal);
  if (!latest) throw new Error('secret not found');
  const standby = await readSecret(`${uri}-standby`, token, signal);
  return standby && standby !== latest ? [latest, standby] : [latest];
}

function refresh(uri, state) {
  if (state.inflight) return state.inflight;
  state.checkedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  timer.unref?.();
  state.inflight = (async () => {
    try {
      const { signal } = controller;
      const read = await Promise.race([readSet(uri, signal), untilAborted(signal)]);
      // Two generations: a read between the rotator's two promote writes sees only O, and must not
      // drop the N the read before it saw. A retired value therefore lasts two refreshes.
      state.values = [...new Set([...read, ...(state.lastRead || [])])];
      state.lastRead = read;
    } catch (err) {
      logger.warn('[rotating-secret] vault read failed', {
        evt: 'rotating-secret',
        uri,
        using: state.values ? 'last-good' : 'env',
        error: String(err && err.message)
      });
    } finally {
      clearTimeout(timer);
      state.inflight = null;
    }
  })();
  return state.inflight;
}

function stateFor(uri) {
  let state = states.get(uri);
  if (!state) {
    state = { values: null, lastRead: null, checkedAt: 0, inflight: null, settled: false, first: null };
    states.set(uri, state);
    state.first = refresh(uri, state).then(() => { state.settled = true; });
  }
  return state;
}

/**
 * Resolves once every configured secret has had its first vault read, or after 3 s, whichever is
 * sooner. Never rejects. A timed-out read keeps going; until it lands the env value is accepted.
 */
function ready() {
  const pending = [];
  for (const secret of Object.values(SECRETS)) {
    const uri = secret.uri();
    if (!uri) continue;
    const state = stateFor(uri);
    if (!state.settled) pending.push(state.first);
  }
  if (pending.length === 0) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, READY_CAP_MS);
    Promise.all(pending).then(() => { clearTimeout(timer); resolve(); });
  });
}

/** The values a request may present for `name` (a key of SECRETS). Empty = the check is off. */
function acceptedValues(name) {
  const secret = SECRETS[name];
  const uri = secret.uri();
  if (uri) {
    const state = stateFor(uri);
    if (Date.now() - state.checkedAt >= TTL_MS) refresh(uri, state);
    if (state.values) return state.values;
  }
  const env = secret.env();
  return env && !isKeyVaultReference(env) ? [env] : [];
}

module.exports = { ready, acceptedValues };
