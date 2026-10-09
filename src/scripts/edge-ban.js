'use strict';

/**
 * Edge ban detector: finds addresses that pull many documents through Front Door with no sign of a
 * browser, bans the datacenter and VPN ones for 1 h, 4 h, then 24 h, and keeps the `banauto` rule's
 * SocketAddr list in step with the unexpired bans. Judge order and soak plan: wiki DEMI edge-ban page.
 *
 * Modes: `off` writes the placeholder back (kill switch), `shadow` records bans without touching
 * the rule, `write` also PATCHes the rule's conditions.
 *
 *   node src/scripts/edge-ban.js --dry-run --env test [--floor N]
 *
 * The CLI is read-only: it queries the access log and prints each candidate, no Cosmos, no rule write.
 */

const net = require('node:net');
const { createCredential } = require('../utils/azure-credential');
const db = require('../db/cosmos-nosql');
const { isKeyVaultReference } = require('../utils/key-vault-reference');
const edgeBans = require('../repositories/edge-bans');
const { logger } = require('../utils/logger');

const TAG = '[edge-ban]';
const MODES = ['off', 'shadow', 'write'];
const PLACEHOLDER = '192.0.2.1/32';
const ARM_SCOPE = 'https://management.azure.com/.default';
const LOGS_SCOPE = 'https://api.loganalytics.io/.default';
const ARM_API_VERSION = '2024-02-01';
const RULE_ID = /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Cdn\/profiles\/[^/]+\/ruleSets\/[^/]+\/rules\/[^/]+$/i;
const HOUR_MS = 60 * 60 * 1000;
const FEED_MAX_AGE_MS = 24 * HOUR_MS;

// The PR #66 scraper alert regex (eagle-edge observability.bicep), with the document id captured.
const DOWNLOAD_PATH = '^/(api/|api/public/|demi-search/)documents?/([^/]+)/(download|fetch)(/|$)';

const DEFAULT_POLICY = {
  documentFloor: 300,
  evidenceFloor: 3,
  banHours: [1, 4, 24],
  maxListLength: 100,
  maxNewBansPerRun: 20,
  maxLookups: 50,
  allow: [],
  crawlerAgents: []
};

const CRAWLER_FEEDS = [
  'https://developers.google.com/static/crawling/ipranges/common-crawlers.json',
  'https://developers.google.com/static/crawling/ipranges/special-crawlers.json',
  'https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers.json',
  'https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers-google.json',
  'https://www.bing.com/toolbox/bingbot.json',
  'https://openai.com/gptbot.json',
  'https://openai.com/searchbot.json',
  'https://openai.com/chatgpt-user.json'
];

// Declared search and AI crawlers stay readable (crawler policy 2026-10-05); compared lowercased.
const CRAWLER_AGENTS = [
  'googlebot', 'googleother', 'google-inspectiontool', 'bingbot', 'adidxbot', 'gptbot',
  'oai-searchbot', 'chatgpt-user', 'claudebot', 'claude-user', 'claude-searchbot', 'perplexitybot',
  'perplexity-user', 'applebot', 'duckduckbot'
];

// First match wins: never-ban owners, then ISPs, before the hosting words a carrier's name may carry.
const OWNER_PATTERNS = [
  ['government', /\b(government|gouvernement|province of|ministry|shared services canada|city of|federal)\b/i],
  ['institution', /universit|college|school|polytechnic|institute of technology|library|bcnet|canarie|research network/i],
  ['mobile', /mobility|wireless|cellular|\bmobile\b/i],
  ['relay', /private relay|icloud|apple inc/i],
  ['residential', /telus|shaw|rogers|bell canada|videotron|cogeco|eastlink|comcast|charter|cox commun|verizon|at&t/i],
  ['vpn', /\bvpn\b|nordvpn|tefincom|express ?vpn|proton|mullvad|surfshark|private internet access|datacamp|packethub|m247/i],
  ['datacenter', /amazon|\baws\b|google|microsoft|azure|digitalocean|linode|akamai|\bovh|hetzner|vultr|choopa|constant company|oracle|alibaba|tencent|contabo|leaseweb|scaleway|hosting|data ?cent(er|re)|cloud|server|\bcolo/i]
];
const NEVER_OWNERS = new Set(['government', 'institution', 'mobile', 'relay']);
const BAN_OWNERS = new Set(['datacenter', 'vpn']);

/** `{ family, value, bits }` for an address or CIDR, or null. IPv4-mapped IPv6 reads as IPv4. */
function parseCidr(text) {
  const [raw, len] = String(text).trim().split('/');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw);
  const ip = mapped ? mapped[1] : raw;
  const family = net.isIP(ip);
  if (!family) return null;
  const width = family === 4 ? 32 : 128;
  const bits = len === undefined ? width : Number(len);
  if (!/^\d+$/.test(String(bits)) || bits > width) return null;
  let value = 0n;
  if (family === 4) {
    for (const part of ip.split('.')) value = (value << 8n) + BigInt(part);
  } else {
    const words = part => (part ? part.split(':') : []).flatMap(h => (h.includes('.')
      ? [Number(h.split('.')[0]) * 256 + Number(h.split('.')[1]), Number(h.split('.')[2]) * 256 + Number(h.split('.')[3])]
      : [parseInt(h, 16)]));
    const halves = ip.split('::');
    const head = words(halves[0]);
    const tail = halves.length > 1 ? words(halves[1]) : [];
    for (const w of [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail]) value = (value << 16n) + BigInt(w);
  }
  return { family, value, bits, width };
}

function formatAddress({ family, value }) {
  if (family === 4) return [24n, 16n, 8n, 0n].map(s => String((value >> s) & 255n)).join('.');
  const words = Array.from({ length: 8 }, (_, i) => ((value >> BigInt(112 - 16 * i)) & 0xffffn).toString(16));
  // RFC 5952: the longest run of two or more zero words becomes `::`.
  let best = { at: -1, len: 1 };
  for (let i = 0; i < 8; i++) {
    let j = i;
    while (j < 8 && words[j] === '0') j++;
    if (j - i > best.len) best = { at: i, len: j - i };
  }
  if (best.at < 0) return words.join(':');
  return `${words.slice(0, best.at).join(':')}::${words.slice(best.at + best.len).join(':')}`;
}

const maskOf = (cidr, bits) => (cidr.value >> BigInt(cidr.width - bits)) << BigInt(cidr.width - bits);

/** The ban prefix an address belongs to: IPv4 /32, IPv6 /64. Null when it is not an address. */
function toBanPrefix(address) {
  const cidr = parseCidr(String(address).split('/')[0]);
  if (!cidr) return null;
  const bits = cidr.family === 4 ? 32 : 64;
  return `${formatAddress({ family: cidr.family, value: maskOf(cidr, bits) })}/${bits}`;
}

/** A ban list value in canonical form, or null for anything wider than /32 or /64. */
function validBanPrefix(value) {
  const cidr = parseCidr(value);
  if (!cidr || !String(value).includes('/')) return null;
  if (cidr.bits < (cidr.family === 4 ? 32 : 64)) return null;
  return `${formatAddress({ family: cidr.family, value: maskOf(cidr, cidr.bits) })}/${cidr.bits}`;
}

/** Do two CIDRs share any address? */
function overlaps(a, b) {
  if (!a || !b || a.family !== b.family) return false;
  const bits = Math.min(a.bits, b.bits);
  return maskOf(a, bits) === maskOf(b, bits);
}

const overlapsAny = (address, ranges) => {
  const cidr = parseCidr(address);
  return ranges.some(r => overlaps(cidr, parseCidr(r)));
};

function classifyOwner(text) {
  const found = OWNER_PATTERNS.find(([, pattern]) => pattern.test(text));
  return found ? found[0] : 'unknown';
}

/** Network name and registrant names from an RDAP answer, one line. Contact roles are often outsourced. */
function ownerText(rdap) {
  const names = [rdap.name];
  const walk = entities => (entities || []).forEach(e => {
    const card = (e.vcardArray && e.vcardArray[1]) || [];
    if ((e.roles || []).includes('registrant')) card.filter(f => f[0] === 'fn').forEach(f => names.push(f[3]));
    walk(e.entities);
  });
  walk(rdap.entities);
  return names.filter(Boolean).join(' ').replace(/[-_]/g, ' ');
}

async function lookupOwner(address) {
  const ip = String(address).split('/')[0];
  try {
    const res = await fetch(`https://rdap.arin.net/registry/ip/${encodeURIComponent(ip)}`, {
      headers: { Accept: 'application/rdap+json' }, signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return { ownerType: 'unknown', owner: `rdap ${res.status}` };
    const owner = ownerText(await res.json());
    return { ownerType: classifyOwner(owner), owner: owner.slice(0, 200) };
  } catch (err) {
    return { ownerType: 'unknown', owner: `rdap ${err.message}` };
  }
}

/**
 * Published crawler ranges: the cached copy while under a day old, else a fresh fetch, else the
 * cached copy at any age. Null when there is none, and the caller then bans nothing.
 */
async function crawlerRanges({ cosmos, now, log }) {
  const cached = cosmos ? await edgeBans.getFeedCache(cosmos) : null;
  if (cached && now - new Date(cached.fetchedAt) < FEED_MAX_AGE_MS) return cached.ranges;
  try {
    const feeds = await Promise.all(CRAWLER_FEEDS.map(async url => {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`${url} ${res.status}`);
      return (await res.json()).prefixes || [];
    }));
    const ranges = feeds.flat().map(p => p.ipv4Prefix || p.ipv6Prefix).filter(Boolean);
    if (!ranges.length) throw new Error('feeds returned no prefixes');
    if (cosmos) await edgeBans.putFeedCache({ fetchedAt: now.toISOString(), ranges }, cosmos);
    return ranges;
  } catch (err) {
    log.warn(`${TAG} crawler range fetch failed: ${err.message}`);
    return cached ? cached.ranges : null;
  }
}

function resolvePolicy(policy) {
  const given = typeof policy === 'string' && policy.trim() ? JSON.parse(policy) : (policy || {});
  return { ...DEFAULT_POLICY, ...given };
}

/** KQL over the access log: per ban prefix, document pulls and browser evidence. */
function buildQuery({ documentFloor, since }) {
  // Traffic before a past ban ended was already judged; counting it again would escalate on old evidence.
  const sinceRows = since.map(s => `'${s.network}', datetime(${s.at})`).join(', ');
  const prefix = ip => `iff(${ip} contains ':', strcat(parse_ipv6_mask(${ip}, 64), '/64'), strcat(${ip}, '/32'))`;
  return `
let since = datatable(Network: string, Since: datetime)[${sinceRows}]
    | extend Address = ${prefix('Network')} | project Address, Since;
let logs = AzureDiagnostics
    | where Category == 'FrontDoorAccessLog' and isnotempty(socketIp_s)
    | extend Address = ${prefix('socketIp_s')}
    | join kind=leftouter since on Address
    | where isnull(Since) or TimeGenerated > Since;
let docs = logs
    | where requestUri_s contains '/document'
    | extend Doc = extract(@'${DOWNLOAD_PATH}', 2, tostring(parse_url(requestUri_s).Path))
    | where isnotempty(Doc)
    | summarize Requests = count(), Documents = dcount(Doc), UserAgents = make_set(replace_string(userAgent_s, '+', ' '), 5) by Address
    | where Documents > ${Number(documentFloor)};
let evidence = logs
    | where Address in ((docs | project Address))
    | extend Path = tostring(parse_url(requestUri_s).Path)
    | summarize SpaLoads = countif(rulesEngineMatchNames_s contains 'spafallback'),
        Beacons = countif(rulesEngineMatchNames_s contains 'usagealias' or Path == '/api/analytics'),
        Searches = countif(Path startswith '/demi-search/search') by Address;
docs
| join kind=leftouter evidence on Address
| project Address, Requests, Documents, UserAgents, SpaLoads = coalesce(SpaLoads, 0),
    Beacons = coalesce(Beacons, 0), Searches = coalesce(Searches, 0)
| order by Documents desc`;
}

/** One log row → a verdict: never, leave, ban, watch, or ignore (under the document floor). */
async function judge(row, { policy, crawlers, ownerOf }) {
  const agents = (Array.isArray(row.UserAgents) ? row.UserAgents : JSON.parse(row.UserAgents || '[]'))
    .map(a => String(a).toLowerCase());
  const base = {
    address: toBanPrefix(row.Address),
    documents: Number(row.Documents) || 0,
    requests: Number(row.Requests) || 0,
    evidence: (Number(row.SpaLoads) || 0) + (Number(row.Beacons) || 0) + (Number(row.Searches) || 0)
  };
  const verdict = (v, reason, extra) => ({ ...base, ...extra, verdict: v, reason });
  if (!base.address || base.documents <= policy.documentFloor) return verdict('ignore', 'under document floor');
  if (overlapsAny(base.address, policy.allow)) return verdict('never', 'allow list');
  if (crawlers && overlapsAny(base.address, crawlers)) return verdict('never', 'crawler range');
  const crawlerAgents = [...CRAWLER_AGENTS, ...policy.crawlerAgents.map(a => a.toLowerCase())];
  if (agents.some(a => crawlerAgents.some(c => a.includes(c)))) return verdict('never', 'crawler agent');
  const owner = await ownerOf(base.address);
  if (NEVER_OWNERS.has(owner.ownerType)) return verdict('never', `owner ${owner.ownerType}`, owner);
  if (base.evidence > policy.evidenceFloor) return verdict('leave', 'browser evidence', owner);
  if (BAN_OWNERS.has(owner.ownerType)) return verdict('ban', `${owner.ownerType} pulling documents`, owner);
  return verdict('watch', `owner ${owner.ownerType}`, owner);
}

/** The ban row after one more offence; ban length steps through `banHours` and stays at the last. */
function escalate(row, offence, now, banHours) {
  const banCount = (row ? row.banCount : 0) + 1;
  const hours = banHours[Math.min(banCount, banHours.length) - 1];
  return {
    address: offence.address,
    ownerType: offence.ownerType,
    owner: offence.owner,
    reason: offence.reason,
    offences: [...(row ? row.offences : []), { at: now.toISOString(), documents: offence.documents, evidence: offence.evidence }],
    banCount,
    expiresAt: new Date(now.getTime() + hours * HOUR_MS).toISOString()
  };
}

/** The `banauto` values from unexpired bans: wider prefixes refused, list capped, placeholder when empty. */
function buildList(rows, now, policy, warnings) {
  const values = new Map();
  for (const row of rows.filter(r => new Date(r.expiresAt) > now).sort((a, b) => b.expiresAt.localeCompare(a.expiresAt))) {
    const value = validBanPrefix(row.address);
    if (!value) warnings.push(`refused ${row.address}: wider than /32 or /64`);
    else values.set(value, true);
  }
  let list = [...values.keys()];
  if (list.length > policy.maxListLength) {
    warnings.push(`ban list ${list.length} over cap ${policy.maxListLength}; kept the latest-expiring`);
    list = list.slice(0, policy.maxListLength);
  }
  return list.length ? list : [PLACEHOLDER];
}

async function azure(credential, scope, method, url, body) {
  const { token } = await credential.getToken(scope);
  return fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
}

/** Rows of the first table, as objects. Not src/azure/monitor.js: that one holds its own process credential. */
async function queryLog(credential, workspaceId, query) {
  const res = await azure(credential, LOGS_SCOPE, 'POST', `https://api.loganalytics.io/v1/workspaces/${workspaceId}/query`,
    { query, timespan: 'PT24H' });
  if (!res.ok) throw new Error(`${TAG} log query ${res.status} ${await res.text()}`);
  const table = ((await res.json()).tables || [])[0] || { columns: [], rows: [] };
  return table.rows.map(r => Object.fromEntries(table.columns.map((c, i) => [c.name, r[i]])));
}

/** Swap the SocketAddr match values on the rule, other conditions kept. False when unchanged or on 409. */
async function writeRule(credential, ruleId, values, log) {
  if (!RULE_ID.test(ruleId || '')) throw new Error(`${TAG} not a rules engine rule id: ${ruleId}`);
  const url = `https://management.azure.com${ruleId}?api-version=${ARM_API_VERSION}`;
  const read = await azure(credential, ARM_SCOPE, 'GET', url);
  if (!read.ok) throw new Error(`${TAG} rule read ${read.status} ${await read.text()}`);
  const conditions = ((await read.json()).properties || {}).conditions || [];
  const socket = conditions.find(c => c.name === 'SocketAddr');
  if (!socket) throw new Error(`${TAG} rule has no SocketAddr condition`);
  if (JSON.stringify(socket.parameters.matchValues) === JSON.stringify(values)) return false;
  const next = conditions.map(c => (c === socket ? { ...c, parameters: { ...c.parameters, matchValues: values } } : c));
  const res = await azure(credential, ARM_SCOPE, 'PATCH', url, { properties: { conditions: next } });
  if (res.status === 409) {
    log.warn(`${TAG} rule write conflict (409); next run retries`);
    return false;
  }
  if (!res.ok) throw new Error(`${TAG} rule write ${res.status} ${await res.text()}`);
  return true;
}

/**
 * One detector run. `credential` is a TokenCredential, `cosmos` the src/db/cosmos-nosql module;
 * `dryRun` skips Cosmos and the rule write. Off mode only puts the placeholder back.
 */
async function run({ mode = 'shadow', now = new Date(), log = logger, policy, workspaceId, ruleId,
  credential = createCredential(), cosmos = db, dryRun = false } = {}) {
  if (!MODES.includes(mode)) throw new Error(`${TAG} unknown mode ${mode}`);
  const summary = { candidates: [], banned: [], expired: [], written: false, warnings: [] };
  const finish = () => {
    summary.warnings.forEach(w => log.warn(`${TAG} ${w}`));
    log.info(`${TAG} mode=${mode}${dryRun ? ' dry-run' : ''} candidates=${summary.candidates.length} ` +
      `banned=${summary.banned.length} expired=${summary.expired.length} written=${summary.written} ` +
      `warnings=${summary.warnings.length}`);
    return summary;
  };

  if (mode === 'off') {
    if (!dryRun) summary.written = await writeRule(credential, ruleId, [PLACEHOLDER], log);
    return finish();
  }

  const rules = resolvePolicy(policy);
  const store = dryRun ? null : cosmos;
  const history = store ? await edgeBans.listBans(store) : [];
  const byAddress = new Map(history.map(r => [r.address, r]));
  const active = r => r && new Date(r.expiresAt) > now;
  summary.expired = history.filter(r => !active(r)).map(r => r.address);

  const crawlers = await crawlerRanges({ cosmos: store, now, log });
  if (!crawlers) summary.warnings.push('no crawler ranges, cached or fresh; no new bans this run');

  const since = history.filter(r => !active(r) && validBanPrefix(r.address))
    .map(r => ({ network: r.address.split('/')[0], at: new Date(r.expiresAt).toISOString() }));
  const rows = await queryLog(credential, workspaceId, buildQuery({ documentFloor: rules.documentFloor, since }));

  let lookups = 0;
  const ownerOf = async address => {
    const known = byAddress.get(address);
    if (known && known.ownerType) return { ownerType: known.ownerType, owner: known.owner };
    if (lookups++ >= rules.maxLookups) return { ownerType: 'unknown', owner: 'lookup cap' };
    return lookupOwner(address);
  };

  let newBans = 0;
  for (const row of rows) {
    const result = await judge(row, { policy: rules, crawlers, ownerOf });
    if (result.verdict === 'ignore') continue;
    summary.candidates.push(result);
    if (result.verdict !== 'ban') continue;
    if (active(byAddress.get(result.address))) {
      result.verdict = 'banned';
      continue;
    }
    if (!crawlers || newBans >= rules.maxNewBansPerRun) {
      result.verdict = 'deferred';
      if (crawlers) result.reason = `over ${rules.maxNewBansPerRun} new bans this run`;
      continue;
    }
    newBans++;
    const next = escalate(byAddress.get(result.address), result, now, rules.banHours);
    byAddress.set(result.address, next);
    summary.banned.push(result.address);
    if (store) await edgeBans.putBan(next, store);
  }
  const deferred = summary.candidates.filter(c => c.verdict === 'deferred').length;
  if (deferred && crawlers) summary.warnings.push(`new bans capped at ${rules.maxNewBansPerRun}; ${deferred} deferred`);
  if (lookups > rules.maxLookups) summary.warnings.push(`owner lookups capped at ${rules.maxLookups}`);

  const list = buildList([...byAddress.values()], now, rules, summary.warnings);
  if (mode === 'write' && !dryRun) summary.written = await writeRule(credential, ruleId, list, log);
  return finish();
}

/** `--dry-run --env <env> [--floor N]` */
function parseArgs(argv) {
  const args = { dryRun: false, env: '', floor: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--env') args.env = argv[++i] || '';
    else if (argv[i] === '--floor') args.floor = Number(argv[++i]);
    else throw new Error(`${TAG} unknown argument ${argv[i]}`);
  }
  if (!args.dryRun) throw new Error(`${TAG} the CLI only runs --dry-run; the API timer runs shadow and write`);
  if (!/^[a-z]+$/.test(args.env)) throw new Error(`${TAG} --env <env> required`);
  return args;
}

/** EDGE_LOG_WORKSPACE_ID, else the customer id of workspace eagle-logs-<env> from Resource Graph. */
async function workspaceFor(credential, env) {
  if (process.env.EDGE_LOG_WORKSPACE_ID) return process.env.EDGE_LOG_WORKSPACE_ID;
  const res = await azure(credential, ARM_SCOPE, 'POST', 'https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01', {
    query: `resources | where type =~ 'microsoft.operationalinsights/workspaces' and name == 'eagle-logs-${env}' | project id = tostring(properties.customerId)`
  });
  if (!res.ok) throw new Error(`${TAG} workspace lookup ${res.status} ${await res.text()}`);
  const [row] = (await res.json()).data || [];
  if (!row) throw new Error(`${TAG} no workspace eagle-logs-${env} visible to this identity`);
  return row.id;
}

module.exports = {
  run, judge, escalate, buildList, buildQuery, toBanPrefix, validBanPrefix, classifyOwner,
  crawlerRanges, writeRule, parseArgs, DEFAULT_POLICY, PLACEHOLDER, DOWNLOAD_PATH
};

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const raw = process.env.EDGE_BAN_POLICY;
    const policy = raw && !isKeyVaultReference(raw) ? resolvePolicy(raw) : { ...DEFAULT_POLICY };
    if (Number.isFinite(args.floor)) policy.documentFloor = args.floor;
    const credential = createCredential();
    const summary = await run({ mode: 'shadow', dryRun: true, policy, credential,
      workspaceId: await workspaceFor(credential, args.env) });
    for (const c of summary.candidates) {
      logger.info(`${TAG} ${c.verdict} ${c.address} documents=${c.documents} requests=${c.requests} ` +
        `evidence=${c.evidence} owner=${c.ownerType || '-'} reason="${c.reason}"${c.owner ? ` rdap="${c.owner}"` : ''}`);
    }
  })().catch(err => {
    logger.error(`${TAG} ${err.stack || err.message}`);
    process.exit(1);
  });
}
