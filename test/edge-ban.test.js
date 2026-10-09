'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../src/db/cosmos-nosql');
const edgeBans = require('../src/repositories/edge-bans');
const edgeBan = require('../src/scripts/edge-ban');

const NOW = new Date('2026-10-09T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const RULE_ID = '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Cdn/profiles/edge/ruleSets/rulesdemidocs/rules/banauto';
const GOOGLEBOT = '66.249.64.0/27';
const quiet = { info() {}, warn() {}, error() {} };
const credential = { getToken: async scope => ({ token: `token-${scope}` }) };

// RDAP answers by address: network name plus the registrant contact, as ARIN shapes them.
const OWNERS = {
  '142.34.1.1': 'PROVINCE-OF-BRITISH-COLUMBIA',
  '207.81.62.129': 'TELUS-FIBRE-VCTABC4',
  '66.249.64.5': 'GOOGLE'
};
const ownerName = ip => OWNERS[ip] || 'HETZNER-fsn1-dc7';

const row = (address, { documents, requests = documents, evidence = 0, agents = ['python-requests/2.32'] }) => ({
  Address: address, Requests: requests, Documents: documents, UserAgents: JSON.stringify(agents),
  SpaLoads: evidence, Beacons: 0, Searches: 0
});

/** In-memory `edgeBans` container behind the real repository, and `fetch` routed by host. */
function harness(t, { rows = [], feedFails = false, patchStatus = 200, matchValues = ['192.0.2.1/32'] } = {}) {
  const store = new Map();
  const calls = { arm: [], logs: [] };
  t.mock.method(cosmos, 'query', async () => ({ items: [...store.values()].filter(r => r.address) }));
  t.mock.method(cosmos, 'upsert', async (_c, item) => { store.set(item.id, structuredClone(item)); return item; });
  t.mock.method(cosmos, 'readItem', async (_c, id) => store.get(id) || null);
  const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === 'api.loganalytics.io') {
      calls.logs.push(JSON.parse(init.body));
      return json({ tables: [{ columns: Object.keys(rows[0] || { Address: 0 }).map(name => ({ name })), rows: rows.map(Object.values) }] });
    }
    if (u.host === 'rdap.arin.net') return json({ name: ownerName(u.pathname.split('/').pop()), entities: [] });
    if (u.host === 'management.azure.com') {
      calls.arm.push({ method: init.method, auth: init.headers.Authorization, body: init.body && JSON.parse(init.body) });
      if (init.method === 'PATCH') return json({}, patchStatus);
      return json({ properties: { conditions: [{ name: 'SocketAddr', parameters: { operator: 'IPMatch', matchValues } }] } });
    }
    if (feedFails) return json({}, 503);
    return json({ prefixes: url.includes('common-crawlers') ? [{ ipv4Prefix: GOOGLEBOT }] : [] });
  });
  const run = opts => edgeBan.run({ mode: 'shadow', now: NOW, log: quiet, workspaceId: 'ws', ruleId: RULE_ID, credential, cosmos, ...opts });
  return { store, calls, run, setRows: next => { rows = next; } };
}

const verdictOf = (summary, address) => summary.candidates.find(c => c.address === address);
const patched = calls => calls.arm.filter(c => c.method === 'PATCH').map(c => c.body.properties.conditions[0].parameters.matchValues);

test('edge ban detector', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a government NAT with many documents and heavy browser traffic is left alone', async () => {
    const h = harness(t, { rows: [row('142.34.1.1', { documents: 2000, evidence: 900 })] });
    const summary = await h.run();
    assert.deepStrictEqual(summary.banned, []);
    assert.strictEqual(verdictOf(summary, '142.34.1.1/32').reason, 'owner government');
  });

  await t.test('a PDF reader making 400 range requests over 3 documents is not a candidate', async () => {
    const h = harness(t, { rows: [row('5.9.1.1', { documents: 3, requests: 400 })] });
    const summary = await h.run();
    assert.deepStrictEqual(summary.banned, []);
    assert.strictEqual(summary.candidates.length, 0);
  });

  await t.test('a datacenter address with 5000 documents and no browser evidence is banned for 1 h', async () => {
    const h = harness(t, { rows: [row('5.9.1.1', { documents: 5000 })] });
    const summary = await h.run();
    assert.deepStrictEqual(summary.banned, ['5.9.1.1/32']);
    const stored = h.store.get('5.9.1.1_32');
    assert.strictEqual(stored.ownerType, 'datacenter');
    assert.strictEqual(new Date(stored.expiresAt) - NOW, HOUR);
    assert.strictEqual(stored.ttl, edgeBans.TTL_SECONDS);
  });

  await t.test('an address inside a published Googlebot range is never banned', async () => {
    const h = harness(t, { rows: [row('66.249.64.5', { documents: 5000 })] });
    const summary = await h.run();
    assert.deepStrictEqual(summary.banned, []);
    assert.strictEqual(verdictOf(summary, '66.249.64.5/32').reason, 'crawler range');
  });

  await t.test('no crawler ranges, fresh or cached, means no new bans', async () => {
    const h = harness(t, { rows: [row('5.9.1.1', { documents: 5000 })], feedFails: true });
    const summary = await h.run();
    assert.deepStrictEqual(summary.banned, []);
    assert.strictEqual(verdictOf(summary, '5.9.1.1/32').verdict, 'deferred');
  });

  await t.test('repeat offences ban for 1 h, 4 h, then 24 h, and stay at 24 h', async () => {
    const h = harness(t, { rows: [row('5.9.1.1', { documents: 5000 })] });
    // Each run starts one second after the previous ban ended.
    const banHours = async now => {
      await h.run({ now });
      const expiresAt = new Date(h.store.get('5.9.1.1_32').expiresAt);
      return { hours: (expiresAt - now) / HOUR, next: new Date(expiresAt.getTime() + 1000) };
    };
    const first = await banHours(NOW);
    const second = await banHours(first.next);
    const third = await banHours(second.next);
    const fourth = await banHours(third.next);
    const lengths = [first, second, third, fourth].map(b => b.hours);
    assert.deepStrictEqual(lengths, [1, 4, 24, 24]);
    assert.strictEqual(h.store.get('5.9.1.1_32').banCount, 4);
  });

  await t.test('an IPv6 address is banned as its /64', async () => {
    const h = harness(t, { rows: [row('2001:0db8:0001:0002:0000:0000:0000:0000/64', { documents: 5000 })] });
    const summary = await h.run();
    assert.deepStrictEqual(summary.banned, ['2001:db8:1:2::/64']);
    assert.strictEqual(edgeBan.toBanPrefix('2001:db8:1:2:abcd::1'), '2001:db8:1:2::/64');
  });

  await t.test('a stored /16 never reaches the rule', async () => {
    const h = harness(t);
    h.store.set('10.1.0.0_16', { id: '10.1.0.0_16', address: '10.1.0.0/16', expiresAt: new Date(NOW.getTime() + HOUR).toISOString() });
    const summary = await h.run({ mode: 'write' });
    assert.deepStrictEqual(patched(h.calls), [], 'only the placeholder is left, and the rule already holds it');
    assert.match(summary.warnings.join('\n'), /refused 10\.1\.0\.0\/16/);
  });

  await t.test('a ban list over the cap is cut to the latest-expiring and warns', async () => {
    const h = harness(t);
    for (const [i, hours] of [[1, 1], [2, 3], [3, 2]]) {
      h.store.set(`203.0.113.${i}_32`, { id: `203.0.113.${i}_32`, address: `203.0.113.${i}/32`, expiresAt: new Date(NOW.getTime() + hours * HOUR).toISOString() });
    }
    const summary = await h.run({ mode: 'write', policy: { maxListLength: 2 } });
    assert.deepStrictEqual(patched(h.calls), [['203.0.113.2/32', '203.0.113.3/32']]);
    assert.match(summary.warnings.join('\n'), /over cap 2/);
  });

  await t.test('no more than 20 new bans land in one run', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => row(`5.9.1.${i + 10}`, { documents: 5000 - i }));
    const h = harness(t, { rows });
    const summary = await h.run();
    assert.strictEqual(summary.banned.length, 20);
    assert.strictEqual(summary.candidates.filter(c => c.verdict === 'deferred').length, 5);
    assert.match(summary.warnings.join('\n'), /capped at 20/);
  });

  await t.test('shadow mode records the ban and makes no rule call', async () => {
    const h = harness(t, { rows: [row('5.9.1.1', { documents: 5000 })] });
    const summary = await h.run({ mode: 'shadow' });
    assert.ok(h.store.has('5.9.1.1_32'));
    assert.strictEqual(h.calls.arm.length, 0);
    assert.strictEqual(summary.written, false);
  });

  await t.test('write mode puts the new ban on the rule', async () => {
    const h = harness(t, { rows: [row('5.9.1.1', { documents: 5000 })] });
    const summary = await h.run({ mode: 'write' });
    assert.deepStrictEqual(patched(h.calls), [['5.9.1.1/32']]);
    assert.strictEqual(summary.written, true);
    assert.strictEqual(h.calls.arm[1].auth, 'Bearer token-https://management.azure.com/.default', 'token from the passed credential');
  });

  await t.test('a 409 on the rule write is logged, not thrown, and the ban stays recorded', async () => {
    const h = harness(t, { rows: [row('5.9.1.1', { documents: 5000 })], patchStatus: 409 });
    const summary = await h.run({ mode: 'write' });
    assert.strictEqual(summary.written, false);
    assert.ok(h.store.has('5.9.1.1_32'));
  });

  await t.test('off mode writes the placeholder back and reads no log', async () => {
    const h = harness(t, { matchValues: ['5.9.1.1/32'] });
    await h.run({ mode: 'off', policy: null });
    assert.deepStrictEqual(patched(h.calls), [['192.0.2.1/32']]);
    assert.strictEqual(h.calls.logs.length, 0);
  });

  await t.test('off mode leaves a rule that already holds the placeholder untouched', async () => {
    const h = harness(t, { matchValues: ['192.0.2.1/32'] });
    const summary = await h.run({ mode: 'off', policy: null });
    assert.deepStrictEqual(h.calls.arm.map(c => c.method), ['GET']);
    assert.strictEqual(summary.written, false);
    assert.strictEqual(h.calls.logs.length, 0);
  });

  await t.test('owner names map to the classes the judge acts on', () => {
    assert.strictEqual(edgeBan.classifyOwner('PROVINCE OF BRITISH COLUMBIA'), 'government');
    assert.strictEqual(edgeBan.classifyOwner('TELUS Communications Inc.'), 'residential');
    assert.strictEqual(edgeBan.classifyOwner('Amazon Data Services Northern Virginia'), 'datacenter');
  });
});
