'use strict';

/**
 * Read-only parity check: replays each eagle-api read in `parity-map.js` against eagle-api and
 * DEMI with the same identity, pairs rows by Eagle id and diffs row sets and field values. Every
 * difference not on the known list counts as unexplained, and any unexplained one exits 1.
 * Usage: README "Parity with eagle-api".
 */

const fs = require('fs');
const { fetchAllPages, unwrapSearchResponse, rateLimitWaitMs, PAGE_SIZE } = require('../seed/sources');
const { diff } = require('./reconcile-eagle');
const {
  PARITY_MAP, KNOWN_DIFFERENCES, FIELDS, STAFF_FIELDS, PUBLIC_FIELDS, EAGLE_ID
} = require('./parity-map');
const { logger } = require('../utils/logger');

/** Two requests a second per API: well under eagle-api's 200 a minute. */
const MIN_GAP_MS = 500;
const IDENTITIES = ['anonymous', 'staff', 'sysadmin'];
const ID_NAMES = ['project', 'period', 'document', 'comment', 'organization'];
const SAMPLE_CAP = 20;

const USAGE = `usage: node src/scripts/parity-eagle.js --eagle <eagle-api base> --demi <DEMI base>
  [--identity anonymous|staff|sysadmin] [--token-env <VAR>] [--only <read>] [--max-pages <n>]
  [--id project|period|document|comment|organization=<eagleId>]... [--known-ids <file>] [--report <file>]`;

function parseArgs(argv) {
  const args = { identity: 'anonymous', ids: {}, maxPages: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--eagle': args.eagle = value().replace(/\/+$/, ''); break;
      case '--demi': args.demi = value().replace(/\/+$/, ''); break;
      case '--identity': args.identity = value(); break;
      case '--token-env': args.tokenEnv = value(); break;
      case '--only': args.only = value(); break;
      case '--known-ids': args.knownIds = value(); break;
      case '--report': args.report = value(); break;
      case '--max-pages': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1) throw new Error('--max-pages needs a positive integer');
        args.maxPages = n;
        break;
      }
      case '--id': {
        const m = value().match(/^([a-z]+)=([A-Za-z0-9_-]+)$/);
        if (!m || !ID_NAMES.includes(m[1])) throw new Error(`--id takes <${ID_NAMES.join('|')}>=<id>`);
        args.ids[m[1]] = m[2];
        break;
      }
      case '--help': args.help = true; break;
      case '--token': throw new Error('a token is never taken on the command line: use --token-env <VAR>');
      // The stray value is not echoed: it may be a token pasted by mistake.
      default: throw new Error(flag.startsWith('--') ? `unknown flag ${flag}` : `unexpected argument #${i + 1}`);
    }
  }
  if (args.help) return args;
  for (const name of ['eagle', 'demi']) {
    if (!/^https?:\/\//.test(args[name] || '')) throw new Error(`--${name} needs an http(s) base URL`);
  }
  if (!IDENTITIES.includes(args.identity)) throw new Error(`--identity is one of ${IDENTITIES.join(', ')}`);
  if (args.identity === 'anonymous' && args.tokenEnv) throw new Error('anonymous runs send no token');
  if (args.identity !== 'anonymous' && !args.tokenEnv) throw new Error(`--identity ${args.identity} needs --token-env`);
  return args;
}

/** One API: GET only, at most one request per MIN_GAP_MS, one retry on 429 or 5xx. */
function client(base, token, deps) {
  let next = 0;
  const slot = async () => {
    const now = deps.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + MIN_GAP_MS;
    if (wait) await deps.sleep(wait);
  };
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  return {
    base,
    async get(url) {
      for (let attempt = 1; ; attempt++) {
        await slot();
        const res = await deps.fetch(url, { method: 'GET', headers, redirect: 'manual' });
        if (attempt === 1 && (res.status === 429 || res.status >= 500)) {
          if (res.status === 429) await deps.sleep(rateLimitWaitMs(res.headers, 1));
          continue;
        }
        return res;
      }
    }
  };
}

const fill = (value, ids) => String(value).replace(/:([a-z]+)/g, (_, name) => encodeURIComponent(ids[name]));

/** Id names an entry's paths and query values need. */
function idsNeeded(entry) {
  const text = [entry.eagle, entry.demi]
    .flatMap(spec => [spec.path, ...Object.values(spec.query || {})]).join(' ');
  return [...new Set([...text.matchAll(/:([a-z]+)/g)].map(m => m[1]))];
}

function urlOf(base, spec, ids, extra = {}) {
  const url = new URL(base + fill(spec.path, ids));
  for (const [key, value] of Object.entries({ ...spec.query, ...extra })) {
    url.searchParams.set(key, fill(value, ids));
  }
  return url.toString();
}

async function okJson(res, url) {
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}`);
  return res.json();
}

function arrayOf(body, url) {
  if (!Array.isArray(body)) throw new Error(`expected an array from ${new URL(url).pathname}`);
  return body;
}

/** The rows one side answers, and whether --max-pages cut the read short. */
async function rowsOf(api, spec, ids, maxPages) {
  if (spec.shape === 'object') {
    const url = urlOf(api.base, spec, ids);
    const res = await api.get(url);
    if (res.status === 404) return { rows: [], truncated: false };
    const body = await okJson(res, url);
    const value = spec.at ? body[spec.at] : body;
    return { rows: Array.isArray(value) ? value : value ? [value] : [], truncated: false };
  }
  const fetchPage = async (url) => {
    const res = await api.get(url);
    const body = await okJson(res, url);
    if (spec.shape === 'search') return unwrapSearchResponse(body, url);
    const total = Number(res.headers.get('x-total-count'));
    return { items: arrayOf(body, url), total: res.headers.get('x-total-count') !== null && Number.isFinite(total) ? total : null };
  };
  if (!spec.paged) return { rows: (await fetchPage(urlOf(api.base, spec, ids))).items, truncated: false };

  let last = { pages: 0, size: 0, count: 0, total: null };
  const rows = await fetchAllPages(api.base, spec.query && spec.query.dataset, {
    maxPages,
    fetchPage,
    pageUrl: (pageNum, pageSize) => urlOf(api.base, spec, ids, { pageNum, pageSize }),
    onPage: (items, count, total) => { last = { pages: last.pages + 1, size: items.length, count, total }; }
  });
  const truncated = last.pages >= maxPages && last.size === PAGE_SIZE &&
    (last.total === null || last.count < last.total);
  return { rows, truncated };
}

/** A value both APIs can be compared on: a populated ref is its id, an ISO date is canonical. */
function norm(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(norm);
  if (typeof value === 'object') return '_id' in value ? String(value._id) : value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return value;
}
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

function fieldsFor(entry, identity) {
  const extra = identity === 'anonymous' ? PUBLIC_FIELDS : STAFF_FIELDS;
  return [...(entry.fields || FIELDS[entry.dataset]), ...(extra[entry.dataset] || [])]
    .map(f => (Array.isArray(f) ? f : [f, f]));
}

const keyOf = row => String(row.eagleId || row._id || row.id);

/**
 * Counts for one read. Samples carry ids and field names only, never values: a comment row's
 * values can be personal data.
 */
function compare(entry, identity, eagle, demi, knownIds) {
  const out = { match: 0, missingInDemi: 0, extraInDemi: 0, fieldDiff: 0, unexplained: 0, classes: {}, samples: [] };
  const tally = (ctx) => {
    const hit = KNOWN_DIFFERENCES.find(k => k.kind === ctx.kind &&
      (!k.identities || k.identities.includes(identity)) &&
      (!k.reads || k.reads.includes(entry.read)) &&
      (k.ids ? !!(knownIds[k.name] && knownIds[k.name].has(ctx.id)) : k.match(ctx)));
    if (hit) {
      out.classes[hit.name] = (out.classes[hit.name] || 0) + 1;
      return;
    }
    out.unexplained++;
    if (out.samples.length < SAMPLE_CAP) {
      out.samples.push({ kind: ctx.kind, id: ctx.id, ...(ctx.field ? { field: ctx.field } : {}) });
    }
  };

  const eagleById = new Map(eagle.rows.map(row => [keyOf(row), row]));
  const sets = diff(demi.rows, keyOf, new Set(eagleById.keys()), row => EAGLE_ID.test(keyOf(row)));
  // A capped read sees an arbitrary slice of each side, so absence proves nothing.
  out.truncated = eagle.truncated || demi.truncated;
  if (!out.truncated) {
    for (const id of [...sets.eagleOnly, ...sets.unresolvedParent]) {
      out.missingInDemi++;
      tally({ kind: 'missingInDemi', id, eagle: eagleById.get(id) });
    }
    for (const row of [...sets.unpublishedOrDeleted, ...sets.trackOnly]) {
      out.extraInDemi++;
      tally({ kind: 'extraInDemi', id: keyOf(row), demi: row });
    }
  }

  const fields = fieldsFor(entry, identity);
  for (const row of demi.rows) {
    const id = keyOf(row);
    const eagleRow = eagleById.get(id);
    if (!eagleRow) continue;
    const differing = fields.filter(([e, d]) => !same(eagleRow[e], row[d]));
    if (!differing.length) out.match++;
    for (const [e, d] of differing) {
      out.fieldDiff++;
      tally({ kind: 'fieldDiff', id, dataset: entry.dataset, field: e, eagleValue: eagleRow[e], demiValue: row[d] });
    }
  }
  return out;
}

function lineOf(read, identity, r) {
  const classes = Object.entries(r.classes).map(([k, v]) => `${k}:${v}`).join(',');
  return `[parity] ${read} identity=${identity} match=${r.match} missingInDemi=${r.missingInDemi} ` +
    `extraInDemi=${r.extraInDemi} fieldDiff=${r.fieldDiff} unexplained=${r.unexplained}` +
    (classes ? ` known=${classes}` : '') + (r.truncated ? ' truncated' : '');
}

/** `{ "<class>": ["<eagleId>", ...] }`, for the classes that match by id. */
function loadKnownIds(file, readFile) {
  if (!file) return {};
  const raw = JSON.parse(readFile(file, 'utf8'));
  const idClasses = KNOWN_DIFFERENCES.filter(k => k.ids).map(k => k.name);
  return Object.fromEntries(Object.entries(raw).map(([name, ids]) => {
    if (!idClasses.includes(name)) throw new Error(`--known-ids: ${name} is not one of ${idClasses.join(', ')}`);
    return [name, new Set(ids.map(String))];
  }));
}

/** @returns {Promise<number>} the exit code */
async function run(argv, deps = {}) {
  const d = {
    fetch: (...a) => fetch(...a),
    now: Date.now,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    env: process.env,
    log: msg => logger.info(msg),
    error: msg => logger.error(msg),
    readFile: fs.readFileSync,
    writeFile: fs.writeFileSync,
    map: PARITY_MAP,
    ...deps
  };
  let args;
  let knownIds;
  let token = null;
  try {
    args = parseArgs(argv);
    if (args.help) {
      d.log(USAGE);
      return 0;
    }
    if (args.tokenEnv) {
      token = d.env[args.tokenEnv];
      if (!token) throw new Error(`environment variable ${args.tokenEnv} is empty or unset`);
    }
    knownIds = loadKnownIds(args.knownIds, d.readFile);
    for (const entry of d.map.filter(e => !e.skip)) {
      if (/download/i.test(entry.eagle.path)) throw new Error(`${entry.read}: download routes are never replayed`);
    }
    if (args.only && !d.map.some(e => e.read === args.only)) throw new Error(`--only: no read named ${args.only}`);
  } catch (err) {
    d.error(`[parity] ${err.message}`);
    return 1;
  }

  const eagle = client(args.eagle, token, d);
  const demi = client(args.demi, token, d);
  const { identity } = args;
  const results = [];

  for (const entry of d.map) {
    if (args.only && entry.read !== args.only) continue;
    if (entry.skip) {
      results.push({ read: entry.read, plan: entry.plan, status: 'skipped', pending: !!entry.pending, reason: entry.skip });
      d.log(`[parity] ${entry.read} identity=${identity} skipped${entry.pending ? ' (pending)' : ''}: ${entry.skip}`);
      continue;
    }
    if (!entry.identities.includes(identity)) continue;
    const missing = idsNeeded(entry).filter(name => !args.ids[name]);
    if (missing.length) {
      const reason = `needs ${missing.map(n => `--id ${n}=<eagleId>`).join(' ')}`;
      results.push({ read: entry.read, plan: entry.plan, status: 'skipped', reason });
      d.log(`[parity] ${entry.read} identity=${identity} skipped: ${reason}`);
      continue;
    }
    try {
      const eagleSide = await rowsOf(eagle, entry.eagle, args.ids, args.maxPages);
      const demiSide = await rowsOf(demi, entry.demi, args.ids, args.maxPages);
      const counts = compare(entry, identity, eagleSide, demiSide, knownIds);
      results.push({ read: entry.read, plan: entry.plan, status: 'compared', ...counts });
      d.log(lineOf(entry.read, identity, counts));
    } catch (err) {
      results.push({ read: entry.read, plan: entry.plan, status: 'error', message: err.message });
      d.error(`[parity] ${entry.read} identity=${identity} error: ${err.message}`);
    }
  }

  const failed = results.filter(r => r.status === 'error' || r.unexplained > 0).length;
  d.log(`[parity] identity=${identity} reads=${results.length} failed=${failed}`);
  if (args.report) {
    d.writeFile(args.report, JSON.stringify({ identity, eagle: args.eagle, demi: args.demi, results }, null, 2));
  }
  return failed ? 1 : 0;
}

module.exports = { parseArgs, run, MIN_GAP_MS };

if (require.main === module) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
    logger.error(`[parity] ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
