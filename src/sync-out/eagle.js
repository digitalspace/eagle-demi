'use strict';

/**
 * Sync-out consumer: ENGAGE-owned comment periods written into Eagle through eagle-api.
 *
 * Remove this file, its line in `./index.js` and the `eagle` block in `./settings.js` to stop it.
 */

const crypto = require('node:crypto');
const settings = require('./settings');
const { logger } = require('../utils/logger');

const NAME = 'eagle';
const TIMEOUT_MS = 10000;
const ERROR_BODY_CHARS = 300;
/** A create claim older than this belongs to a delivery that died; longer than one create path takes. */
const CLAIM_LEASE_MS = 60000;
/** Re-mint this long before Keycloak's expiry so a token never lapses mid-call. */
const TOKEN_SKEW_MS = 30000;

let cachedToken = null;

/** Drop the cached bearer; the next call mints a new one. */
function clearToken() {
  cachedToken = null;
}

function requireSettings() {
  const s = settings.eagle;
  const missing = [
    ['EAGLE_API_BASE', s.apiBase], ['EAGLE_KC_ISSUER', s.issuer], ['EAGLE_KC_CLIENT_ID', s.clientId],
    ['EAGLE_KC_CLIENT_SECRET', s.clientSecret], ['EAGLE_ENGAGE_MILESTONE', s.milestone]
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`sync-out eagle is not configured: ${missing.join(', ')} not set`);
  return s;
}

async function token(s) {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  const res = await fetch(`${s.issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: s.clientId, client_secret: s.clientSecret
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`sync-out eagle token for ${s.clientId}: HTTP ${res.status}`);
  const body = await res.json();
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + Math.max(0, Number(body.expires_in || 60) * 1000 - TOKEN_SKEW_MS)
  };
  return cachedToken.value;
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** One eagle-api call. Re-mints the token once on 401; returns `{ status, ok, body }`. */
async function call(s, method, path, payload, logFields) {
  const request = async () => fetch(`${s.apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await token(s)}`,
      ...(payload ? { 'Content-Type': 'application/json' } : {})
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  let res = await request();
  if (res.status === 401) {
    clearToken();
    res = await request();
  }
  const body = await readBody(res);
  logger.info(`[sync-out eagle] ${method} ${path} ${res.status}`, { ...logFields, method, status: res.status });
  return { status: res.status, ok: res.ok, body };
}

function failure(method, path, res) {
  const detail = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
  return new Error(`eagle-api ${method} ${path}: HTTP ${res.status} ${String(detail || '').slice(0, ERROR_BODY_CHARS)}`);
}

/** eagle-api answers a PUT to an unknown id with 200 and a zero match count, not 404. */
const missingOnPut = (res) =>
  res.status === 404 || (res.ok && res.body && (res.body.matchedCount === 0 || res.body.n === 0));

/** eagle-api's comment period body. `milestone` always rides: eagle-api turns a missing one into a bad ObjectId. */
function bodyFor(row, s) {
  const src = (row.sources && row.sources.engage) || {};
  return {
    project: row.eagleProjectId,
    dateStarted: src.start,
    dateCompleted: src.end,
    isMet: true,
    metURL: src.metURL,
    metURLAdmin: src.metURLAdmin,
    metBannerImageUrl: src.bannerUrl,
    informationLabel: src.name,
    instructions: src.description,
    isPublished: Boolean(src.isPublished),
    milestone: s.milestone
  };
}

const claimHeld = (entry, now) => entry && entry.status === 'creating' &&
  now - Date.parse(entry.claimedAt) < CLAIM_LEASE_MS;

/**
 * Claim the create, so two deliveries never both POST. Returns the claim token, or an `eagleId`
 * another writer stored meanwhile. `goneId` is a stored id Eagle no longer has.
 */
async function claimCreate(row, update, goneId) {
  const claim = crypto.randomUUID();
  let eagleId = null;
  let held = false;
  await update((current) => {
    eagleId = current.eagleId && current.eagleId !== goneId ? current.eagleId : null;
    const entry = current.syncOut && current.syncOut[NAME];
    held = !eagleId && claimHeld(entry, Date.now());
    if (eagleId || held) return null;
    return {
      ...current,
      syncOut: {
        ...current.syncOut,
        [NAME]: { ...entry, status: 'creating', claim, claimedAt: new Date().toISOString() }
      }
    };
  });
  if (held) throw new Error(`another delivery is creating the Eagle period for row ${row.id}`);
  return eagleId ? { eagleId } : { claim };
}

/** End this delivery's create claim with `status`, storing `eagleId` when given. A lost claim is left alone. */
function endClaim(update, claim, status, eagleId = null) {
  return update((current) => {
    const entry = (current.syncOut && current.syncOut[NAME]) || {};
    const ours = entry.claim === claim;
    if (!ours && !eagleId) return null;
    const { claim: _claim, claimedAt: _claimedAt, ...rest } = entry;
    return {
      ...current,
      ...(eagleId ? { eagleId } : {}),
      syncOut: { ...current.syncOut, [NAME]: ours ? { ...rest, status } : entry }
    };
  });
}

async function put(s, eagleId, body, logFields) {
  const path = `/commentperiod/${encodeURIComponent(eagleId)}`;
  const res = await call(s, 'PUT', path, body, { ...logFields, eagleId });
  if (missingOnPut(res)) return false;
  if (!res.ok) throw failure('PUT', path, res);
  return true;
}

/** An Eagle period under the project with the same metURL: a create that landed before its id was stored. */
async function findByMetUrl(s, body, logFields) {
  if (!body.metURL) return null;
  const path = `/commentperiod?project=${encodeURIComponent(body.project)}&fields=metURL`;
  const res = await call(s, 'GET', path, null, logFields);
  if (!res.ok) throw failure('GET', path, res);
  const list = Array.isArray(res.body) ? res.body : [];
  const match = list.find(period => period && period.metURL === body.metURL);
  return match ? String(match._id) : null;
}

async function create(s, row, body, update, logFields) {
  const claimed = await claimCreate(row, update, row.eagleId);
  if (claimed.eagleId) {
    if (await put(s, claimed.eagleId, body, logFields)) return { status: 'sent', eagleId: claimed.eagleId };
    throw new Error(`Eagle has no comment period ${claimed.eagleId} stored on row ${row.id}`);
  }
  const { claim } = claimed;

  try {
    let eagleId = await findByMetUrl(s, body, logFields);
    if (!eagleId || !await put(s, eagleId, body, logFields)) {
      const res = await call(s, 'POST', '/commentperiod', body, logFields);
      if (!res.ok || !res.body || !res.body._id) throw failure('POST', '/commentperiod', res);
      eagleId = String(res.body._id);
    }
    await endClaim(update, claim, 'sent', eagleId);
    return { status: 'sent', eagleId };
  } catch (err) {
    await endClaim(update, claim, 'failed').catch((releaseErr) => logger.error('[sync-out eagle] claim not released',
      { ...logFields, error: releaseErr.message }));
    throw err;
  }
}

/** Write the row's current state to Eagle. `update` is the engine's etag-guarded write of this row. */
async function send(row, { update }) {
  const s = requireSettings();
  if (!row.eagleProjectId) throw new Error(`row ${row.id} has no eagleProjectId`);
  const logFields = { rowId: row.id, engagementId: row.engagementId, eagleId: row.eagleId || null };
  const deleted = Boolean(row.isDeleted || (row.sources && row.sources.engage && row.sources.engage.isDeleted));

  if (deleted) {
    if (!row.eagleId) return { status: 'skipped' };
    const path = `/commentperiod/${encodeURIComponent(row.eagleId)}`;
    const res = await call(s, 'DELETE', path, null, logFields);
    if (!res.ok && res.status !== 404) throw failure('DELETE', path, res);
    return { status: 'sent', eagleId: row.eagleId };
  }

  const body = bodyFor(row, s);
  if (row.eagleId && await put(s, row.eagleId, body, logFields)) {
    return { status: 'sent', eagleId: row.eagleId };
  }
  return create(s, row, body, update, logFields);
}

module.exports = {
  name: NAME,
  enabled: () => settings.eagle.enabled,
  wants: (row) => Boolean(row) && row.sourceSystem === 'engage',
  send,
  bodyFor,
  clearToken
};
