'use strict';

// The rotator against an in-memory vault, a fake ARM and a fake probe. Time is the `now` each run gets.

const test = require('node:test');
const assert = require('node:assert');

const { run, createVault } = require('../../src/secret-rotator/rotate');
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

/** `seed`: name -> fields, or name -> [fields, ...] oldest first. */
function fakeVault(seed) {
  const store = new Map();
  const writes = [];
  const failNext = new Set();
  let seq = 0;
  const add = (name, fields) => {
    const version = `v${++seq}`;
    const versions = store.get(name) || [];
    versions.push({ name, version, enabled: true, expiresOn: null, contentType: null, tags: {}, ...fields });
    store.set(name, versions);
    return version;
  };
  Object.entries(seed).forEach(([name, fields]) => [fields].flat().forEach((f) => add(name, f)));
  const latest = (name) => (store.get(name) || []).at(-1) || null;
  return {
    writes,
    failNext,
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
      if (failNext.delete(name)) throw new Error('vault unavailable');
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
    badJson: false,
    conflicts: new Set(),
    patches: [],
    value: (id) => rules.get(id).actions[1].parameters.value,
    setValue: (id, v) => { rules.get(id).actions[1].parameters.value = v; },
    async request(method, url, body) {
      const id = new URL(url).pathname;
      const rule = rules.get(id);
      if (method === 'GET') {
        const json = arm.badJson
          ? async () => { throw new SyntaxError(`Unexpected token in ${JSON.stringify(rule)}`); }
          : async () => ({ properties: structuredClone(rule) });
        return { ok: true, status: 200, json };
      }
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
  const options = { env, vault, arm: arm.request, probe: async (kind) => pass[kind], log };
  const at = (ms, extra = {}) => run({ ...options, now: new Date(ms), ...extra });
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

/** Mint at T0, promote 30 min later, PATCH the rules 10 min after that. Returns the PATCH time. */
async function edgeToStamped(h) {
  await h.at(T0);
  await h.at(T0 + 30 * MIN);
  await h.at(T0 + 40 * MIN);
  return T0 + 40 * MIN;
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

  await t.test('a probe failing before mint writes nothing and logs FAILED', async () => {
    const h = harness({ env: APIM_ENV, secrets: rotated('apim-gateway-secret') });
    h.pass['demi-gateway'] = false;
    await h.at(T0);
    assert.deepStrictEqual(h.vault.writes, []);
    assert.strictEqual(failedLines(h).length, 1);
  });
});

test('promote', async (t) => {
  await t.test('waits 30 min after mint, then standby takes O and the name takes N', async () => {
    const h = harness({ env: APIM_ENV, secrets: rotated('apim-gateway-secret') });
    await h.at(T0);
    const minted = standbyOf(h, 'apim-gateway-secret').value;
    await h.at(T0 + 29 * MIN);
    assert.strictEqual(h.vault.latest('apim-gateway-secret').value, OLD, 'not promoted at 29 min');
    await h.at(T0 + 30 * MIN);
    assert.strictEqual(h.vault.latest('apim-gateway-secret').value, minted);
    assert.strictEqual(standbyOf(h, 'apim-gateway-secret').value, OLD);
  });

  await t.test('a promote stopped before the name write mints again on the next run', async () => {
    const h = harness({ env: APIM_ENV, secrets: rotated('apim-gateway-secret') });
    await h.at(T0);
    h.vault.failNext.add('apim-gateway-secret');
    await h.at(T0 + 30 * MIN);
    await h.at(T0 + 90 * MIN);
    assert.strictEqual(stageOf(h, 'apim-gateway-secret'), 'minted');
    assert.notStrictEqual(standbyOf(h, 'apim-gateway-secret').value, OLD);
    assert.strictEqual(h.vault.latest('apim-gateway-secret').value, OLD);
  });
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

test('frontdoor', async (t) => {
  await t.test('the promote run PATCHes nothing; a run 10 min later PATCHes every rule to N', async () => {
    const h = harness({ env: EDGE_ENV, secrets: rotated('edge-secret') });
    await h.at(T0);
    await h.at(T0 + 30 * MIN);
    await h.at(T0 + 39 * MIN);
    assert.deepStrictEqual(h.arm.patches, [], 'no PATCH before 10 min after promote');
    await h.at(T0 + 40 * MIN);
    const next = h.vault.latest('edge-secret').value;
    assert.deepStrictEqual(RULES.map(h.arm.value), [next, next]);
  });

  await t.test('retires once rules are Succeeded with N, 45 min passed and the probe passes', async () => {
    const h = harness({ env: EDGE_ENV, secrets: rotated('edge-secret') });
    const stamped = await edgeToStamped(h);
    await h.at(stamped + 45 * MIN);
    assert.strictEqual(stageOf(h, 'edge-secret'), 'retired');
  });

  await t.test('retire waits while a rule is not Succeeded', async () => {
    const h = harness({ env: EDGE_ENV, secrets: rotated('edge-secret') });
    h.arm.stateAfterPatch = 'Updating';
    const stamped = await edgeToStamped(h);
    await h.at(stamped + 45 * MIN);
    assert.strictEqual(stageOf(h, 'edge-secret'), 'promoted');
  });

  await t.test('retire waits for 45 min after the last PATCH', async () => {
    const h = harness({ env: EDGE_ENV, secrets: rotated('edge-secret') });
    const stamped = await edgeToStamped(h);
    await h.at(stamped + 44 * MIN);
    assert.strictEqual(stageOf(h, 'edge-secret'), 'promoted');
  });

  await t.test('retire waits while the demi-edge probe fails', async () => {
    const h = harness({ env: EDGE_ENV, secrets: rotated('edge-secret') });
    const stamped = await edgeToStamped(h);
    h.pass['demi-edge'] = false;
    await h.at(stamped + 45 * MIN);
    assert.strictEqual(stageOf(h, 'edge-secret'), 'promoted');
  });

  await t.test('a rule reading back O is PATCHed again and retire waits', async () => {
    const h = harness({ env: EDGE_ENV, secrets: rotated('edge-secret') });
    const stamped = await edgeToStamped(h);
    h.arm.setValue(RULES[1], OLD);
    await h.at(stamped + 45 * MIN);
    assert.strictEqual(stageOf(h, 'edge-secret'), 'promoted');
    assert.strictEqual(h.arm.value(RULES[1]), h.vault.latest('edge-secret').value);
  });

  await t.test('a 409 on a rule PATCH is retried on the next run', async () => {
    const h = harness({ env: EDGE_ENV, secrets: rotated('edge-secret') });
    h.arm.conflicts.add(RULES[1]);
    const stamped = await edgeToStamped(h);
    assert.strictEqual(h.arm.value(RULES[1]), OLD, 'conflicted rule unchanged');
    await h.at(stamped + HOUR);
    assert.strictEqual(h.arm.value(RULES[1]), h.vault.latest('edge-secret').value);
  });

  await t.test('a rotation still waiting 24 h after promote logs FAILED', async () => {
    const h = harness({ env: EDGE_ENV, secrets: rotated('edge-secret') });
    h.arm.stateAfterPatch = 'Updating';
    await edgeToStamped(h);
    await h.at(T0 + 30 * MIN + 23 * HOUR);
    assert.strictEqual(failedLines(h).length, 0);
    await h.at(T0 + 30 * MIN + 24 * HOUR);
    assert.strictEqual(failedLines(h).length, 1);
  });

  await t.test('a rule body that is not JSON fails without quoting the body', async () => {
    const h = harness({ env: EDGE_ENV, secrets: rotated('edge-secret') });
    await h.at(T0);
    await h.at(T0 + 30 * MIN);
    h.arm.badJson = true;
    await h.at(T0 + 40 * MIN);
    assert.strictEqual(failedLines(h).length, 1);
    assert.ok(!failedLines(h)[0].m.includes(OLD));
  });
});

test('verify', async (t) => {
  await t.test('a failing probe 10 min after retire puts O back in standby only', async () => {
    const h = harness({ env: APIM_ENV, secrets: rotated('apim-gateway-secret') });
    const retired = await apimToRetired(h, T0);
    const next = h.vault.latest('apim-gateway-secret').value;
    h.pass['demi-gateway'] = false;
    await h.at(retired + 10 * MIN);
    assert.strictEqual(standbyOf(h, 'apim-gateway-secret').value, OLD);
    assert.strictEqual(h.vault.latest('apim-gateway-secret').value, next, 'stampers may still send N');
    assert.strictEqual(stageOf(h, 'apim-gateway-secret'), 'restored');
    assert.strictEqual(standbyOf(h, 'apim-gateway-secret').tags['rotation-attempts'], '1');
    assert.strictEqual(failedLines(h).length, 1);
  });

  await t.test('a failing probe on the frontdoor class leaves the rules on N', async () => {
    const h = harness({ env: EDGE_ENV, secrets: rotated('edge-secret') });
    const stamped = await edgeToStamped(h);
    await h.at(stamped + 45 * MIN);
    const patches = h.arm.patches.length;
    h.pass['demi-edge'] = false;
    await h.at(stamped + 55 * MIN);
    const next = h.vault.latest('edge-secret').value;
    assert.strictEqual(h.arm.patches.length, patches, 'no PATCH back to O');
    assert.deepStrictEqual(RULES.map(h.arm.value), [next, next]);
    assert.strictEqual(standbyOf(h, 'edge-secret').value, OLD);
  });

  await t.test('a restored secret goes back to promoted after 24 h and retires again', async () => {
    const h = harness({ env: APIM_ENV, secrets: rotated('apim-gateway-secret') });
    const retired = await apimToRetired(h, T0);
    h.pass['demi-gateway'] = false;
    const failedAt = retired + 10 * MIN;
    await h.at(failedAt);
    h.pass['demi-gateway'] = true;
    await h.at(failedAt + 23 * HOUR);
    assert.strictEqual(stageOf(h, 'apim-gateway-secret'), 'restored');
    await h.at(failedAt + 24 * HOUR);
    assert.strictEqual(stageOf(h, 'apim-gateway-secret'), 'promoted');
    await h.at(failedAt + 30 * HOUR);
    assert.strictEqual(stageOf(h, 'apim-gateway-secret'), 'retired');
    assert.strictEqual(standbyOf(h, 'apim-gateway-secret').tags['rotation-attempts'], '1');
  });

  await t.test('a second failure stops in stage failed, writes nothing more and alerts every run', async () => {
    const h = harness({ env: APIM_ENV, secrets: rotated('apim-gateway-secret') });
    const retired = await apimToRetired(h, T0);
    h.pass['demi-gateway'] = false;
    await h.at(retired + 10 * MIN);
    await h.at(retired + 10 * MIN + 24 * HOUR);
    await h.at(retired + 10 * MIN + 30 * HOUR);
    await h.at(retired + 10 * MIN + 31 * HOUR);
    assert.strictEqual(stageOf(h, 'apim-gateway-secret'), 'failed');
    assert.strictEqual(standbyOf(h, 'apim-gateway-secret').value, OLD);
    const writes = h.vault.writes.length;
    const alerts = failedLines(h).length;
    await h.at(retired + 4 * DAY);
    assert.strictEqual(h.vault.writes.length, writes, 'no write once failed');
    assert.strictEqual(failedLines(h).length, alerts + 1);
  });
});

test('state tags fail closed', async (t) => {
  await t.test('an unreadable rotation-at restarts the wait instead of skipping it', async () => {
    const h = harness({ env: APIM_ENV, secrets: {
      ...rotated('apim-gateway-secret'),
      'apim-gateway-secret-standby': { value: 'n', tags: { 'rotation-stage': 'minted', 'rotation-at': 'bad', 'rotation-attempts': '0' } }
    } });
    await h.at(T0);
    assert.strictEqual(h.vault.latest('apim-gateway-secret').value, OLD, 'not promoted');
    assert.strictEqual(standbyOf(h, 'apim-gateway-secret').tags['rotation-at'], new Date(T0).toISOString());
  });

  await t.test('an unreadable rotation-attempts uses up the retries', async () => {
    const h = harness({ env: APIM_ENV, secrets: {
      'apim-gateway-secret': { value: 'n', expiresOn: new Date(T0 + 89 * DAY) },
      'apim-gateway-secret-standby': [
        { value: OLD },
        { value: 'n', tags: { 'rotation-stage': 'retired', 'rotation-at': new Date(T0).toISOString(), 'rotation-attempts': '' } }
      ]
    } });
    h.pass['demi-gateway'] = false;
    await h.at(T0 + 10 * MIN);
    assert.strictEqual(stageOf(h, 'apim-gateway-secret'), 'failed');
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

  await t.test('skips -standby names, no-exp, disabled and certificate-backed secrets', async () => {
    const h = harness({ env: renewEnv, secrets: {
      'edge-secret-standby': { value: 'a', expiresOn: new Date(T0 + DAY) },
      'track-client-secret': { value: 'b', expiresOn: null },
      'old-key': { value: 'c', expiresOn: new Date(T0 + DAY), enabled: false },
      'tls-cert': { value: 'd', expiresOn: new Date(T0 + DAY), managed: true }
    } });
    await h.at(T0);
    assert.deepStrictEqual(h.vault.writes, []);
  });

  await t.test('skips rotated names, even when due', async () => {
    const h = harness({ env: { ...APIM_ENV, ...renewEnv }, secrets: rotated('apim-gateway-secret') });
    h.pass['demi-gateway'] = false;
    await h.at(T0);
    assert.deepStrictEqual(h.vault.writes, []);
  });

  await t.test('skips a secret that got a new version after the list', async () => {
    const h = harness({ env: renewEnv, secrets: { 'docling-api-key': { value: 'd', expiresOn: new Date(T0 + DAY) } } });
    const list = h.vault.list;
    h.vault.list = async () => (await list()).map((p) => ({ ...p, version: 'v-listed' }));
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
      'admin-api-key': { value: 'a', expiresOn: new Date(T0 + 60 * DAY) }
    }
  });
  const retired = await apimToRetired(h, T0);
  await h.at(retired + 10 * MIN);
  assert.deepStrictEqual([...new Set(h.vault.writes)].sort(),
    ['apim-gateway-secret', 'apim-gateway-secret-standby', 'docling-api-key']);
});

test('config', async (t) => {
  await t.test('empty ROTATED_SECRETS and RENEW write nothing and still log run finished', async () => {
    const h = harness({ env: {}, secrets: { 'docling-api-key': { value: 'd', expiresOn: new Date(T0 + DAY) } } });
    await h.at(T0);
    assert.deepStrictEqual(h.vault.writes, []);
    assert.ok(h.lines.some((l) => l.m.startsWith('[secret-rotator] run finished')));
  });

  await t.test('no vault (KEY_VAULT_URI unset) logs FAILED and run finished', async () => {
    const h = harness({ env: APIM_ENV, secrets: {} });
    await h.at(T0, { vault: null });
    assert.deepStrictEqual(failedLines(h).map((l) => l.m), ['[secret-rotator] FAILED config: KEY_VAULT_URI is not set']);
    assert.ok(h.lines.some((l) => l.m.startsWith('[secret-rotator] run finished')));
  });

  await t.test('an impossible ISSUER_EXPIRY date is a config failure, not a silent skip', async () => {
    const h = harness({ env: { ISSUER_EXPIRY: 'minio-access-key=2026-02-31' }, secrets: {} });
    await h.at(T0);
    assert.strictEqual(failedLines(h).length, 1);
  });

  await t.test('a frontdoor entry with no EDGE_RULE_IDS writes nothing and logs FAILED', async () => {
    const h = harness({ env: { ROTATED_SECRETS: EDGE_ENV.ROTATED_SECRETS }, secrets: rotated('edge-secret') });
    await h.at(T0);
    assert.deepStrictEqual(h.vault.writes, []);
    assert.strictEqual(failedLines(h).length, 1);
  });

  await t.test('a rule id with a .. segment writes nothing and logs FAILED', async () => {
    const bad = RULES[0].replace('rulesdemi', '..');
    const h = harness({ env: { ...EDGE_ENV, EDGE_RULE_IDS: bad }, secrets: rotated('edge-secret') });
    await h.at(T0);
    assert.deepStrictEqual(h.vault.writes, []);
    assert.strictEqual(failedLines(h).length, 1);
  });
});

test('no log line carries a secret value, through a full frontdoor cycle with a failed verify', async () => {
  const h = harness({ env: { ...EDGE_ENV, RENEW: 'true' }, secrets: {
    ...rotated('edge-secret'),
    'docling-api-key': { value: 'docling-value-xyz', expiresOn: new Date(T0 + DAY) }
  } });
  const stamped = await edgeToStamped(h);
  await h.at(stamped + 45 * MIN);
  h.pass['demi-edge'] = false;
  await h.at(stamped + 55 * MIN);
  const leaked = h.vault.allValues().filter((v) => h.lines.some((l) => l.m.includes(v)));
  assert.deepStrictEqual(leaked, []);
});

test('an issuer expiry within 30 days logs an issuer-expiry warning, a later one does not', async () => {
  const h = harness({ env: { ISSUER_EXPIRY: 'minio-access-key=2026-11-30,docling-api-key=2027-03-01' }, secrets: {} });
  await h.at(T0);
  const warnings = h.lines.filter((l) => l.level === 'warn').map((l) => l.m);
  assert.deepStrictEqual(warnings, ['[secret-rotator] issuer-expiry minio-access-key on 2026-11-30: renew it at the issuer']);
});

test('probes', async (t) => {
  const respond = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });

  await t.test('demi-edge reads the edge key and demi-gateway the gateway key', async () => {
    const probe = createProbe({ demiUrl: 'https://demi.test/health/trust', delayMs: 0, fetchImpl: respond(200, { edge: false, gateway: true }) });
    assert.strictEqual(await probe('demi-edge'), false);
    assert.strictEqual(await probe('demi-gateway'), true);
  });

  await t.test('analytics passes on anything but 401', async () => {
    const at = (status) => createProbe({ analyticsUrl: 'https://a.test/analytics/events', delayMs: 0, fetchImpl: respond(status) })('analytics');
    assert.strictEqual(await at(400), true);
    assert.strictEqual(await at(401), false);
  });

  await t.test('a first attempt that times out is retried before the probe counts as failed', async () => {
    const replies = [null, { ok: true, status: 200, json: async () => ({ edge: true }) }];
    const fetchImpl = async () => {
      const reply = replies.shift();
      if (!reply) throw new Error('timeout');
      return reply;
    };
    const probe = createProbe({ demiUrl: 'https://demi.test/health/trust', delayMs: 0, fetchImpl });
    assert.strictEqual(await probe('demi-edge'), true);
  });
});

test('createVault over a SecretClient', async (t) => {
  const client = {
    async *listPropertiesOfSecretVersions() {
      yield { version: 'b', createdOn: new Date(T0 + 2) };
      yield { version: 'c', createdOn: new Date(T0 + 3) };
      yield { version: 'a', createdOn: new Date(T0 + 1) };
    },
    async getSecret(name, options = {}) {
      if (name === 'missing') throw Object.assign(new Error('not found'), { statusCode: 404 });
      return { value: `value-${options.version || 'latest'}`, properties: { name, version: 'c' } };
    }
  };
  const vault = createVault(client);

  await t.test('previous() reads the version created before the latest, not the list order', async () => {
    assert.strictEqual(await vault.previous('apim-gateway-secret-standby'), 'value-b');
  });

  await t.test('get() maps 404 to null and fills property defaults', async () => {
    assert.strictEqual(await vault.get('missing'), null);
    const secret = await vault.get('x');
    assert.strictEqual(secret.enabled, true);
    assert.strictEqual(secret.managed, false);
    assert.strictEqual(secret.contentType, null);
  });
});
