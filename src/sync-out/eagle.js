'use strict';

// Sync-out consumer: ENGAGE-owned and DEMI-native comment periods written into Eagle through eagle-api.
// Also wired in `./index.js`, `syncOut.eagle` in `src/config.js`, EAGLE_* bicep settings, reconcile-engage.js.

const crypto = require('node:crypto');
const settings = require('../config').syncOut;
const commentPeriods = require('../repositories/comment-periods');
const projects = require('../repositories/projects');
const { COMMENT_PERIOD } = require('./kinds');
const { clientCredentialsToken } = require('../services/keycloak-client-token');
const { refId } = require('../controllers/nosql/eagle-mirror');
const { logger } = require('../utils/logger');
const { isScanCleared } = require('../repositories/documents');

const NAME = 'eagle';
/** Rows created in DEMI: sent under an Eagle id DEMI mints, never joined by metURL. */
const NATIVE = 'demi';
const TIMEOUT_MS = 30000;
const ERROR_BODY_CHARS = 300;
/** A create claim older than this belongs to a delivery that died: past a token, a GET, a PUT and a POST at TIMEOUT_MS each (120s). */
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

/** The eagle-api settings; `milestone: false` for a consumer that sends no comment period. */
function requireSettings({ milestone = true } = {}) {
  const s = settings.eagle;
  const missing = [
    ['EAGLE_PROTECTED_API_BASE', s.apiBase], ['EAGLE_KC_CLIENT_ID', s.clientId],
    ['EAGLE_KC_CLIENT_SECRET', s.clientSecret], ...(milestone ? [['EAGLE_ENGAGE_MILESTONE', s.milestone]] : [])
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
function bodyFor(row, s, project = row.eagleProjectId) {
  if (row.sourceSystem === NATIVE) {
    return {
      project,
      dateStarted: row.dateStarted,
      dateCompleted: row.dateCompleted,
      isMet: Boolean(row.isMet),
      metURL: row.metURL,
      metURLAdmin: row.metURLAdmin,
      metBannerImageUrl: row.metBannerImageUrl,
      informationLabel: row.informationLabel,
      instructions: row.instructions,
      commentTip: row.commentTip,
      openHouses: row.openHouses,
      relatedDocuments: row.relatedDocuments,
      isPublished: Boolean(row.isPublished),
      milestone: row.milestone || s.milestone
    };
  }
  const src = (row.sources && row.sources.engage) || {};
  return {
    project,
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

/** An ObjectId-shaped id: 4-byte seconds then 8 random bytes, so Eagle's `_id` order stays creation order. */
function mintEagleId() {
  const seconds = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
  return seconds + crypto.randomBytes(8).toString('hex');
}

/**
 * Claim an ENGAGE create so two deliveries never both POST: the claim, an `eagleId` stored meanwhile, or
 * `missing`. `goneId`, a stored id Eagle lost, is cleared so the new period's echo joins by metURL.
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

/**
 * Claim the create of a native row and store its Eagle id in the same write, so the echo of the POST finds
 * the row. A live claim blocks whether or not it holds an id; a lapsed one is retaken with the stored id.
 */
async function claimMinted(row, update, kind) {
  const claim = crypto.randomUUID();
  let held = false;
  let minted = false;
  let eagleId = null;
  let strayRow = null;
  const result = await update((current) => {
    const entry = current.syncOut && current.syncOut[NAME];
    // A delivery that read the row before another recorded a stray must not take the claim and POST again.
    if (Object.hasOwn(entry || {}, 'strayEagleId')) {
      strayRow = current;
      return null;
    }
    held = claimHeld(entry, Date.now());
    if (held) return null;
    minted = !current.eagleId;
    eagleId = current.eagleId || mintEagleId();
    return {
      ...current,
      eagleId,
      syncOut: {
        ...current.syncOut,
        [NAME]: { ...entry, status: 'creating', claim, claimedAt: new Date().toISOString() }
      }
    };
  });
  if (result.status === 'missing') return { missing: true };
  if (strayRow) refuseStray(strayRow);
  if (held) throw new Error(`another delivery is creating the Eagle copy of ${kind} ${row.id}`);
  if (minted) {
    logger.info(`[sync-out eagle] minted Eagle id ${eagleId} for ${kind} ${row.id}`, { rowId: row.id, eagleId, kind });
  }
  return { claim, eagleId };
}

/** Restart the lease just before the next eagle-api write, or throw when another delivery has taken the claim. */
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
  if (!ours) throw new Error(`the send claim on row ${row.id} was taken by another delivery`);
}

/**
 * End this delivery's create claim with `status`, storing `eagleId` when given. A lost claim keeps its
 * status; `extra` entry fields are written either way.
 */
function endClaim(update, claim, status, eagleId = null, extra = null) {
  return update((current) => {
    const entry = (current.syncOut && current.syncOut[NAME]) || {};
    const ours = entry.claim === claim;
    if (!ours && !eagleId && !extra) return null;
    const { claim: _claim, claimedAt: _claimedAt, ...rest } = entry;
    return {
      ...current,
      ...(eagleId ? { eagleId } : {}),
      syncOut: { ...current.syncOut, [NAME]: ours ? { ...rest, ...extra, status } : { ...entry, ...extra } }
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

/** DELETE one Eagle period; a 404 counts as deleted. */
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

/**
 * Create a native period under its stored or newly minted id. A 409 means an earlier POST landed and its
 * answer was lost, or another delivery won: the period exists, so PUT.
 */
async function createNative(s, row, body, update, logFields) {
  const claimed = await claimMinted(row, update, COMMENT_PERIOD);
  if (claimed.missing) return { status: 'skipped' };
  const { claim, eagleId } = claimed;
  const fields = { ...logFields, eagleId };
  let stray;
  try {
    const res = await call(s, 'POST', '/commentperiod', { ...body, _id: eagleId }, fields);
    if (res.status === 409) {
      logger.info(`[sync-out eagle] Eagle already holds ${eagleId} for row ${row.id}, PUT instead`, fields);
      if (!await put(s, eagleId, body, fields)) {
        throw new Error(`eagle-api answered 409 for ${eagleId} but its PUT found no comment period`);
      }
    } else if (!res.ok) {
      throw failure('POST', '/commentperiod', res);
    } else {
      const answered = res.body && res.body._id ? String(res.body._id) : null;
      // An answer without `_id` may still be ours: a PUT that matches shows Eagle stored it under our id.
      if (answered !== eagleId && (answered || !await put(s, eagleId, body, fields))) {
        // eagle-api ignored `_id`: each POST adds another Eagle period, so the stored stray stops every retry.
        stray = { strayEagleId: answered };
        if (answered) {
          logger.error(`[sync-out eagle] eagle-api stored row ${row.id} as ${answered}, not ${eagleId}; not re-keyed. ` +
            `${answered} is also the id of the DEMI mirror row its echo made`, { ...fields, ...stray, mirrorRowId: answered });
        } else {
          logger.error(`[sync-out eagle] row ${row.id}: Eagle stored the period under an unknown id; find it by project and dates`,
            { rowId: row.id, eagleProjectId: body.project });
        }
        throw new Error(`eagle-api ignored _id ${eagleId} for row ${row.id}`);
      }
    }
    await endClaim(update, claim, 'sent');
    // eagle-api awaits its DEMI push before answering, so the echo has landed; Session consistency can still miss the claim.
    try {
      if (await mirroredAsEagleRow(eagleId, row)) {
        logger.error(`[sync-out eagle] row ${row.id}: echo created mirror twin ${eagleId}; merge by hand`,
          { rowId: row.id, eagleId, twinRowId: eagleId });
      }
    } catch (e) {
      logger.warn(`[sync-out eagle] row ${row.id}: twin check failed`, { rowId: row.id, eagleId, error: e.message });
    }
    return sent(eagleId, body);
  } catch (err) {
    await endClaim(update, claim, 'failed', null, stray).catch((releaseErr) => logger.error(
      `[sync-out eagle] claim not released${stray ? `, stray Eagle id ${stray.strayEagleId} not recorded` : ''}`,
      { ...fields, ...stray, error: releaseErr.message }));
    throw err;
  }
}

/** A native row Eagle stored under another id: any further POST or DELETE only adds to what must be cleared by hand. */
function refuseStray(row) {
  const entry = (row.syncOut && row.syncOut[NAME]) || {};
  if (Object.hasOwn(entry, 'strayEagleId')) {
    throw new Error(`row ${row.id} was stored in Eagle as ${entry.strayEagleId}, not ${row.eagleId}; nothing sent`);
  }
}

/** A native period's Eagle project id, from its parent project. Without one there is nothing to POST under. */
async function parentEagleId(row, logFields) {
  const parent = await projects.readForWrite(row.projectId);
  if (parent && parent.eagleId) return String(parent.eagleId);
  logger.error(`[sync-out eagle] project ${row.projectId} of row ${row.id} has no eagleId, nothing sent`,
    { ...logFields, parentId: row.projectId });
  throw new Error(`project ${row.projectId} of row ${row.id} has no eagleId`);
}

/** A row ENGAGE or DEMI deleted: send() removes its Eagle copy. */
const isDeletedRow = row => Boolean(row.isDeleted || (row.sources && row.sources.engage && row.sources.engage.isDeleted));

/** Read-only GET client for reconcile scripts: own token, injected fetch, no milestone needed. */
function eagleReader(get) {
  const s = settings.eagle;
  const missing = [
    ['EAGLE_PROTECTED_API_BASE', s.apiBase], ['EAGLE_KC_CLIENT_ID', s.clientId],
    ['EAGLE_KC_CLIENT_SECRET', s.clientSecret]
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) return { missing };

  let bearer = null;
  const token = async () => {
    bearer = bearer || (await clientCredentialsToken({
      issuer: s.issuer, clientId: s.clientId, clientSecret: s.clientSecret, timeoutMs: TIMEOUT_MS, fetch: get
    })).accessToken;
    return bearer;
  };
  const request = async path => get(`${s.apiBase}${path}`, {
    headers: { Authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  return {
    async getJson(path) {
      let res = await request(path);
      if (res.status === 401) {
        bearer = null;
        res = await request(path);
      }
      return { status: res.status, ok: res.ok, body: res.ok ? await res.json() : null };
    }
  };
}

let nativeOffLogged = false;

/** ENGAGE rows, and native rows once SYNC_OUT_EAGLE_NATIVE_ENABLED is on; the refusal is logged once per off spell. */
function wants(row) {
  if (!row || !isScanCleared(row)) return false;
  if (row.sourceSystem === 'engage') return true;
  if (row.sourceSystem !== NATIVE) return false;
  if (settings.eagle.nativeEnabled) {
    nativeOffLogged = false;
    return true;
  }
  if (!nativeOffLogged) {
    nativeOffLogged = true;
    logger.info('[sync-out eagle] SYNC_OUT_EAGLE_NATIVE_ENABLED is not true, DEMI-native rows are not sent',
      { rowId: row.id });
  }
  return false;
}

/** Write the row's current state to Eagle. `update` is the engine's etag-guarded write of this row. */
async function send(row, { update }) {
  const s = requireSettings();
  const native = row.sourceSystem === NATIVE;
  // Also checked in wants(): queued messages and retries reach send() without it. Held, not skipped:
  // a skip records the version as sent, so the row would never go once the switch is on.
  if (native && !settings.eagle.nativeEnabled) return { status: 'held' };
  if (!native && !row.eagleProjectId) throw new Error(`row ${row.id} has no eagleProjectId`);
  const logFields = {
    rowId: row.id, ...(native ? {} : { engagementId: row.engagementId }), eagleId: row.eagleId || null
  };
  if (native) refuseStray(row);
  if (isDeletedRow(row)) {
    if (!row.eagleId) return { status: 'skipped' };
    await remove(s, row.eagleId, logFields);
    return { status: 'sent', eagleId: row.eagleId };
  }

  if (native) {
    const body = bodyFor(row, s, await parentEagleId(row, logFields));
    // Until a create has landed, PUT cannot tell a missing period from one not yet created.
    const created = Number.isInteger(row.syncOut && row.syncOut[NAME] && row.syncOut[NAME].sentVersion);
    if (row.eagleId && created && await put(s, row.eagleId, body, logFields)) return sent(row.eagleId, body);
    return createNative(s, row, body, update, logFields);
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
  enableSettings: Object.freeze(['SYNC_OUT_EAGLE_ENABLED']),
  wants,
  // Another delivery holds a live create claim: its outcome, not this one's failure, settles the row.
  inFlight: (entry) => Boolean(claimHeld(entry, Date.now())),
  send,
  bodyFor,
  requireSettings,
  call,
  failure,
  token,
  clearToken,
  mintEagleId,
  claimHeld,
  claimMinted,
  refreshClaim,
  endClaim,
  isDeletedRow,
  eagleReader
};
