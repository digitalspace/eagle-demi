'use strict';

/**
 * Diff demi-api's search answers against eagle-search's, one case at a time.
 *
 * eagle-search is being folded into DEMI, so demi-api becomes the query layer behind
 * eagle-public's `/search`. Everything eagle-public renders is derived from three things in the
 * response — the total it pages against, the row order it lists, and the keys it reads off a row —
 * so those three are what this compares. It is an oracle, not a test suite: it says where the two
 * services disagree today, so a later change to demi-api's contract can be shown to have moved a
 * specific disagreement rather than "looked fine in the browser".
 *
 * THE ORACLE IS PRODUCTION eagle-search, AND THAT IS NOT A CONVENIENCE. Measured 2026-08-22:
 * demi-cosmos-test carries the PROD corpus (60,578 documents / 382 projects) while
 * eagle-search-test carries the far smaller TEST corpus. A test-vs-test diff would therefore
 * compare two different bodies of data and report a wall of noise no change could ever clear.
 * Prod eagle-search answers anonymously; test demi-api is behind rproxy's basic auth. That
 * asymmetry is why only one side takes a credential.
 *
 * ACCEPTANCE IS INVERTED: against today's code this MUST report DIFFs. Two are known and are the
 * reason the tool exists — (1) demi drops filter keys its indexes cannot express and answers with
 * the UNFILTERED corpus where eagle applies the filter (`and[type]=Mines` on Project: eagle 107,
 * demi 382, i.e. every project), and (2) DocumentChunk rows are a different shape on each side —
 * demi returns one row per PASSAGE (`snippet`, `_id` = chunkId), eagle returns rows grouped per
 * DOCUMENT (`snippets`, `matchCount`, `_id` = documentId). A run that reports "all match" today is
 * a broken differ, not a fixed API.
 *
 * The corpora are not identical either — the totals differ on every unfiltered case (documents
 * 60,578 vs 61,582) because DEMI's index was built from its own Cosmos copy. Those diffs are real
 * and worth seeing; they are not the ones a contract change can close.
 *
 * Usage:
 *   DEMI_DIFF_USER=… DEMI_DIFF_PASS=… node src/scripts/search-diff.js [--case=7] [--json]
 *   node src/scripts/search-diff.js --user=user:pass --delay=400 --page-size=10
 * Exit code is 1 when any case DIFFs, so it can gate later work.
 */

const DEMI_URL = 'https://test.projects.eao.gov.bc.ca/demi-search/search';
const EAGLE_URL = 'https://projects.eao.gov.bc.ca/eagle-search/search';

/**
 * A milestone every side knows, taken off a real prod document row rather than invented.
 * eagle-search filters on it; DEMI's `documents` index has no `milestone` field at all, so
 * `eagle-query.js` drops the key and answers with the whole corpus. That is diff class (1).
 */
const MILESTONE = '5cf00c03a266b7e1877504e9';

/**
 * The case matrix — dataset x keywords x filter x sortBy, expanded over `PAGES` below.
 *
 * One spec per line, and one line is all a new case takes. Deliberately NOT the full cross product:
 * that is 108 cases / 216 requests against a service whose rate limit is shared with real traffic,
 * and it buys nothing — each dimension is varied against a fixed baseline, which is what localises
 * a disagreement to the dimension that caused it.
 *
 * `filter` is written `key=value` and becomes `and[key]=value` on the wire, the repeat-key form
 * eagle-public's `api.ts` emits. No keyword-less DocumentChunk case: chunk search over `*` ranks
 * nothing and the index cannot sort (`chunks` has no sortable field), so the page order is
 * arbitrary on both sides and the comparison would flap rather than fail.
 */
const CASES = [
  { dataset: 'Project' },
  // 'coal', not 'mine': `mine` matches nothing on EITHER side, so the case passed by comparing two
  // empty pages — an agreement that exercised no row and no key. A keyword case has to return rows.
  { dataset: 'Project', keywords: 'coal' },
  { dataset: 'Project', filter: 'type=Mines' },
  { dataset: 'Project', sortBy: '-datePosted' },
  { dataset: 'Project', sortBy: '+displayName' },
  { dataset: 'Document' },
  { dataset: 'Document', keywords: 'water' },
  { dataset: 'Document', filter: `milestone=${MILESTONE}` },
  { dataset: 'Document', keywords: 'water', sortBy: '-datePosted' },
  { dataset: 'Document', keywords: 'water', sortBy: '+displayName' },
  { dataset: 'DocumentChunk', keywords: 'water' },
  { dataset: 'DocumentChunk', keywords: 'water', filter: `milestone=${MILESTONE}` },
  { dataset: 'DocumentChunk', keywords: 'fish habitat', sortBy: '-datePosted' },
  // The shape eagle-public REALLY sends: `sortBy` twice, the second often empty
  // (`api.ts:176-177` appends sortBy and then secondarySort). It is the one wire form both
  // implementations wrote explicit normalisation for, so it is the one most likely to diverge.
  { dataset: 'Document', sortBy: ['-datePosted', '+displayName'] }
];

/**
 * `pageNum` is 0-BASED on this wire — eagle-public's `api.ts` sends the first page as 0 and both
 * services compute `skip = pageNum * pageSize` from it. So these are pages 1, 2 and 3. Page 2 and
 * 3 are here because an unstable sort only shows itself past the first page.
 */
const PAGES = [0, 1, 2];

const DEFAULTS = { case: 0, json: false, delayMs: 250, pageSize: 10, user: '' };

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? '' : arg.slice(eq + 1); // never split on every '=': a password may hold one
    if (flag === '--json') args.json = true;
    else if (flag === '--case') args.case = Number(value);
    else if (flag === '--delay') args.delayMs = Number(value);
    else if (flag === '--page-size') args.pageSize = Number(value);
    else if (flag === '--user') args.user = value;
    // Echo the FLAG, never the token. `--user demiuser:hunter2` (a space instead of `=`, the
    // commonest typo on this script) arrives as a bare argv entry, and printing it would put the
    // credential in the terminal and the shell history of whoever ran it.
    else throw new Error(`[search-diff] unknown argument: ${flag.startsWith('--') ? flag : '<bare value>'}`);
  }
  if (!Number.isInteger(args.case) || args.case < 0) {
    throw new Error('[search-diff] --case must be a positive integer');
  }
  if (!Number.isInteger(args.delayMs) || args.delayMs < 0) {
    throw new Error('[search-diff] --delay must be a non-negative integer of milliseconds');
  }
  if (!Number.isInteger(args.pageSize) || args.pageSize < 1) {
    throw new Error('[search-diff] --page-size must be a positive integer');
  }
  return args;
}

/**
 * The demi credential, as `user:pass`. NEVER logged, never put in a URL — it goes into an
 * Authorization header and nowhere else.
 *
 * Missing is a hard stop rather than an anonymous attempt: rproxy answers 401 to every request
 * without it, which would print 39 DIFFs that say nothing about the contract and read exactly like
 * a broken API.
 */
function credential(args, env) {
  if (args.user) return args.user;
  if (env.DEMI_DIFF_USER && env.DEMI_DIFF_PASS) return `${env.DEMI_DIFF_USER}:${env.DEMI_DIFF_PASS}`;
  throw new Error(
    '[search-diff] no demi credential — set DEMI_DIFF_USER and DEMI_DIFF_PASS, or pass --user=user:pass'
  );
}

/** Specs x pages, numbered from 1 so `--case=N` matches what the report prints. */
function expandCases(specs = CASES, pages = PAGES) {
  const out = [];
  for (const spec of specs) {
    for (const pageNum of pages) out.push({ n: out.length + 1, ...spec, pageNum });
  }
  return out;
}

function buildUrl(base, kase, pageSize = DEFAULTS.pageSize) {
  const url = new URL(base);
  const params = url.searchParams;
  params.set('dataset', kase.dataset);
  if (kase.keywords) params.set('keywords', kase.keywords);
  // `+displayName` goes out as %2B because URLSearchParams encodes it, and that is CORRECT but it
  // is NOT what eagle-public sends: `api.ts:176` concatenates the query string by hand, so the real
  // client emits a bare `+`, the server decodes it to a leading space, and both implementations
  // `.trim()` it back. Either shape works; this one is the unambiguous one. Do not "fix" the
  // encoding to match the client without also checking the trim on both sides.
  for (const s of [].concat(kase.sortBy || [])) params.append('sortBy', s);
  if (kase.filter) {
    const eq = kase.filter.indexOf('=');
    params.set(`and[${kase.filter.slice(0, eq)}]`, kase.filter.slice(eq + 1));
  }
  params.set('pageNum', String(kase.pageNum));
  params.set('pageSize', String(pageSize));
  return url.toString();
}

function label(kase) {
  const bits = [kase.dataset];
  if (kase.keywords) bits.push(`keywords="${kase.keywords}"`);
  if (kase.filter) bits.push(`and[${kase.filter.replace('=', ']=')}`);
  if (kase.sortBy) bits.push(`sortBy=${kase.sortBy}`);
  bits.push(`page=${kase.pageNum + 1}`);
  return bits.join(' ');
}

/**
 * The three comparable facts, pulled out of one side's response.
 *
 * `null` means NOT PRESENT, and is never confused with 0 or []: an absent `searchResultsTotal` is
 * demi-api saying the total was not measured (see the `sendJson` wrapper in controllers/search.js),
 * which is a different disagreement from the two sides measuring different numbers.
 */
function summarize(resp) {
  const first = Array.isArray(resp.payload) ? resp.payload[0] : null;
  const rows = first && Array.isArray(first.searchResults) ? first.searchResults : null;
  const meta = first && Array.isArray(first.meta) ? first.meta[0] : null;
  const total = meta && Number.isFinite(meta.searchResultsTotal) ? meta.searchResultsTotal : null;
  return {
    status: resp.status,
    total,
    ids: rows ? rows.map(row => String(row && row._id)) : null,
    keys: rows && rows.length ? Object.keys(rows[0]).sort() : null
  };
}

/**
 * The whole comparison, pure — two responses in, a verdict out. No network, no clock, no process
 * exit, so it can be pinned against recorded shapes in a unit test.
 *
 * Each side is `{ status, payload }`. Row ids are compared IN ORDER: the same rows in a different
 * order is a real defect for a paging client, so a set comparison here would hide it.
 */
function compareCase(demi, eagle) {
  const d = summarize(demi);
  const e = summarize(eagle);
  const diffs = [];

  // A non-200 has no rows to compare, so it is the only finding worth making about that case —
  // the field diffs below would all fire and bury it.
  if (d.status !== 200 || e.status !== 200) {
    diffs.push({ field: 'httpStatus', demi: d.status, eagle: e.status });
    return { pass: false, demi: d, eagle: e, diffs };
  }

  if (d.ids === null || e.ids === null) {
    // 200 with something that is not `[{ searchResults: [...] }]` — an error body, or an envelope
    // change. Named separately because "no rows" and "no row array" are different failures.
    diffs.push({ field: 'envelope', demi: d.ids === null, eagle: e.ids === null });
    return { pass: false, demi: d, eagle: e, diffs };
  }

  if (d.total !== e.total) diffs.push({ field: 'searchResultsTotal', demi: d.total, eagle: e.total });

  if (d.ids.length !== e.ids.length || d.ids.some((id, i) => id !== e.ids[i])) {
    diffs.push({ field: 'rowIds', demi: d.ids, eagle: e.ids });
  }

  if (d.keys || e.keys) {
    const demiKeys = d.keys || [];
    const eagleKeys = e.keys || [];
    const demiOnly = demiKeys.filter(k => !eagleKeys.includes(k));
    const eagleOnly = eagleKeys.filter(k => !demiKeys.includes(k));
    if (demiOnly.length || eagleOnly.length) diffs.push({ field: 'rowKeys', demiOnly, eagleOnly });
  }

  return { pass: diffs.length === 0, demi: d, eagle: e, diffs };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function get(url, auth) {
  const headers = auth ? { Authorization: `Basic ${Buffer.from(auth).toString('base64')}` } : {};
  try {
    const res = await fetch(url, { headers });
    const text = await res.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch { payload = null; }
    return { status: res.status, payload };
  } catch (err) {
    // A transport failure is reported as its own status rather than thrown: one flaky case must not
    // abandon the other 38, and `0` cannot collide with a real HTTP status.
    return { status: 0, payload: null, error: err.message };
  }
}

function formatDiff(diff) {
  if (diff.field === 'rowKeys') {
    return `    rowKeys: demi-only=[${diff.demiOnly.join(',')}] eagle-only=[${diff.eagleOnly.join(',')}]`;
  }
  const fmt = v => (Array.isArray(v) ? `[${v.join(', ')}]` : String(v));
  return `    ${diff.field}: demi=${fmt(diff.demi)} eagle=${fmt(diff.eagle)}`;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const auth = credential(args, env);
  const all = expandCases();
  const cases = args.case ? all.filter(k => k.n === args.case) : all;
  if (cases.length === 0) throw new Error(`[search-diff] no such case: ${args.case} (1..${all.length})`);

  const results = [];
  for (const kase of cases) {
    // Sequential, with a pause between EVERY request. demi-api's limit is 300 requests / 60s and it
    // is shared by everything behind rproxy, so a parallel fan-out of 78 requests would both distort
    // the answers and take budget from real callers. 250ms x 2 requests keeps a full run near 8/s.
    const demi = await get(buildUrl(DEMI_URL, kase, args.pageSize), auth);
    await sleep(args.delayMs);
    const eagle = await get(buildUrl(EAGLE_URL, kase, args.pageSize), null);
    await sleep(args.delayMs);

    const verdict = compareCase(demi, eagle);
    results.push({ case: kase.n, label: label(kase), ...verdict });
    if (!args.json) {
      console.log(`[${String(kase.n).padStart(2)}/${all.length}] ${verdict.pass ? 'PASS' : 'DIFF'}  ${label(kase)}`);
      for (const diff of verdict.diffs) console.log(formatDiff(diff));
    }
  }

  const failed = results.filter(r => !r.pass);
  if (args.json) {
    console.log(JSON.stringify({ total: results.length, diffs: failed.length, results }, null, 2));
  } else {
    console.log(`\n${results.length - failed.length} PASS, ${failed.length} DIFF` +
      (failed.length ? ` — cases ${failed.map(r => r.case).join(', ')}` : ''));
  }
  return failed.length === 0 ? 0 : 1;
}

if (require.main === module) {
  main()
    .then(code => { process.exitCode = code; })
    .catch(err => { console.error(err.message); process.exitCode = 2; });
}

module.exports = {
  CASES, PAGES, DEMI_URL, EAGLE_URL,
  parseArgs, credential, expandCases, buildUrl, label, summarize, compareCase, main
};
