'use strict';

const crypto = require('node:crypto');
const { frontDoorRuleUrl } = require('../utils/azure-credential');
const { PROBES } = require('./probe');

const TAG = '[secret-rotator]';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DUE_WITHIN = 40 * DAY;
const VALIDITY = 89 * DAY;
const ISSUER_WARN_WITHIN = 30 * DAY;
// Over 5x the checkers' 5 min cache, so every instance accepts N before a stamper sends it.
const PROMOTE_AFTER = 30 * MINUTE;
// Checkers keep two cache generations; 10 min after promote every instance holds N, so edges may stamp it.
const STAMP_AFTER = 10 * MINUTE;
// APIM refreshes named values from the vault within 4 h.
const APIM_RETIRE_AFTER = 6 * HOUR;
const EDGE_SETTLE = 45 * MINUTE;
const VERIFY_AFTER = 10 * MINUTE;
const RETRY_AFTER = 24 * HOUR;
const STUCK_AFTER = 24 * HOUR;
const MAX_ATTEMPTS = 2;
const STAMPERS = ['frontdoor', 'apim'];
const EDGE_HEADER = 'x-edge-secret';
const DEFAULT_CONTENT_TYPE = 'text/plain';
const IDLE_STAGES = ['idle', 'verified'];

const standbyName = (name) => `${name}-standby`;
const list = (raw) => (raw || '').split(',').map((s) => s.trim()).filter(Boolean);

function parseConfig(env) {
  const rotated = list(env.ROTATED_SECRETS).map((item) => {
    const [name, stamper, probe, extra] = item.split(':');
    if (!name || !STAMPERS.includes(stamper) || !PROBES.includes(probe) || extra !== undefined) {
      throw new Error(`ROTATED_SECRETS entry '${item}' is not name:stamper:probe`);
    }
    return { name, stamper, probe };
  });
  const issuerExpiry = list(env.ISSUER_EXPIRY).map((item) => {
    const [name, date, extra] = item.split('=');
    const at = Date.parse(`${date}T00:00:00Z`);
    const real = /^\d{4}-\d{2}-\d{2}$/.test(date || '') && !Number.isNaN(at) && new Date(at).toISOString().startsWith(date);
    if (!name || !real || extra !== undefined) throw new Error(`ISSUER_EXPIRY entry '${item}' is not name=YYYY-MM-DD`);
    return { name, date, at };
  });
  // Must list every rule that stamps X-Edge-Secret (bicepparam: all three); one left out keeps stamping O after retire.
  const ruleIds = list(env.EDGE_RULE_IDS);
  const badRule = ruleIds.find((id) => !frontDoorRuleUrl(id));
  if (badRule) throw new Error(`EDGE_RULE_IDS entry '${badRule}' is not a rules engine rule id`);
  if (rotated.some((e) => e.stamper === 'frontdoor') && ruleIds.length === 0) {
    throw new Error('EDGE_RULE_IDS is empty but ROTATED_SECRETS has a frontdoor entry');
  }
  return { rotated, renew: env.RENEW === 'true', ruleIds, issuerExpiry };
}

const stateTags = (stage, nowMs, attempts) => ({
  'rotation-stage': stage,
  'rotation-at': new Date(nowMs).toISOString(),
  'rotation-attempts': String(attempts)
});

const isDue = (secret, nowMs) => !secret.expiresOn || secret.expiresOn.getTime() - nowMs <= DUE_WITHIN;

function guard(s, name) {
  if (!s.allowed.has(name)) throw new Error(`refusing write to ${name}: not a rotated, standby or renew name`);
}

/** A new version of `name` holding `value`, valid 89 days. Returns the new version id. */
function write(s, name, value, tags) {
  guard(s, name);
  return s.vault.set(name, value, {
    expiresOn: new Date(s.nowMs + VALIDITY),
    contentType: s.current.contentType || DEFAULT_CONTENT_TYPE,
    tags
  });
}

/** Replace the state tags on the latest standby version; `extra` adds or overrides single tags. */
function retag(s, stage, extra = {}) {
  guard(s, s.standby);
  const tags = { ...s.spare.tags, ...stateTags(stage, s.nowMs, s.attempts), ...extra };
  return s.vault.tag(s.standby, s.spare.version, tags);
}

async function readRules(s) {
  return Promise.all(s.ruleIds.map(async (id) => {
    const url = frontDoorRuleUrl(id);
    const res = await s.arm('GET', url);
    if (!res.ok) throw new Error(`rule read ${res.status} for ${id}`);
    // A JSON parse error quotes the body, and the body holds the live header value.
    const body = await res.json().catch(() => { throw new Error(`rule read: bad JSON for ${id}`); });
    const props = (body && body.properties) || {};
    const actions = props.actions || [];
    const stamp = actions.find((a) => a.name === 'ModifyRequestHeader' &&
      String((a.parameters || {}).headerName).toLowerCase() === EDGE_HEADER);
    if (!stamp) throw new Error(`rule ${id} has no X-Edge-Secret action`);
    return { id, url, actions, stamp, state: props.provisioningState, value: stamp.parameters.value };
  }));
}

/** PATCH each rule not already stamping `value`. A 409 is left for the next run. */
async function stampRules(s, rules, value) {
  for (const rule of rules.filter((r) => r.value !== value)) {
    const actions = rule.actions.map((a) => (a === rule.stamp ? { ...a, parameters: { ...a.parameters, value } } : a));
    const res = await s.arm('PATCH', rule.url, { properties: { actions } });
    if (res.status === 409) s.log.warn(`${TAG} ${s.name}: rule write conflict (409) on ${rule.id}; next run retries`);
    else if (!res.ok) throw new Error(`rule write ${res.status} for ${rule.id}`);
  }
}

async function mint(s) {
  if (!(await s.probe(s.entry.probe))) {
    s.log.error(`${TAG} FAILED ${s.name}: probe ${s.entry.probe} fails before mint; not minting`);
    return;
  }
  await write(s, s.standby, crypto.randomBytes(32).toString('base64url'), stateTags('minted', s.nowMs, 0));
  s.log.info(`${TAG} minted ${s.name}`);
}

async function promote(s) {
  const next = s.spare.value;
  // Standby takes O before the name takes N; edges are PATCHed on a later run (STAMP_AFTER).
  await write(s, s.standby, s.current.value, stateTags('promoted', s.nowMs, s.attempts));
  await write(s, s.name, next, s.current.tags || {});
  s.log.info(`${TAG} promoted ${s.name}`);
}

async function retireWhenReady(s) {
  if (s.entry.stamper === 'apim') {
    if (s.since >= APIM_RETIRE_AFTER) await retire(s);
    return;
  }
  if (s.since < STAMP_AFTER) return;
  const rules = await readRules(s);
  if (rules.some((r) => r.value !== s.current.value)) {
    await stampRules(s, rules, s.current.value);
    await retag(s, 'promoted', { 'rotation-at': s.spare.tags['rotation-at'], 'rotation-patched-at': new Date(s.nowMs).toISOString() });
    return waiting(s, 'rules not yet on the new value');
  }
  const patchedAt = Date.parse(s.spare.tags['rotation-patched-at'] || '') || s.at;
  if (rules.some((r) => r.state !== 'Succeeded')) return waiting(s, 'a rule is not Succeeded');
  if (s.nowMs - patchedAt < EDGE_SETTLE) return waiting(s, 'edge propagation');
  if (!(await s.probe(s.entry.probe))) return waiting(s, `probe ${s.entry.probe}`);
  await retire(s);
}

function waiting(s, reason) {
  if (s.since >= STUCK_AFTER) s.log.error(`${TAG} FAILED ${s.name}: promoted over 24 h, retire waiting on ${reason}`);
}

async function retire(s) {
  await write(s, s.standby, s.current.value, stateTags('retired', s.nowMs, s.attempts));
  s.log.info(`${TAG} retired ${s.name}`);
}

/** On failure only the standby goes back to O: stampers may still send N, so both values stay accepted. */
async function verify(s) {
  if (s.since < VERIFY_AFTER) return;
  if (await s.probe(s.entry.probe)) {
    await retag(s, 'verified');
    s.log.info(`${TAG} verified ${s.name}`);
    return;
  }
  const attempts = s.attempts + 1;
  const old = await s.vault.previous(s.standby);
  if (old === null) throw new Error('probe fails after retire and no earlier standby version to restore');
  await write(s, s.standby, old, stateTags(attempts >= MAX_ATTEMPTS ? 'failed' : 'restored', s.nowMs, attempts));
  s.log.error(`${TAG} FAILED ${s.name}: probe ${s.entry.probe} fails after retire (attempt ${attempts}); ` +
    'standby restored, both values accepted');
}

async function rotateOne(ctx, entry) {
  const current = await ctx.vault.get(entry.name);
  if (!current) throw new Error('secret not found');
  const standby = standbyName(entry.name);
  const spare = await ctx.vault.get(standby);
  const tags = (spare && spare.tags) || {};
  const stage = spare ? tags['rotation-stage'] || 'idle' : 'idle';
  const s = { ...ctx, entry, name: entry.name, standby, current, spare, attempts: 0, since: 0 };
  if (IDLE_STAGES.includes(stage)) {
    if (isDue(current, ctx.nowMs)) await mint(s);
    return;
  }

  // Bad state tags fail closed: a lost time restarts the wait, a lost count uses up the retries.
  s.attempts = /^\d+$/.test(tags['rotation-attempts'] || '') ? Number(tags['rotation-attempts']) : MAX_ATTEMPTS;
  const at = Date.parse(tags['rotation-at'] || '');
  if (Number.isNaN(at)) {
    s.log.warn(`${TAG} ${s.name}: rotation-at unreadable in stage ${stage}; restarting its wait`);
    await retag(s, stage);
    return;
  }
  s.at = at;
  s.since = ctx.nowMs - at;

  switch (stage) {
    case 'minted':
      if (s.since >= PROMOTE_AFTER) await promote(s);
      return;
    case 'promoted':
      if (current.value === spare.value) {
        s.log.warn(`${TAG} ${s.name}: promote stopped before the name was written; minting again`);
        await mint(s);
        return;
      }
      await retireWhenReady(s);
      return;
    case 'retired':
      await verify(s);
      return;
    case 'restored':
      if (s.since >= RETRY_AFTER) {
        await retag(s, 'promoted');
        s.log.info(`${TAG} ${s.name}: retrying retire (attempt ${s.attempts + 1})`);
      }
      return;
    case 'failed':
      s.log.error(`${TAG} FAILED ${s.name}: gave up after ${MAX_ATTEMPTS} attempts; both values accepted, fix by hand`);
      return;
    default:
      throw new Error(`unknown rotation-stage '${stage}'`);
  }
}

/** Same value as a new version, exp +89 d, for every other enabled secret with an exp within 40 days. */
async function renew(ctx, rotatedNames) {
  const due = (await ctx.vault.list()).filter((p) => !p.name.endsWith('-standby') && !rotatedNames.has(p.name) &&
    p.enabled && !p.managed && p.expiresOn && isDue(p, ctx.nowMs));
  due.forEach((p) => ctx.allowed.add(p.name));
  let renewed = 0;
  let failed = 0;
  for (const props of due) {
    try {
      const secret = await ctx.vault.get(props.name);
      // A version written since the list is someone else's change; rewriting the old value would revert it.
      if (secret.version !== props.version) {
        ctx.log.info(`${TAG} ${props.name}: new version since the list; renew waits for the next run`);
        continue;
      }
      await write({ ...ctx, current: secret }, props.name, secret.value, secret.tags || {});
      ctx.log.info(`${TAG} renewed ${props.name}`);
      renewed += 1;
    } catch (err) {
      ctx.log.error(`${TAG} FAILED renew ${props.name}: ${err.message}`);
      failed += 1;
    }
  }
  return { renewed, failed };
}

/** One hourly pass over the vault: rotate, renew, warn on issuer expiry. Never deletes, never logs a value. */
async function run({ env = process.env, now = new Date(), vault, arm, probe, log }) {
  const nowMs = now.getTime();
  let config;
  try {
    if (!vault) throw new Error('KEY_VAULT_URI is not set');
    config = parseConfig(env);
  } catch (err) {
    log.error(`${TAG} FAILED config: ${err.message}`);
    log.info(`${TAG} run finished rotated=0 renewed=0 failed=1`);
    return;
  }

  const rotatedNames = new Set(config.rotated.map((e) => e.name));
  const allowed = new Set([...rotatedNames, ...[...rotatedNames].map(standbyName)]);
  const ctx = { vault, arm, probe, log, nowMs, allowed, ruleIds: config.ruleIds };
  let failed = 0;
  for (const entry of config.rotated) {
    try {
      await rotateOne(ctx, entry);
    } catch (err) {
      log.error(`${TAG} FAILED ${entry.name}: ${err.message}`);
      failed += 1;
    }
  }

  let renewed = 0;
  if (config.renew) {
    try {
      const result = await renew(ctx, rotatedNames);
      renewed = result.renewed;
      failed += result.failed;
    } catch (err) {
      log.error(`${TAG} FAILED renew: ${err.message}`);
      failed += 1;
    }
  }

  for (const { name, date, at } of config.issuerExpiry) {
    if (at - nowMs <= ISSUER_WARN_WITHIN) log.warn(`${TAG} issuer-expiry ${name} on ${date}: renew it at the issuer`);
  }
  log.info(`${TAG} run finished rotated=${config.rotated.length} renewed=${renewed} failed=${failed}`);
}

const notFound = (err) => err.statusCode === 404 || err.code === 'SecretNotFound';

const properties = (p) => ({
  name: p.name,
  version: p.version,
  enabled: p.enabled !== false,
  managed: Boolean(p.managed),
  expiresOn: p.expiresOn || null,
  contentType: p.contentType || null,
  tags: p.tags || {}
});

/** The vault surface `run` uses, over an @azure/keyvault-secrets SecretClient. No delete method. */
function createVault(client) {
  return {
    async get(name) {
      try {
        const secret = await client.getSecret(name);
        return { ...properties(secret.properties), value: secret.value };
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
    },
    /** Value of the version created just before the latest one, or null. */
    async previous(name) {
      const versions = [];
      for await (const p of client.listPropertiesOfSecretVersions(name)) versions.push(p);
      versions.sort((a, b) => b.createdOn - a.createdOn);
      if (versions.length < 2) return null;
      return (await client.getSecret(name, { version: versions[1].version })).value;
    },
    async set(name, value, { expiresOn, contentType, tags }) {
      const secret = await client.setSecret(name, value, { expiresOn, contentType, tags });
      return secret.properties.version;
    },
    async tag(name, version, tags) {
      await client.updateSecretProperties(name, version, { tags });
    },
    async list() {
      const out = [];
      for await (const p of client.listPropertiesOfSecrets()) out.push(properties(p));
      return out;
    }
  };
}

module.exports = { run, createVault };
