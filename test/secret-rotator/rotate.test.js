'use strict';

// The rotator against an in-memory vault, a fake ARM and a fake probe. Time is the `now` each run gets.

const test = require('node:test');
const assert = require('node:assert');

const { run } = require('../../src/secret-rotator/rotate');
const { createProbe } = require('../../src/secret-rotator/probe');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-11-04T00:00:00Z');
const OLD = 'old-value-0123456789';
const RULES = [
  '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Cdn/profiles/eagle-edge-test/ruleSets/rulesdemi/rules/stampedgesecret',
  '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Cdn/profiles/eagle-edge-test/ruleSets/rulesapi/rules/stampedgesecret'
];
const APIM_ENV = { ROTATED_SECRETS: 'apim-gateway-secret:apim:demi-gateway' };
const EDGE_ENV = { ROTATED_SECRETS: 'edge-secret:frontdoor:demi-edge', EDGE_RULE_IDS: RULES.join(',') };

function fakeVault(seed) {
  const store = new Map();
  const writes = [];
  let seq = 0;
  const add = (name, fields) => {
    const version = `v${++seq}`;
    const versions = store.get(name) || [];
    versions.push({ name, version, enabled: true, expiresOn: null, contentType: null, tags: {}, ...fields });
    store.set(name, versions);
    return version;
  };
  Object.entries(seed).forEach(([name, fields]) => add(name, fields));
  const latest = (name) => (store.get(name) || []).at(-1) || null;
  return {
    writes,
    latest,
    versions: (name) => store.get(name) || [],
    allValues: () => [...store.values()].flat().map((v) => v.value),
    async get(name) {
      const s = latest(name);
      return s ? { ...s, tags: { ...s.tags } } : null;
    },
    async previous(name) {
      const versions = store.get(name) || [];
      return versions.length < 2 ? null : versions.at(-2).value;
    },
    async set(name, value, options) {
      writes.push(name);
      return add(name, { value, ...options });
    },
    async tag(name, version, tags) {
      writes.push(name);
      store.get(name).find((v) => v.version === version).tags = { ...tags };
    },
    async list() {
      return [...store.keys()].map((name) => {
        const { value: _value, ...props } = latest(name);
        return props;
      });
    }
  };
}

function fakeArm(value) {
  const rules = new Map(RULES.map((id) => [id, {
    provisioningState: 'Succeeded',
    actions: [
      { name: 'RouteConfigurationOverride', parameters: { typeName: 'x' } },
      { name: 'ModifyRequestHeader', parameters: { headerAction: 'Overwrite', headerName: 'X-Edge-Secret', value } }
    ]
  }]));
  const arm = {
    stateAfterPatch: 'Succeeded',
    conflicts: new Set(),
    patches: [],
    value: (id) => rules.get(id).actions[1].parameters.value,
    setValue: (id, v) => { rules.get(id).actions[1].parameters.value = v; },
    async request(method, url, body) {
      const id = new URL(url).pathname;
      const rule = rules.get(id);
      if (method === 'GET') return { ok: true, status: 200, json: async () => ({ properties: structuredClone(rule) }) };
      if (arm.conflicts.delete(id)) return { ok: false, status: 409 };
      rule.actions = body.properties.actions;
      rule.provisioningState = arm.stateAfterPatch;
      arm.patches.push(id);
      return { ok: true, status: 200 };
    }
  };
  return arm;
}

function harness({ env, secrets }) {
  const vault = fakeVault(secrets);
  const arm = fakeArm(OLD);
  const pass = { 'demi-edge': true, 'demi-gateway': true, analytics: true, none: true };
  const lines = [];
  const log = {
    info: (m) => lines.push({ level: 'info', m }),
    warn: (m) => lines.push({ level: 'warn', m }),
    error: (m) => lines.push({ level: 'error', m })
  };
  const at = (ms) => run({ env, now: new Date(ms), vault, arm: arm.request, probe: async (kind) => pass[kind], log });
  return { vault, arm, pass, lines, at };
}

const rotated = (name, fields = {}) => ({
  [name]: { value: OLD, expiresOn: new Date(T0 + 10 * DAY), contentType: 'text/plain', tags: { owner: 'demi' }, ...fields }
});
const standbyOf = (h, name) => h.vault.latest(`${name}-standby`);
const stageOf = (h, name) => standbyOf(h, name)?.tags['rotation-stage'];
const failedLines = (h) => h.lines.filter((l) => l.m.startsWith('[secret-rotator] FAILED'));

/** Mint at `start`, promote 30 min later, retire 6 h after that. Returns the retire time. */
async function apimToRetired(h, start) {
  await h.at(start);
  await h.at(start + 30 * MIN);
  await h.at(start + 30 * MIN + 6 * HOUR);
  return start + 30 * MIN + 6 * HOUR;
}

/** Mint at T0 and promote 30 min later. Returns the promote time. */
async function edgeToPromoted(h) {
  await h.at(T0);
  await h.at(T0 + 30 * MIN);
  return T0 + 30 * MIN;
}

test('mint', async (t) => {
  await t.test('a secret with null exp is due: the first run mints a standby, name untouched', async () => {
    const h = harness({ env: APIM_ENV, secrets: rotated('apim-gateway-secret', { expiresOn: null }) });
    await h.at(T0);
    assert.strictEqual(stageOf(h, 'apim-gateway-secret'), 'minted');
    assert.strictEqual(standbyOf(h, 'apim-gateway-secret').value.length, 43, '32 random bytes, base64url');
    assert.strictEqual(standbyOf(h, 'apim-gateway-secret').expiresOn.getTime(), T0 + 89 * DAY);
    assert.strictEqual(h.vault.latest('apim-gateway-secret').value, OLD);
  });

  await t.test('exp 41 days away: nothing is written', async () => {
    const h = harness({ env: APIM_ENV, secrets: rotated('apim-gateway-secret', { expiresOn: new Date(T0 + 41 * DAY) }) });
    await h.at(T0);
    assert.deepStrictEqual(h.vault.writes, []);
  });

  await t.test('a source with null contentType mints text/plain', async () => {
    const h = harness({ env: APIM_ENV, secrets: rotated('apim-gateway-secret', { contentType: null }) });
    await h.at(T0);
    assert.strictEqual(standbyOf(h, 'apim-gateway-secret').contentType, 'text/plain');
  });
});

test('promote waits 30 min after mint, then standby takes O and the name takes N', async () => {
  const h = harness({ env: APIM_ENV, secrets: rotated('apim-gateway-secret') });
  await h.at(T0);
  const minted = standbyOf(h, 'apim-gateway-secret').value;
  await h.at(T0 + 29 * MIN);
  assert.strictEqual(h.vault.latest('apim-gateway-secret').value, OLD, 'not promoted at 29 min');
  await h.at(T0 + 30 * MIN);
  assert.strictEqual(h.vault.latest('apim-gateway-secret').value, minted);
  assert.strictEqual(standbyOf(h, 'apim-gateway-secret').value, OLD);
});

test('apim retire waits 6 h after promote', async () => {
  const h = harness({ env: APIM_ENV, secrets: rotated('apim-gateway-secret') });
  await h.at(T0);
  await h.at(T0 + 30 * MIN);
  await h.at(T0 + 30 * MIN + 6 * HOUR - MIN);
  assert.strictEqual(standbyOf(h, 'apim-gateway-secret').value, OLD, 'still accepting O at 5 h 59 min');
  await h.at(T0 + 30 * MIN + 6 * HOUR);
  assert.strictEqual(stageOf(h, 'apim-gateway-secret'), 'retired');
  assert.strictEqual(standbyOf(h, 'apim-gateway-secret').value, h.vault.latest('apim-gateway-secret').value);
});

test('frontdoor retire', async (t) => {
  await t.test('promote PATCHes every rule to N', async () => {
    const h = harness({ env: EDGE_ENV, secrets: rotated('edge-secret') });
    await edgeToPromoted(h);
    const next = h.vault.latest('edge-secret').value;
    assert.deepStrictEqual(RULES.map(h.arm.value), [next, next]);
  });

  await t.test('runs once rules are Succeeded with N, 45 min passed and the probe passes', async () => {
    const h = harness({ env: EDGE_ENV, secrets: rotated('edge-secret') });
    const promoted = await edgeToPromoted(h);
    await h.at(promoted + 45 * MIN);
    assert.strictEqual(stageOf(h, 'edge-secret'), 'retired');
  });

  await t.test('waits while a rule is not Succeeded', async () => {
    const h = harness({ env: EDGE_ENV, secrets: rotated('edge-secret') });
    h.arm.stateAfterPatch = 'Updating';
    const promoted = await edgeToPromoted(h);
    await h.at(promoted + 45 * MIN);
    assert.strictEqual(stageOf(h, 'edge-secret'), 'promoted');
  });

  await t.test('waits for 45 min after the last PATCH', async () => {
    const h = harness({ env: EDGE_ENV, secrets: rotated('edge-secret') });
    const promoted = await edgeToPromoted(h);
    await h.at(promoted + 44 * MIN);
    assert.strictEqual(stageOf(h, 'edge-secret'), 'promoted');
  });

  await t.test('waits while the demi-edge probe fails', async () => {
    const h = harness({ env: EDGE_ENV, secrets: rotated('edge-secret') });
    const promoted = await edgeToPromoted(h);
    h.pass['demi-edge'] = false;
    await h.at(promoted + 45 * MIN);
    assert.strictEqual(stageOf(h, 'edge-secret'), 'promoted');
  });

  await t.test('a rule reading back O is PATCHed again and retire waits', async () => {
    const h = harness({ env: EDGE_ENV, secrets: rotated('edge-secret') });
    const promoted = await edgeToPromoted(h);
    h.arm.setValue(RULES[1], OLD);
    await h.at(promoted + 45 * MIN);
    assert.strictEqual(stageOf(h, 'edge-secret'), 'promoted');
    assert.strictEqual(h.arm.value(RULES[1]), h.vault.latest('edge-secret').value);
  });

  await t.test('a 409 on a rule PATCH is retried on the next run', async () => {
    const h = harness({ env: EDGE_ENV, secrets: rotated('edge-secret') });
    h.arm.conflicts.add(RULES[1]);
    const promoted = await edgeToPromoted(h);
    assert.strictEqual(h.arm.value(RULES[1]), OLD, 'conflicted rule unchanged');
    await h.at(promoted + HOUR);
    assert.strictEqual(h.arm.value(RULES[1]), h.vault.latest('edge-secret').value);
  });
});

test('verify', async (t) => {
  await t.test('a failing probe 10 min after retire restores O in both slots and counts an attempt', async () => {
    const h = harness({ env: APIM_ENV, secrets: rotated('apim-gateway-secret') });
    const retired = await apimToRetired(h, T0);
    h.pass['demi-gateway'] = false;
    await h.at(retired + 10 * MIN);
    assert.strictEqual(h.vault.latest('apim-gateway-secret').value, OLD);
    assert.strictEqual(standbyOf(h, 'apim-gateway-secret').value, OLD);
    assert.strictEqual(stageOf(h, 'apim-gateway-secret'), 'restored');
    assert.strictEqual(standbyOf(h, 'apim-gateway-secret').tags['rotation-attempts'], '1');
    assert.strictEqual(failedLines(h).length, 1);
  });

  await t.test('a failing probe on the frontdoor class PATCHes the rules back to O', async () => {
    const h = harness({ env: EDGE_ENV, secrets: rotated('edge-secret') });
    const promoted = await edgeToPromoted(h);
    await h.at(promoted + 45 * MIN);
    h.pass['demi-edge'] = false;
    await h.at(promoted + 55 * MIN);
    assert.deepStrictEqual(RULES.map(h.arm.value), [OLD, OLD]);
    assert.strictEqual(h.vault.latest('edge-secret').value, OLD);
  });

  await t.test('a 409 while restoring keeps N in the name until every rule is back on O', async () => {
    const h = harness({ env: EDGE_ENV, secrets: rotated('edge-secret') });
    const promoted = await edgeToPromoted(h);
    await h.at(promoted + 45 * MIN);
    const next = h.vault.latest('edge-secret').value;
    h.pass['demi-edge'] = false;
    h.arm.conflicts.add(RULES[1]);
    await h.at(promoted + 55 * MIN);
    assert.strictEqual(h.vault.latest('edge-secret').value, next, 'rule still stamps N, so N stays accepted');
    await h.at(promoted + 115 * MIN);
    assert.strictEqual(h.arm.value(RULES[1]), OLD);
    assert.strictEqual(h.vault.latest('edge-secret').value, OLD);
  });

  await t.test('a restored secret mints again only after 24 h', async () => {
    const h = harness({ env: APIM_ENV, secrets: rotated('apim-gateway-secret') });
    const retired = await apimToRetired(h, T0);
    h.pass['demi-gateway'] = false;
    await h.at(retired + 10 * MIN);
    h.pass['demi-gateway'] = true;
    await h.at(retired + 10 * MIN + 23 * HOUR);
    assert.strictEqual(stageOf(h, 'apim-gateway-secret'), 'restored');
    await h.at(retired + 10 * MIN + 24 * HOUR);
    assert.strictEqual(stageOf(h, 'apim-gateway-secret'), 'minted');
    assert.strictEqual(standbyOf(h, 'apim-gateway-secret').tags['rotation-attempts'], '1');
  });

  await t.test('a second failure stops in stage failed, writes nothing more and alerts every run', async () => {
    const h = harness({ env: APIM_ENV, secrets: rotated('apim-gateway-secret') });
    const first = await apimToRetired(h, T0);
    h.pass['demi-gateway'] = false;
    await h.at(first + 10 * MIN);
    h.pass['demi-gateway'] = true;
    const second = await apimToRetired(h, first + 10 * MIN + 24 * HOUR);
    h.pass['demi-gateway'] = false;
    await h.at(second + 10 * MIN);
    assert.strictEqual(stageOf(h, 'apim-gateway-secret'), 'failed');
    const writes = h.vault.writes.length;
    const alerts = failedLines(h).length;
    await h.at(second + 3 * DAY);
    assert.strictEqual(h.vault.writes.length, writes, 'no write once failed');
    assert.strictEqual(failedLines(h).length, alerts + 1);
  });
});

test('renew', async (t) => {
  const renewEnv = { RENEW: 'true' };

  await t.test('writes the same value with exp +89 d and copies tags and contentType', async () => {
    const h = harness({ env: renewEnv, secrets: {
      'docling-api-key': { value: 'issuer-value', expiresOn: new Date(T0 + 5 * DAY), contentType: 'application/json', tags: { issuer: 'docling' } }
    } });
    await h.at(T0);
    const latest = h.vault.latest('docling-api-key');
    assert.strictEqual(h.vault.versions('docling-api-key').length, 2);
    assert.strictEqual(latest.value, 'issuer-value');
    assert.strictEqual(latest.expiresOn.getTime(), T0 + 89 * DAY);
    assert.strictEqual(latest.contentType, 'application/json');
    assert.deepStrictEqual(latest.tags, { issuer: 'docling' });
  });

  await t.test('sets text/plain when the source has no contentType', async () => {
    const h = harness({ env: renewEnv, secrets: { 'apim-gw': { value: 'x', expiresOn: new Date(T0 + 5 * DAY) } } });
    await h.at(T0);
    assert.strictEqual(h.vault.latest('apim-gw').contentType, 'text/plain');
  });

  await t.test('skips -standby names, secrets with no exp and disabled secrets', async () => {
    const h = harness({ env: renewEnv, secrets: {
      'edge-secret-standby': { value: 'a', expiresOn: new Date(T0 + DAY) },
      'track-client-secret': { value: 'b', expiresOn: null },
      'old-key': { value: 'c', expiresOn: new Date(T0 + DAY), enabled: false }
    } });
    await h.at(T0);
    assert.deepStrictEqual(h.vault.writes, []);
  });
});

test('no write lands outside the rotated, standby and renew lists', async () => {
  const h = harness({
    env: { ...APIM_ENV, RENEW: 'true' },
    secrets: {
      ...rotated('apim-gateway-secret'),
      'docling-api-key': { value: 'd', expiresOn: new Date(T0 + 5 * DAY) },
      'admin-api-key': { value: 'a', expiresOn: new Date(T0 + 60 * DAY) },
      'old-key': { value: 'c', expiresOn: new Date(T0 + DAY), enabled: false }
    }
  });
  const retired = await apimToRetired(h, T0);
  await h.at(retired + 10 * MIN);
  assert.deepStrictEqual([...new Set(h.vault.writes)].sort(),
    ['apim-gateway-secret', 'apim-gateway-secret-standby', 'docling-api-key']);
});

test('empty ROTATED_SECRETS and RENEW write nothing and still log run finished', async () => {
  const h = harness({ env: {}, secrets: { 'docling-api-key': { value: 'd', expiresOn: new Date(T0 + DAY) } } });
  await h.at(T0);
  assert.deepStrictEqual(h.vault.writes, []);
  assert.ok(h.lines.some((l) => l.m.startsWith('[secret-rotator] run finished')));
});

test('a frontdoor entry with no EDGE_RULE_IDS writes nothing and logs FAILED', async () => {
  const h = harness({ env: { ROTATED_SECRETS: EDGE_ENV.ROTATED_SECRETS }, secrets: rotated('edge-secret') });
  await h.at(T0);
  assert.deepStrictEqual(h.vault.writes, []);
  assert.strictEqual(failedLines(h).length, 1);
});

test('no log line carries a secret value, through a full frontdoor cycle with a restore', async () => {
  const h = harness({ env: { ...EDGE_ENV, RENEW: 'true' }, secrets: {
    ...rotated('edge-secret'),
    'docling-api-key': { value: 'docling-value-xyz', expiresOn: new Date(T0 + DAY) }
  } });
  const promoted = await edgeToPromoted(h);
  await h.at(promoted + 45 * MIN);
  h.pass['demi-edge'] = false;
  await h.at(promoted + 55 * MIN);
  const leaked = h.vault.allValues().filter((v) => h.lines.some((l) => l.m.includes(v)));
  assert.deepStrictEqual(leaked, []);
});

test('an issuer expiry within 30 days logs a warning, a later one does not', async () => {
  const h = harness({ env: { ISSUER_EXPIRY: 'minio-access-key=2026-11-30,docling-api-key=2027-03-01' }, secrets: {} });
  await h.at(T0);
  const warnings = h.lines.filter((l) => l.level === 'warn').map((l) => l.m);
  assert.deepStrictEqual(warnings, ['[secret-rotator] issuer expiry minio-access-key on 2026-11-30: renew it at the issuer']);
});

test('probes', async (t) => {
  const respond = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });

  await t.test('demi-edge reads the edge key and demi-gateway the gateway key', async () => {
    const probe = createProbe({ demiUrl: 'https://demi.test/health/trust', fetchImpl: respond(200, { edge: false, gateway: true }) });
    assert.strictEqual(await probe('demi-edge'), false);
    assert.strictEqual(await probe('demi-gateway'), true);
  });

  await t.test('analytics passes on anything but 401', async () => {
    const at = (status) => createProbe({ analyticsUrl: 'https://a.test/analytics/events', fetchImpl: respond(status) })('analytics');
    assert.strictEqual(await at(400), true);
    assert.strictEqual(await at(401), false);
  });
});
