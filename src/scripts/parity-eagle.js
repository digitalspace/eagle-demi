'use strict';

/**
 * Read-only parity check: replays each eagle-api read in `parity-map.js` against eagle-api and
 * DEMI with the same identity, pairs rows by Eagle id and diffs row sets and field values. Every
 * difference not on the known list counts as unexplained, and any unexplained one exits 1.
 * Usage: README "Parity with eagle-api".
 */

const crypto = require('crypto');
const fs = require('fs');
const { fetchAllPages, unwrapSearchResponse, rateLimitWaitMs, PAGE_SIZE } = require('../seed/sources');
const { diff } = require('./reconcile-eagle');
const {
  PARITY_MAP, KNOWN_DIFFERENCES, FIELDS, STAFF_FIELDS, PUBLIC_FIELDS, PREDICATE_FIELDS, EAGLE_ID, same
} = require('./parity-map');
const { logger } = require('../utils/logger');

/** Two requests a second per API: well under eagle-api's 200 a minute. */
const MIN_GAP_MS = 500;
const IDENTITIES = ['anonymous', 'staff', 'sysadmin'];
const ID_NAMES = ['project', 'period', 'document', 'comment', 'organization', 'inspection', 'element', 'group'];
const SAMPLE_CAP = 20;
const REDIRECTS = [301, 302, 303, 307, 308];

const USAGE = `usage: node src/scripts/parity-eagle.js --eagle <eagle-api base> --demi <DEMI base>
  [--identity anonymous|staff|sysadmin] [--token-env <VAR>] [--only <read>] [--max-pages <n>]
  [--id <name>=<eagleId>]... [--known-ids <file>] [--report <file>] [--download-sample <n>]
  --id names: ${ID_NAMES.join(', ')}`;

function parseArgs(argv) {
  const args = { identity: 'anonymous', ids: {}, maxPages: Infinity, downloadSample: 0 };
  const count = (raw, min) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) throw new Error(`a whole number of at least ${min} is needed, got ${raw}`);
    return n;
  };
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
      case '--max-pages': args.maxPages = count(value(), 1); break;
      case '--download-sample': args.downloadSample = count(value(), 0); break;
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
  if (args.downloadSample && args.identity === 'anonymous') {
    throw new Error('--download-sample reads the protected download route: it needs a staff or sysadmin token');
  }
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

function okOrThrow(res, url) {
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}`);
  return res;
}
const okJson = (res, url) => okOrThrow(res, url).json();

/** RFC 4180 records: quoted fields may hold commas, line breaks and doubled quotes. */
function parseCsv(text) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  let open = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') field += text[++i];
      else quoted = false;
      continue;
    }
    open = true;
    if (c === '"') quoted = true;
    else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      open = false;
    } else field += c;
  }
  if (quoted) throw new Error('unterminated quoted CSV field');
  if (open) records.push([...record, field]);
  return records;
}

// BCGW's Project GUID cell carries literal quotes around the id.
const keyCell = value => String(value ?? '').replace(/^"(.*)"$/, '$1');

/** A CSV read: its header, and its rows as objects keyed by `_id` from the entry's key column. */
async function csvOf(api, entry, spec, ids) {
  const url = urlOf(api.base, spec, ids);
  const [header = [], ...records] = parseCsv(await okOrThrow(await api.get(url), url).text());
  if (!header.includes(entry.key)) throw new Error(`no ${entry.key} column from ${new URL(url).pathname}`);
  const rows = records.map(cells => ({
    ...Object.fromEntries(header.map((column, i) => [column, cells[i]])),
    _id: keyCell(cells[header.indexOf(entry.key)])
  }));
  return { header, rows, truncated: false };
}

function arrayOf(body, url) {
  if (!Array.isArray(body)) throw new Error(`expected an array from ${new URL(url).pathname}`);
  return body;
}

/** Eagle's count facet `[{ total_items, results }]` as one page of rows; any other array as is. */
function facetPage(body) {
  const facet = body.length === 1 && body[0] && Array.isArray(body[0].results) ? body[0] : null;
  if (!facet) return { items: body, total: null };
  return { items: facet.results, total: Number.isFinite(facet.total_items) ? facet.total_items : null };
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
    // Unwrapped per page: a facet is one item, so paging on the raw body would stop after page one.
    if (spec.facet) return facetPage(arrayOf(body, url));
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

function fieldsFor(entry, identity) {
  const extra = identity === 'anonymous' ? PUBLIC_FIELDS : STAFF_FIELDS;
  const pairs = [...(entry.fields || FIELDS[entry.dataset]), ...(extra[entry.dataset] || [])]
    .map(f => (Array.isArray(f) ? f : [f, f]));
  return pairs.filter(([e], i) => pairs.findIndex(([other]) => other === e) === i);
}

/** The Eagle spec with `fields=a|b|c` (eagle-api's pipe format) when the route takes it. */
function eagleSpecFor(entry, identity) {
  if (!entry.eagle.fields) return entry.eagle;
  const names = [...fieldsFor(entry, identity).map(([e]) => e), ...(PREDICATE_FIELDS[entry.dataset] || [])];
  return { ...entry.eagle, query: { ...entry.eagle.query, fields: [...new Set(names)].join('|') } };
}

const keyOf = row => String(row.eagleId || row._id || row.id);

/**
 * Counts for one read. Samples carry ids and field names only, never values: a comment row's
 * values can be personal data.
 */
function compare(entry, identity, eagle, demi, known, fields = fieldsFor(entry, identity), headerDiffs = []) {
  const out = { match: 0, missingInDemi: 0, extraInDemi: 0, fieldDiff: 0, unexplained: 0, classes: {}, samples: [] };
  const tally = (ctx) => {
    const full = { ...ctx, read: entry.read, dataset: entry.dataset, eaglePublicProjects: known.eaglePublicProjects };
    const hit = KNOWN_DIFFERENCES.find(k => [].concat(k.kind).includes(ctx.kind) &&
      (!k.identities || k.identities.includes(identity)) &&
      (!k.reads || k.reads.includes(entry.read)) &&
      (k.ids ? !!(known.ids[k.name] && known.ids[k.name].has(ctx.id)) : k.match(full)));
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
    const missing = [...sets.eagleOnly, ...sets.unresolvedParent].map(id => eagleById.get(id));
    const extra = [...sets.unpublishedOrDeleted, ...sets.trackOnly];
    for (const row of missing) {
      out.missingInDemi++;
      tally({ kind: 'missingInDemi', id: keyOf(row), eagle: row, unpaired: extra });
    }
    for (const row of extra) {
      out.extraInDemi++;
      tally({ kind: 'extraInDemi', id: keyOf(row), demi: row, unpaired: missing,
        byEagleId: !entry.format || !!entry.keyIsEagleId });
    }
  }

  for (const row of demi.rows) {
    const id = keyOf(row);
    const eagleRow = eagleById.get(id);
    if (!eagleRow) continue;
    const differing = fields.filter(([e, d]) => !same(eagleRow[e], row[d]));
    if (!differing.length) out.match++;
    for (const [e, d] of differing) {
      out.fieldDiff++;
      tally({ kind: 'fieldDiff', id, field: e, eagleValue: eagleRow[e], demiValue: row[d], eagle: eagleRow, demi: row });
    }
  }
  for (const field of headerDiffs) {
    out.fieldDiff++;
    tally({ kind: 'fieldDiff', id: 'header', field });
  }
  return out;
}

/** A CSV read: rows on every shared column, and header differences under id `header`. */
function compareCsv(entry, identity, eagle, demi, known) {
  const ignored = new Set([entry.key, ...(entry.ignoreColumns || [])]);
  const [eagleCols, demiCols] = [eagle.header, demi.header].map(h => h.filter(c => !ignored.has(c)));
  const shared = eagleCols.filter(c => demiCols.includes(c));
  const headerDiffs = [
    ...eagleCols.filter(c => !demiCols.includes(c)),
    ...demiCols.filter(c => !eagleCols.includes(c)),
    ...(JSON.stringify(shared) === JSON.stringify(demiCols.filter(c => eagleCols.includes(c))) ? [] : ['column order'])
  ];
  return compare(entry, identity, eagle, demi, known, shared.map(c => [c, c]), headerDiffs);
}

/** sha256 and byte length of a response body, read as a stream. */
async function digest(res, url) {
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}`);
  const hash = crypto.createHash('sha256');
  let length = 0;
  for await (const chunk of res.body || []) {
    hash.update(chunk);
    length += chunk.length;
  }
  return { sha256: hash.digest('hex'), length };
}

/** The same file through Eagle's protected route and DEMI's, which may redirect to object storage. */
async function compareDownloads(entry, ids, eagle, demi, store) {
  const out = { sampled: ids.length, match: 0, missingInDemi: 0, extraInDemi: 0, fieldDiff: 0, unexplained: 0,
    classes: {}, samples: [] };
  const flag = (sample) => {
    out.unexplained++;
    if (out.samples.length < SAMPLE_CAP) out.samples.push(sample);
  };
  for (const id of ids) {
    const eagleUrl = urlOf(eagle.base, entry.eagle, { document: id });
    const fromEagle = await digest(await eagle.get(eagleUrl), eagleUrl);
    let url = urlOf(demi.base, entry.demi, { document: id });
    let res = await demi.get(url);
    if (res.status === 404) {
      out.missingInDemi++;
      flag({ kind: 'missingInDemi', id });
      continue;
    }
    if (REDIRECTS.includes(res.status)) {
      url = new URL(res.headers.get('location'), url).toString();
      res = await store.get(url);
    }
    const fromDemi = await digest(res, url);
    const differing = ['sha256', 'length'].filter(k => fromEagle[k] !== fromDemi[k]);
    if (!differing.length) out.match++;
    for (const field of differing) {
      out.fieldDiff++;
      flag({ kind: 'fieldDiff', id, field });
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
      if (/^\/public\/.*download/i.test(entry.eagle.path)) {
        throw new Error(`${entry.read}: the public download route is never called`);
      }
    }
    if (args.only && !d.map.some(e => e.read === args.only)) throw new Error(`--only: no read named ${args.only}`);
  } catch (err) {
    d.error(`[parity] ${err.message}`);
    return 1;
  }

  const eagle = client(args.eagle, token, d);
  const demi = client(args.demi, token, d);
  // The presigned URL DEMI redirects to carries its own signature; the bearer token never goes there.
  const store = client(null, null, d);
  const { identity } = args;
  const results = [];

  const pairedDocuments = new Set();
  const downloads = [];
  let eaglePublicProjects;
  // Ids of every project Eagle shows the public, or null when --max-pages cut the list short.
  const loadEaglePublicProjects = async () => {
    if (eaglePublicProjects === undefined) {
      const side = await rowsOf(eagle, { path: '/public/project', shape: 'array', paged: true }, args.ids, args.maxPages);
      eaglePublicProjects = side.truncated ? null : new Set(side.rows.map(keyOf));
    }
    return eaglePublicProjects;
  };
  const record = (entry, outcome) => {
    results.push({ read: entry.read, plan: entry.plan, ...outcome });
    if (outcome.status === 'skipped') {
      d.log(`[parity] ${entry.read} identity=${identity} skipped${outcome.pending ? ' (pending)' : ''}: ${outcome.reason}`);
    } else if (outcome.status === 'error') {
      d.error(`[parity] ${entry.read} identity=${identity} error: ${outcome.message}`);
    } else {
      d.log(lineOf(entry.read, identity, outcome));
    }
  };

  for (const entry of d.map) {
    if (args.only && entry.read !== args.only) continue;
    if (entry.download && !entry.skip) {
      downloads.push(entry);
      continue;
    }
    if (entry.skip) {
      record(entry, { status: 'skipped', pending: !!entry.pending, reason: entry.skip });
      continue;
    }
    if (!entry.identities.includes(identity)) continue;
    const missing = idsNeeded(entry).filter(name => !args.ids[name]);
    if (missing.length) {
      record(entry, { status: 'skipped', reason: `needs ${missing.map(n => `--id ${n}=<eagleId>`).join(' ')}` });
      continue;
    }
    const sideOf = async (api, spec, map) => {
      const side = entry.format === 'csv'
        ? await csvOf(api, entry, spec, args.ids)
        : await rowsOf(api, spec, args.ids, args.maxPages);
      return map ? { ...side, rows: map(side.rows) } : side;
    };
    try {
      const eagleSide = await sideOf(eagle, eagleSpecFor(entry, identity), entry.mapEagle);
      const demiSide = await sideOf(demi, entry.demi, entry.mapDemi);
      if (entry.dataset === 'Document') {
        const eagleIds = new Set(eagleSide.rows.map(keyOf));
        demiSide.rows.map(keyOf).filter(id => eagleIds.has(id)).forEach(id => pairedDocuments.add(id));
      }
      const compareRead = entry.format === 'csv' ? compareCsv : compare;
      const known = {
        ids: knownIds,
        eaglePublicProjects: identity === 'anonymous' && entry.dataset === 'CommentPeriod' ? await loadEaglePublicProjects() : null
      };
      record(entry, { status: 'compared', ...compareRead(entry, identity, eagleSide, demiSide, known) });
    } catch (err) {
      record(entry, { status: 'error', message: err.message });
    }
  }

  for (const entry of downloads) {
    if (!entry.identities.includes(identity)) continue;
    const ids = [...new Set([args.ids.document, ...pairedDocuments])]
      .filter(id => id && EAGLE_ID.test(id)).slice(0, args.downloadSample);
    if (!args.downloadSample) {
      record(entry, { status: 'skipped', reason: 'off: pass --download-sample <n>' });
    } else if (!ids.length) {
      record(entry, { status: 'skipped', reason: 'no document paired on both sides, and no --id document' });
    } else {
      try {
        record(entry, { status: 'compared', ...await compareDownloads(entry, ids, eagle, demi, store) });
      } catch (err) {
        record(entry, { status: 'error', message: err.message });
      }
    }
  }

  const failed = results.filter(r => r.status === 'error' || r.unexplained > 0).length;
  d.log(`[parity] identity=${identity} reads=${results.length} failed=${failed}`);
  if (args.report) {
    d.writeFile(args.report, JSON.stringify({ identity, eagle: args.eagle, demi: args.demi, results }, null, 2));
  }
  return failed ? 1 : 0;
}

module.exports = { parseArgs, parseCsv, run, MIN_GAP_MS };

if (require.main === module) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
    logger.error(`[parity] ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
