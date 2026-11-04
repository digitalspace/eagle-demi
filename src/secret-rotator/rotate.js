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
// Promote waits over 5x the checkers' 5 min cache; APIM refreshes named values within 4 h.
const PROMOTE_AFTER = 30 * MINUTE;
const APIM_RETIRE_AFTER = 6 * HOUR;
const EDGE_SETTLE = 45 * MINUTE;
const VERIFY_AFTER = 10 * MINUTE;
const RETRY_AFTER = 24 * HOUR;
const MAX_ATTEMPTS = 2;
const STAMPERS = ['frontdoor', 'apim'];
const EDGE_HEADER = 'x-edge-secret';
const DEFAULT_CONTENT_TYPE = 'text/plain';

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
    const [name, date] = item.split('=');
    const at = Date.parse(`${date}T00:00:00Z`);
    if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || Number.isNaN(at)) {
      throw new Error(`ISSUER_EXPIRY entry '${item}' is not name=YYYY-MM-DD`);
    }
    return { name, date, at };
  });
  const ruleIds = list(env.EDGE_RULE_IDS);
  const badRule = ruleIds.find((id) => !frontDoorRuleUrl(id));
  if (badRule) throw new Error(`EDGE_RULE_IDS entry '${badRule}' is not a rules engine rule id`);
  // With no rules, retire would revoke O while Front Door still stamps it.
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

/** A new version of `name` holding `value`, valid 89 days. Returns the new version id. */
function write(s, name, value, tags) {
  if (!s.allowed.has(name)) throw new Error(`refusing write to ${name}: not a rotated, standby or renew name`);
  return s.vault.set(name, value, {
    expiresOn: new Date(s.nowMs + VALIDITY),
    contentType: s.current.contentType || DEFAULT_CONTENT_TYPE,
    tags
  });
}

function retag(s, stage, attempts = s.attempts) {
  return s.vault.tag(s.standby, s.spare.version, { ...s.spare.tags, ...stateTags(stage, s.nowMs, attempts) });
}

async function readRules(s) {
  return Promise.all(s.ruleIds.map(async (id) => {
    const url = frontDoorRuleUrl(id);
    const res = await s.arm('GET', url);
    if (!res.ok) throw new Error(`rule read ${res.status} for ${id}`);
    const props = (await res.json()).properties || {};
    const actions = props.actions || [];
    const stamp = actions.find((a) => a.name === 'ModifyRequestHeader' &&
      String((a.parameters || {}).headerName).toLowerCase() === EDGE_HEADER);
    if (!stamp) throw new Error(`rule ${id} has no X-Edge-Secret action`);
    return { id, url, actions, stamp, state: props.provisioningState, value: stamp.parameters.value };
  }));
}

/** PATCH each rule not already stamping `value`. True when every rule now holds it; a 409 waits for the next run. */
async function stampRules(s, rules, value) {
  let done = true;
  for (const rule of rules.filter((r) => r.value !== value)) {
    const actions = rule.actions.map((a) => (a === rule.stamp ? { ...a, parameters: { ...a.parameters, value } } : a));
    const res = await s.arm('PATCH', rule.url, { properties: { actions } });
    if (res.status === 409) {
      s.log.warn(`${TAG} ${s.name}: rule write conflict (409) on ${rule.id}; next run retries`);
      done = false;
    } else if (!res.ok) {
      throw new Error(`rule write ${res.status} for ${rule.id}`);
    }
  }
  return done;
}

async function mint(s, attempts) {
  if (!(await s.probe(s.entry.probe))) {
    s.log.error(`${TAG} FAILED ${s.name}: probe ${s.entry.probe} fails before mint; not minting`);
    return;
  }
  await write(s, s.standby, crypto.randomBytes(32).toString('base64url'), stateTags('minted', s.nowMs, attempts));
  s.log.info(`${TAG} minted ${s.name}`);
}

async function promote(s) {
  const next = s.spare.value;
  // Standby takes O before the name takes N, so N is never stamped while a checker cannot accept it.
  await write(s, s.standby, s.current.value, stateTags('promoted', s.nowMs, s.attempts));
  await write(s, s.name, next, s.current.tags || {});
  if (s.entry.stamper === 'frontdoor') await stampRules(s, await readRules(s), next);
  s.log.info(`${TAG} promoted ${s.name}`);
}

async function retireWhenReady(s) {
  if (s.entry.stamper === 'apim') {
    if (s.since >= APIM_RETIRE_AFTER) await retire(s);
    return;
  }
  const rules = await readRules(s);
  if (rules.some((r) => r.value !== s.current.value)) {
    await stampRules(s, rules, s.current.value);
    // rotation-at doubles as the time of the last PATCH, which the 45 min settle counts from.
    await retag(s, 'promoted');
    return;
  }
  if (rules.some((r) => r.state !== 'Succeeded') || s.since < EDGE_SETTLE) return;
  if (!(await s.probe(s.entry.probe))) {
    s.log.warn(`${TAG} ${s.name}: probe ${s.entry.probe} fails with both values accepted; retire waits`);
    return;
  }
  await retire(s);
}

async function retire(s) {
  await write(s, s.standby, s.current.value, stateTags('retired', s.nowMs, s.attempts));
  s.log.info(`${TAG} retired ${s.name}`);
}

async function verify(s) {
  if (s.since < VERIFY_AFTER) return;
  if (await s.probe(s.entry.probe)) {
    await retag(s, 'verified');
    s.log.info(`${TAG} verified ${s.name}`);
    return;
  }
  const attempts = s.attempts + 1;
  s.log.error(`${TAG} FAILED ${s.name}: probe ${s.entry.probe} fails after retire (attempt ${attempts}); restoring the old value`);
  const old = await s.vault.previous(s.standby);
  if (old === null) throw new Error('no earlier standby version to restore');
  const version = await write(s, s.standby, old, stateTags('restoring', s.nowMs, attempts));
  await restore({ ...s, attempts, spare: { value: old, version, tags: stateTags('restoring', s.nowMs, attempts) } });
}

/** Standby already holds O. Rules go back to O before the name does, so a 409 leaves {N, O} accepted. */
async function restore(s) {
  const old = s.spare.value;
  if (s.entry.stamper === 'frontdoor' && !(await stampRules(s, await readRules(s), old))) return;
  if (s.current.value !== old) await write(s, s.name, old, s.current.tags || {});
  await retag(s, s.attempts >= MAX_ATTEMPTS ? 'failed' : 'restored');
}

async function rotateOne(ctx, entry) {
  const current = await ctx.vault.get(entry.name);
  if (!current) throw new Error('secret not found');
  const standby = standbyName(entry.name);
  const spare = await ctx.vault.get(standby);
  const tags = (spare && spare.tags) || {};
  const at = Date.parse(tags['rotation-at'] || '') || 0;
  const s = {
    ...ctx, entry, name: entry.name, standby, current, spare,
    attempts: Number(tags['rotation-attempts']) || 0, since: ctx.nowMs - at
  };

  const stage = spare ? tags['rotation-stage'] || 'idle' : 'idle';
  switch (stage) {
    case 'idle':
    case 'verified':
      if (isDue(current, ctx.nowMs)) await mint(s, 0);
      return;
    case 'minted':
      if (s.since >= PROMOTE_AFTER) await promote(s);
      return;
    case 'promoted':
      if (current.value === spare.value) {
        s.log.warn(`${TAG} ${s.name}: promote stopped before the name was written; minting again`);
        await mint(s, s.attempts);
        return;
      }
      await retireWhenReady(s);
      return;
    case 'retired':
      await verify(s);
      return;
    case 'restoring':
      await restore(s);
      return;
    case 'restored':
      if (s.since >= RETRY_AFTER) await mint(s, s.attempts);
      return;
    case 'failed':
      s.log.error(`${TAG} FAILED ${s.name}: gave up after ${MAX_ATTEMPTS} attempts; both slots hold the old value, fix by hand`);
      return;
    default:
      throw new Error(`unknown rotation-stage '${stage}'`);
  }
}

/** Same value as a new version, exp +89 d, for every other enabled secret with an exp within 40 days. */
async function renew(ctx, rotatedNames) {
  let renewed = 0;
  let failed = 0;
  for (const props of await ctx.vault.list()) {
    const { name } = props;
    if (name.endsWith('-standby') || rotatedNames.has(name) || !props.enabled || !props.expiresOn) continue;
    if (!isDue(props, ctx.nowMs)) continue;
    try {
      const secret = await ctx.vault.get(name);
      ctx.allowed.add(name);
      await write({ ...ctx, current: secret }, name, secret.value, secret.tags || {});
      ctx.log.info(`${TAG} renewed ${name}`);
      renewed += 1;
    } catch (err) {
      ctx.log.error(`${TAG} FAILED renew ${name}: ${err.message}`);
      failed += 1;
    }
  }
  return { renewed, failed };
}

/**
 * One hourly pass. `vault`: get, previous, set, tag, list (see index.js); `arm(method, url, body)` returns
 * a fetch Response; `probe(kind)` resolves a boolean. Never deletes, never logs a value.
 */
async function run({ env = process.env, now = new Date(), vault, arm, probe, log }) {
  const nowMs = now.getTime();
  let config;
  try {
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
    if (at - nowMs <= ISSUER_WARN_WITHIN) log.warn(`${TAG} issuer expiry ${name} on ${date}: renew it at the issuer`);
  }
  log.info(`${TAG} run finished rotated=${config.rotated.length} renewed=${renewed} failed=${failed}`);
}

module.exports = { run };
