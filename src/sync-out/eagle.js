'use strict';

/**
 * Sync-out consumer: ENGAGE-owned comment periods written into Eagle through eagle-api.
 *
 * To remove it: this file, its line in `./index.js`, the `syncOut.eagle` block in `src/config.js`, the
 * SYNC_OUT_EAGLE_ENABLED and EAGLE_* app settings in `azure/modules/api-function-flex.bicep`, and the
 * Eagle half of `src/scripts/reconcile-engage.js`, which reads `bodyFor` and `name` from here.
 */

const crypto = require('node:crypto');
const settings = require('../config').syncOut;
const commentPeriods = require('../repositories/comment-periods');
const { clientCredentialsToken } = require('../services/keycloak-client-token');
const { refId } = require('../controllers/nosql/eagle-mirror');
const { logger } = require('../utils/logger');

const NAME = 'eagle';
const TIMEOUT_MS = 10000;
const ERROR_BODY_CHARS = 300;
/** A create claim older than this belongs to a delivery that died: past a token, a GET, a PUT and a POST at TIMEOUT_MS each. */
const CLAIM_LEASE_MS = 180000;
/** Eagle ids a project move deleted that the row remembers, so their delete echo is not tombstoned. */
const DROPPED_IDS_KEPT = 20;
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
    ['EAGLE_PROTECTED_API_BASE', s.apiBase], ['EAGLE_KC_CLIENT_ID', s.clientId],
    ['EAGLE_KC_CLIENT_SECRET', s.clientSecret], ['EAGLE_ENGAGE_MILESTONE', s.milestone]
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`sync-out eagle is not configured: ${missing.join(', ')} not set`);
  return s;
}

async function token(s) {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  const { accessToken, expiresIn } = await clientCredentialsToken({
    issuer: s.issuer, clientId: s.clientId, clientSecret: s.clientSecret, timeoutMs: TIMEOUT_MS
  });
  cachedToken = {
    value: accessToken,
    expiresAt: Date.now() + Math.max(0, (expiresIn ?? 60) * 1000 - TOKEN_SKEW_MS)
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
    // The row's dates, which the ingest normalised to ISO UTC; the raw copy keeps ENGAGE's text.
    dateStarted: row.dateStarted,
    dateCompleted: row.dateCompleted,
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
 * Claim the create, so two deliveries never both POST. Returns the claim token, an `eagleId` another
 * writer stored meanwhile, or `missing` when the row is gone. `goneId` is a stored id Eagle no longer
 * holds; the claim clears it, so the echo of the new period can join the row by metURL.
 */
async function claimCreate(row, update, goneId) {
  const claim = crypto.randomUUID();
  let eagleId = null;
  let held = false;
  const result = await update((current) => {
    eagleId = current.eagleId && current.eagleId !== goneId ? current.eagleId : null;
    const entry = current.syncOut && current.syncOut[NAME];
    held = !eagleId && claimHeld(entry, Date.now());
    if (eagleId || held) return null;
    return {
      ...current,
      eagleId: null,
      syncOut: {
        ...current.syncOut,
        [NAME]: { ...entry, status: 'creating', claim, claimedAt: new Date().toISOString() }
      }
    };
  });
  if (result.status === 'missing') return { missing: true };
  if (held) throw new Error(`another delivery is creating the Eagle period for row ${row.id}`);
  return eagleId ? { eagleId } : { claim };
}

/** Restart the lease just before the POST, or throw when another delivery has taken the claim. */
async function refreshClaim(row, update, claim) {
  let ours = false;
  await update((current) => {
    const entry = (current.syncOut && current.syncOut[NAME]) || {};
    ours = entry.claim === claim;
    if (!ours) return null;
    return {
      ...current,
      syncOut: { ...current.syncOut, [NAME]: { ...entry, claimedAt: new Date().toISOString() } }
    };
  });
  if (!ours) throw new Error(`the create claim on row ${row.id} was taken by another delivery`);
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

/** Note on the row an Eagle id a project move is about to delete, before the DELETE so its echo finds it. */
function recordDropped(update, eagleId) {
  return update((current) => {
    const entry = (current.syncOut && current.syncOut[NAME]) || {};
    const kept = (entry.droppedIds || []).filter(id => id !== eagleId);
    const droppedIds = [...kept, eagleId].slice(-DROPPED_IDS_KEPT);
    return { ...current, syncOut: { ...current.syncOut, [NAME]: { ...entry, droppedIds } } };
  });
}

async function put(s, eagleId, body, logFields) {
  const path = `/commentperiod/${encodeURIComponent(eagleId)}`;
  const res = await call(s, 'PUT', path, body, { ...logFields, eagleId });
  if (missingOnPut(res)) return false;
  if (!res.ok) throw failure('PUT', path, res);
  return true;
}

/** DELETE one Eagle period; one Eagle no longer holds counts as deleted. */
async function remove(s, eagleId, logFields) {
  const path = `/commentperiod/${encodeURIComponent(eagleId)}`;
  const res = await call(s, 'DELETE', path, null, { ...logFields, eagleId });
  if (!res.ok && res.status !== 404) throw failure('DELETE', path, res);
}

/** An Eagle period under the project with the same metURL: a create that landed before its id was stored. */
async function findByMetUrl(s, body, logFields) {
  const path = `/commentperiod?project=${encodeURIComponent(body.project)}&fields=metURL`;
  const res = await call(s, 'GET', path, null, logFields);
  if (!res.ok) throw failure('GET', path, res);
  const list = Array.isArray(res.body) ? res.body : [];
  const match = list.find(period => period && period.metURL === body.metURL);
  return match ? String(match._id) : null;
}

/** True when DEMI already mirrors this Eagle period as its own Eagle-owned row: adopting it would make two rows one period. */
async function mirroredAsEagleRow(eagleId, row) {
  const stored = await commentPeriods.readForWrite(eagleId, row.projectId);
  return Boolean(stored && stored.id !== row.id && stored.sourceSystem === 'eagle');
}

const sent = (eagleId, body) => ({ status: 'sent', eagleId, record: { projectId: String(body.project) } });

async function create(s, row, body, update, logFields, goneId) {
  // An empty metURL leaves the echo nothing to join on and findByMetUrl nothing to match: every retry would POST again.
  if (!body.metURL) {
    logger.error(`[sync-out eagle] row ${row.id} has no metURL, no Eagle period created`, logFields);
    return { status: 'skipped' };
  }
  const claimed = await claimCreate(row, update, goneId);
  if (claimed.missing) return { status: 'skipped' };
  if (claimed.eagleId) {
    if (await put(s, claimed.eagleId, body, logFields)) return sent(claimed.eagleId, body);
    throw new Error(`Eagle has no comment period ${claimed.eagleId} stored on row ${row.id}`);
  }
  const { claim } = claimed;

  try {
    let eagleId = await findByMetUrl(s, body, logFields);
    if (eagleId && await mirroredAsEagleRow(eagleId, row)) {
      logger.error(`[sync-out eagle] Eagle period ${eagleId} on this metURL is already an Eagle-owned DEMI row, not adopted`,
        { ...logFields, candidateEagleId: eagleId, metURL: body.metURL });
      await endClaim(update, claim, 'conflict');
      return { status: 'conflict', record: { candidateEagleId: eagleId } };
    }
    if (!eagleId || !await put(s, eagleId, body, logFields)) {
      await refreshClaim(row, update, claim);
      const res = await call(s, 'POST', '/commentperiod', body, logFields);
      if (!res.ok || !res.body || !res.body._id) throw failure('POST', '/commentperiod', res);
      eagleId = String(res.body._id);
    }
    await endClaim(update, claim, 'sent', eagleId);
    return sent(eagleId, body);
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
    await remove(s, row.eagleId, logFields);
    return { status: 'sent', eagleId: row.eagleId };
  }

  const body = bodyFor(row, s);
  if (!row.eagleId) return create(s, row, body, update, logFields, null);

  // Before the first send, the Eagle copy's own project: an adopted row ENGAGE moved has no send record yet.
  const sentUnder = (row.syncOut && row.syncOut[NAME] && row.syncOut[NAME].projectId)
    || refId(row.sources && row.sources.eagle && row.sources.eagle.project);
  if (sentUnder && String(sentUnder) !== String(row.eagleProjectId)) {
    // eagle-api's PUT keeps a period's project, so a move is a delete under the old one and a create under the new.
    // create() refuses an empty metURL before anything is written, so check first rather than delete and stop.
    if (!body.metURL) return create(s, row, body, update, logFields, row.eagleId);
    logger.info(`[sync-out eagle] row ${row.id} moved project, recreating its Eagle period`,
      { ...logFields, from: String(sentUnder), to: String(row.eagleProjectId) });
    await recordDropped(update, String(row.eagleId));
    await remove(s, row.eagleId, logFields);
  } else if (await put(s, row.eagleId, body, logFields)) {
    return sent(row.eagleId, body);
  }
  return create(s, row, body, update, logFields, row.eagleId);
}

module.exports = {
  name: NAME,
  enabled: () => settings.eagle.enabled,
  wants: (row) => Boolean(row) && row.sourceSystem === 'engage',
  // Another delivery holds a live create claim: its outcome, not this one's failure, settles the row.
  inFlight: (entry) => Boolean(claimHeld(entry, Date.now())),
  send,
  bodyFor,
  clearToken
};
