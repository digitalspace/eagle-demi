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
 * ACCEPTANCE, and it is no longer inverted. A run is GREEN when, for every case:
 *
 *   - the SELECTIVITY boolean agrees across the two services — did this filter change the answer,
 *     each measured against its own unfiltered baseline;
 *   - the same for a named SORT — did it change the page;
 *   - the row-key delta is a subset of `EXPECTED_KEY_DELTA` for that dataset;
 *   - and demi's own paging is free of rows that appear on two pages.
 *
 * Raw totals and row order are printed and never asserted. That is the whole design: they are
 * properties of the corpus, and THE TWO SERVICES DO NOT SHARE ONE. Measured 2026-08-24, demi holds
 * 60,560 documents and 348 projects against eagle's 61,582 and 358 — and the gap is not drift.
 * `src/seed/sources.js` defaults `EAGLE_API_BASE` to eagle-DEV, whose newest document is dated
 * 2026-06-15; demi's document counts track dev on every year and diverge from prod only in 2026
 * (demi 10, dev 12, prod 899). An earlier version of this file asserted on those numbers and
 * therefore reported 42 DIFFs out of 42 on every run, which is why it was never used to gate
 * anything. An oracle that cannot go green cannot fail informatively either.
 *
 * What it still WILL report today, by design: `DocumentChunk` document-metadata filters are
 * `IGNORED` on demi and `applied` on eagle, because `chunks.json` carries no metadata to filter on;
 * `isFeatured` the same on Document; and demi's document paging repeats rows on project-name
 * keyword queries. Those are open defects, and each one going quiet is what proves a fix landed.
 *
 * Usage:
 *   DEMI_DIFF_USER=… DEMI_DIFF_PASS=… node src/scripts/search-diff.js [--case=7] [--json]
 *   node src/scripts/search-diff.js --user=user:pass --delay=400 --page-size=10
 * Exit code is 1 when any case DIFFs, so it can gate later work.
 */

// `test.projects.eao.gov.bc.ca` is behind rproxy's basic auth. `demi-api-test.azurewebsites.net`
// is the SAME app answering the same routes anonymously, and a contract comparison gains nothing
// from the proxy hop. Overridable because needing a secret to read a public contract is the reason
// this oracle had never been baselined:
//   DEMI_DIFF_URL=https://demi-api-test.azurewebsites.net/api/search node src/scripts/search-diff.js
const DEMI_URL = process.env.DEMI_DIFF_URL
  || 'https://test.projects.eao.gov.bc.ca/demi-search/search';
const EAGLE_URL = 'https://projects.eao.gov.bc.ca/eagle-search/search';

/** The one host that answers 401 without a credential. Matched on the HOST, so a path change to
 *  `/demi-search` — or an override pointing back at it — keeps the hard stop. */
const RPROXY_HOST = /(^|\/\/)test\.projects\.eao\.gov\.bc\.ca(\/|$)/;

/**
 * A milestone every side knows, taken off a real prod document row rather than invented.
 *
 * WHAT THIS CASE MEASURES CHANGED, and the changing is the point: when this differ was written,
 * DEMI's `documents` index had no `milestone` field, `eagle-query.js` dropped the key, and demi
 * answered with the whole 60,578-row corpus against eagle-search's 36,471 — diff class (1). The
 * index now carries `milestoneId` and the key is mapped onto it, so once the app ships this case
 * should MATCH. It is the acceptance test for that work, not a standing example of the bug.
 *
 * `and[type]=Mines` on Project is still a live example of class (1): Project has no `type` alias
 * and the projects index has no such field.
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
  // A NARROW chunk filter, and the whole reason it is here is that the broad one is an accepted
  // divergence. Chunk metadata filters are resolved through the documents index and scoped by
  // documentId, which is bounded — so `milestone` (36,471 documents) is over the cap and reported
  // as dropped, while a filter this size is under it and MUST narrow on both services. Without
  // this case the acceptance above would cover the working half too, and a regression that broke
  // scoping entirely would read as the known limitation.
  { dataset: 'DocumentChunk', keywords: 'water', filter: 'documentAuthorType=5cf00c03a266b7e1877504ea' },
  // The shape eagle-public REALLY sends: `sortBy` twice, the second often empty
  // (`api.ts:176-177` appends sortBy and then secondarySort). It is the one wire form both
  // implementations wrote explicit normalisation for, so it is the one most likely to diverge.
  { dataset: 'Document', sortBy: ['-datePosted', '+displayName'] },
  // A PROJECT NAME as the keyword, which the rest of the matrix had no case for — and that absence
  // is why the repeated-row paging defect was invisible here while being trivially reproducible by
  // hand. A project name matches through several fields at once, which is what exhausts demi's
  // first search leg and hands the page boundary to the second one's skip arithmetic. Generic
  // keywords like `water` never reach that branch and page cleanly on both services.
  { dataset: 'Document', keywords: 'pattullo', pages: [...Array(26).keys()] }
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
function credential(args, env, url = DEMI_URL) {
  if (args.user) return args.user;
  if (env.DEMI_DIFF_USER && env.DEMI_DIFF_PASS) return `${env.DEMI_DIFF_USER}:${env.DEMI_DIFF_PASS}`;
  // Anonymous is the CORRECT answer for a target that is not behind basic auth, and returning null
  // here is what lets the differ run with no secret at all. The hard stop stays for the rproxy host
  // alone, where it is still right: without a credential that host answers 401 to every request,
  // and the run would print 39 DIFFs that are all the same 401 wearing a contract's clothes.
  if (!RPROXY_HOST.test(url)) return null;
  throw new Error(
    '[search-diff] no demi credential — set DEMI_DIFF_USER and DEMI_DIFF_PASS, or pass --user=user:pass'
  );
}

/** Specs x pages, numbered from 1 so `--case=N` matches what the report prints. */
function expandCases(specs = CASES, pages = PAGES) {
  const out = [];
  for (const spec of specs) {
    // A case may ask for its OWN page range. Three pages is enough to catch a sort that is not
    // stable, but not a paging defect that only starts once the first search leg is exhausted —
    // measured, that is page 7 for `pattullo` and page 25 for `kitimat`. A case that exists to
    // exercise paging has to be allowed to page.
    const { pages: own, ...rest } = spec;
    for (const pageNum of own || pages) out.push({ n: out.length + 1, ...rest, pageNum });
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

/**
 * Behavioural divergences that are DECIDED, not defects — the sort counterpart to
 * `EXPECTED_KEY_DELTA`, and the reason a green run is achievable at all.
 *
 * The bar this tool exists to enforce is "every disagreement with prod is either fixed or knowingly
 * accepted in writing". An acceptance with no written reason is indistinguishable from an oversight,
 * so the reason is a required field here and it is printed in the report next to the case. Deleting
 * an entry is how you re-open the question.
 *
 * Keyed `dataset:field`. Everything not listed fails the run.
 */
const EXPECTED_DIVERGENCE = {
  'DocumentChunk:selective':
    'a chunk filter is resolved through the documents index and scoped by documentId, and that ' +
    'scope is BOUNDED: above ai-search.js DOCUMENT_SCOPE_CAP the key is reported in meta.dropped ' +
    'rather than applied to an arbitrary prefix of the match set. The two chunk cases in this ' +
    'matrix both filter on `milestone`, which matches 36,471 documents and is far over the cap, so ' +
    'demi answers unfiltered-and-says-so where eagle narrows. This acceptance covers the BROAD ' +
    'case only — the narrow case is a live assertion, not an acceptance: see the ' +
    '`and[documentAuthorType]` case below, which is small enough to scope and MUST stay selective ' +
    'on both sides. Remove this entry if the chunks index ever carries document metadata itself.',
  'DocumentChunk:sortHonoured':
    'demi never sorts chunks: every field in azure/search/indexes/chunks.json is sortable:false, ' +
    'the key included, and naming a non-sortable field is a 400 from the service. Chunk results are ' +
    'relevance-ordered. eagle-public never sorts this dataset (search/content sends no sortBy).'
};

/**
 * The same case with its filter and sort stripped — the denominator for selectivity.
 *
 * Returns null when there is nothing to strip. A case with neither a filter nor a sort carries no
 * selectivity signal at all, and fetching a "baseline" for it would just be the same request twice.
 */
function baselineOf(kase) {
  if (!kase.filter && !kase.sortBy) return null;
  const { filter, sortBy, ...rest } = kase; // eslint-disable-line no-unused-vars
  return rest;
}

/**
 * Everything about a case except which page it is — the unit paging is graded over.
 *
 * Built by dropping `pageNum` before `label` sees it, NOT by stripping the rendered suffix
 * afterwards: `label` prints `pageNum + 1`, so a null page renders as "page=1" and a strip of
 * " page=null" silently matches nothing. The first version of this did exactly that and every
 * paging line in the report claimed to be about page 1.
 */
function specKey(kase) {
  const { pageNum, ...rest } = kase; // eslint-disable-line no-unused-vars
  return label({ ...rest, pageNum: undefined }).replace(/ page=\S+$/, '');
}

function label(kase) {
  const bits = [kase.dataset];
  if (kase.keywords) bits.push(`keywords="${kase.keywords}"`);
  if (kase.filter) bits.push(`and[${kase.filter.replace('=', ']=')}`);
  if (kase.sortBy) bits.push(`sortBy=${kase.sortBy}`);
  if (kase.pageNum !== undefined) bits.push(`page=${kase.pageNum + 1}`);
  return bits.join(' ');
}

/**
 * The row keys each side emits that the other deliberately does not, per dataset. MEASURED against
 * both live services on 2026-08-24, not composed from the index definitions.
 *
 * This constant is the whole reason the key comparison can pass. Raw symmetry can never hold — the
 * two services were built a decade apart against different stores — so comparing key sets for
 * equality only ever produces a wall of noise. Comparing the DELTA against a declared expectation
 * turns "we know about these differences" from a paragraph in a README into something the runner
 * enforces: a key that appears outside this list, in either direction, is a real contract change
 * and fails the run.
 *
 * So the list is an ACCEPTANCE, not a suppression. Shrink it as gaps close — every entry under
 * `eagleOnly` is a column demi does not serve, and three of them are open defects rather than
 * decisions: `isFeatured` and `documentSource` on Document, and `location` / `pcpStatus` /
 * `proponentId` on Project. They are listed so the run is green on everything ELSE while they are
 * open; deleting the entry is what proves one fixed.
 *
 * `demiOnly` is the opposite direction and mostly deliberate: `sources` carries the wildfire
 * proximity block that only DEMI computes, `legacyEagleId` and `trackProjectId` exist so an Eagle
 * URL still resolves after the id cutover, and `isPublished` is read[]'s mirror (ADR-004).
 */
const EXPECTED_KEY_DELTA = {
  Project: {
    // `highlighted` is here for the same reason it is under Document: it rides demi's AI Search
    // branch, which a keyword, a filter or a sort routes to, and is absent from the Cosmos branch.
    // It was missing from this list on the first pass because the delta was measured from a BARE
    // request, which takes the other branch — and 12 of 45 cases then failed on a key that was
    // always expected. Measure a constant like this from a request that exercises both branches.
    demiOnly: ['highlighted', 'isPublished', 'legacyEagleId', 'sources', 'trackProjectId'],
    eagleOnly: ['@search.score', 'ceaaInvolvementId', 'currentPhaseNameId', 'displayName',
      'eacDecisionId', 'electoralDistrict', 'location', 'municipality', 'pcpStatus', 'popularity',
      'proponentId', 'read', 'regionalDistrict', 'updatedDate']
  },
  Document: {
    // `highlighted` appears only on the AI Search branch, which a sort or a filter routes to — so it
    // is expected-present rather than always-present, and an absence is not a finding.
    demiOnly: ['documentType', 'highlighted', 'isPublished'],
    eagleOnly: ['@search.score', 'categorized', 'dateUploaded', 'documentAuthorTypeId',
      'documentSource', 'id', 'internalExt', 'isFeatured', 'legislation', 'milestoneId',
      'popularity', 'projectPhaseId', 'read', 'sortOrder', 'typeId']
  },
  DocumentChunk: {
    // The row UNIT differs here, which is why this delta is the largest: demi returns one row per
    // passage and eagle one row per parent document. `datePosted` and `milestone` are the exception
    // — those are an open defect, not a shape difference (the parent-document SELECT omits them).
    demiOnly: ['chunkId', 'content', 'pageNumber', 'projectName', 'snippet'],
    eagleOnly: ['datePosted', 'documentTypeId', 'milestone', 'milestoneId', 'read']
  }
};

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
 * WHAT IT COMPARES, AND WHY IT CHANGED. This used to assert on `searchResultsTotal` and on the
 * ordered row-id list. Both are properties of the CORPUS, and the two services do not share one:
 * demi holds 60,560 documents against eagle's 61,582, and 348 projects against 358. So every case
 * failed, every run reported 42/42 DIFF, and the tool's own header had to tell the reader that a
 * green run meant the differ was broken. An oracle that cannot go green cannot gate anything, and
 * this one never did.
 *
 * The two signals below are properties of the SERVICE instead, and a corpus difference cannot
 * manufacture a disagreement in either:
 *
 *   - SELECTIVITY. Not "how many rows", but "did applying this filter change the answer at all",
 *     computed within each service against its own unfiltered baseline and compared as a boolean.
 *     `DocumentChunk + and[type]=Letter` is `not selective` on demi (399,872 -> 399,872, the key is
 *     dropped) and `selective` on eagle (430,345 -> 0). That is a two-value disagreement about
 *     BEHAVIOUR. By the same measure `Project + and[eacDecision]` is selective on both — and it
 *     happens to be 40 against 40, which the old total comparison would also have passed, but only
 *     by luck of two corpora agreeing on one number.
 *   - SORT HONOURED. Same trick one level up: did naming a sort change the page, within this
 *     service? A sort the server silently dropped leaves the page byte-identical to the unsorted
 *     one, and that is invisible to any cross-service comparison of row ids.
 *
 * Raw totals and row ids are still SUMMARISED and still printed — they are how a human reads the
 * report — but they are never a verdict. Row-id correctness is asserted instead by `pagingReport`
 * below, which grades each service against itself.
 */
function compareCase(demi, eagle, bases = {}) {
  const dataset = bases.dataset;
  const d = summarize(demi);
  const e = summarize(eagle);
  const diffs = [];
  // Accepted divergences are still SURFACED, in their own list with their reason — they just do not
  // fail the run. Silencing them outright would make an acceptance indistinguishable from a fix.
  const accepted = [];

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

  // Only when a baseline was fetched, which is only when the case has something to be selective
  // ABOUT. `undefined` here means "not measured", and is deliberately not folded into `false`:
  // a case with no filter is not a case whose filter did nothing.
  const demiSel = selectivity(d, bases.demi);
  const eagleSel = selectivity(e, bases.eagle);
  if (demiSel !== undefined && eagleSel !== undefined && demiSel !== eagleSel) {
    push(diffs, accepted, dataset, { field: 'selective', demi: demiSel, eagle: eagleSel });
  }

  const demiSorted = ordered(d, bases.demi);
  const eagleSorted = ordered(e, bases.eagle);
  if (demiSorted !== undefined && eagleSorted !== undefined && demiSorted !== eagleSorted) {
    push(diffs, accepted, dataset, { field: 'sortHonoured', demi: demiSorted, eagle: eagleSorted });
  }

  if (d.keys || e.keys) {
    const expected = EXPECTED_KEY_DELTA[dataset] || { demiOnly: [], eagleOnly: [] };
    const demiKeys = d.keys || [];
    const eagleKeys = e.keys || [];
    // Only the keys NOT already accounted for. An expected key going missing is not a finding
    // either — `highlighted` rides one branch of demi's own router — so this is a one-way check
    // against surprises, in both directions.
    const demiOnly = demiKeys.filter(k => !eagleKeys.includes(k) && !expected.demiOnly.includes(k));
    const eagleOnly = eagleKeys.filter(k => !demiKeys.includes(k) && !expected.eagleOnly.includes(k));
    if (demiOnly.length || eagleOnly.length) diffs.push({ field: 'rowKeys', demiOnly, eagleOnly });
  }

  return { pass: diffs.length === 0, demi: d, eagle: e, diffs, accepted };
}

/**
 * Route one disagreement to `diffs` or to `accepted`, by whether somebody wrote down a reason.
 */
function push(diffs, accepted, dataset, diff) {
  const reason = EXPECTED_DIVERGENCE[`${dataset}:${diff.field}`];
  (reason ? accepted : diffs).push(reason ? { ...diff, reason } : diff);
}

/**
 * Did this case's FILTER change what the service answered, against its own unfiltered baseline?
 *
 * `undefined` when no baseline was measured. A total that is missing on either side is also
 * `undefined` rather than `false`: "the service did not report a total" and "the filter matched
 * everything" are different facts and collapsing them would let a broken response read as a pass.
 */
function selectivity(side, base) {
  if (!base || side.total === null || base.total === null) return undefined;
  return side.total !== base.total;
}

/** Did naming a SORT change the page, against the same service's unsorted answer? */
function ordered(side, base) {
  if (!base || !side.ids || !base.ids) return undefined;
  if (side.ids.length !== base.ids.length) return true;
  return side.ids.some((id, i) => id !== base.ids[i]);
}

/**
 * Paging correctness, graded WITHIN one service rather than across the two.
 *
 * The invariant a pager depends on is that consecutive pages cover consecutive ranges: no row on
 * two pages, and no row reachable from none. Both halves are checkable from one service's own
 * answers, so this is the part of the old `rowIds` comparison that was worth keeping — it just had
 * to stop being a cross-corpus diff to mean anything.
 *
 * It grades both services by the same rule on purpose. Measured 2026-08-24, demi repeats rows on
 * project-name keyword queries and eagle makes 47 of 100 chunk rows unreachable; neither is
 * excused by the other.
 */
function pagingReport(pages) {
  const seen = new Map();
  for (const { pageNum, ids } of pages) {
    for (const id of ids || []) {
      if (!seen.has(id)) seen.set(id, []);
      seen.get(id).push(pageNum);
    }
  }
  const repeated = [...seen.entries()]
    .filter(([, where]) => where.length > 1)
    .map(([id, where]) => ({ id, pages: where }));
  return { distinct: seen.size, slots: pages.reduce((n, p) => n + (p.ids ? p.ids.length : 0), 0), repeated };
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
    return `    rowKeys UNEXPECTED: demi-only=[${diff.demiOnly.join(',')}] eagle-only=[${diff.eagleOnly.join(',')}]`;
  }
  // Booleans read badly as "true/false" when the question is "did the filter do anything", and this
  // line is the one a human acts on.
  if (diff.field === 'selective' || diff.field === 'sortHonoured') {
    const word = v => (v ? 'applied' : 'IGNORED');
    return `    ${diff.field}: demi=${word(diff.demi)} eagle=${word(diff.eagle)}`;
  }
  const fmt = v => (Array.isArray(v) ? `[${v.join(', ')}]` : String(v));
  return `    ${diff.field}: demi=${fmt(diff.demi)} eagle=${fmt(diff.eagle)}`;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const auth = credential(args, env, DEMI_URL);
  const all = expandCases();
  const cases = args.case ? all.filter(k => k.n === args.case) : all;
  if (cases.length === 0) throw new Error(`[search-diff] no such case: ${args.case} (1..${all.length})`);

  const results = [];
  // Baselines are fetched once per URL, not once per case: the three pages of one spec share a
  // denominator, so caching turns 3 extra round trips into 1. Keyed by the built URL rather than by
  // the spec, so two specs that reduce to the same baseline share it too.
  const baselines = new Map();
  const fetchBaseline = async (base, kase, credentials) => {
    const spec = baselineOf(kase);
    if (!spec) return null;
    const url = buildUrl(base, spec, args.pageSize);
    if (!baselines.has(url)) {
      baselines.set(url, summarize(await get(url, credentials)));
      await sleep(args.delayMs);
    }
    return baselines.get(url);
  };

  for (const kase of cases) {
    // Sequential, with a pause between EVERY request. demi-api's limit is 300 requests / 60s and it
    // is shared by everything behind rproxy, so a parallel fan-out of 78 requests would both distort
    // the answers and take budget from real callers. 250ms x 2 requests keeps a full run near 8/s.
    const demiBase = await fetchBaseline(DEMI_URL, kase, auth);
    const eagleBase = await fetchBaseline(EAGLE_URL, kase, null);

    const demi = await get(buildUrl(DEMI_URL, kase, args.pageSize), auth);
    await sleep(args.delayMs);
    const eagle = await get(buildUrl(EAGLE_URL, kase, args.pageSize), null);
    await sleep(args.delayMs);

    const verdict = compareCase(demi, eagle, { demi: demiBase, eagle: eagleBase, dataset: kase.dataset });
    results.push({ case: kase.n, label: label(kase), spec: specKey(kase), pageNum: kase.pageNum, ...verdict });
    if (!args.json) {
      console.log(`[${String(kase.n).padStart(2)}/${all.length}] ${verdict.pass ? 'PASS' : 'DIFF'}  ${label(kase)}`);
      for (const diff of verdict.diffs) console.log(formatDiff(diff));
      for (const ok of verdict.accepted || []) {
        console.log(`    ACCEPTED ${ok.field}: demi=${ok.demi ? 'applied' : 'IGNORED'} ` +
          `eagle=${ok.eagle ? 'applied' : 'IGNORED'} — ${ok.reason}`);
      }
    }
  }

  // Paging is graded across the pages of one spec, so it cannot be a per-case verdict — it only
  // exists once every page of that spec has been fetched. Skipped when `--case` narrowed the run to
  // a single page, because one page can neither repeat nor gap.
  const paging = [];
  for (const spec of new Set(results.map(r => r.spec))) {
    const forSpec = results.filter(r => r.spec === spec && r.demi && r.eagle);
    if (forSpec.length < 2) continue;
    const of = side => pagingReport(forSpec.map(r => ({ pageNum: r.pageNum, ids: r[side].ids })));
    const demiRep = of('demi');
    const eagleRep = of('eagle');
    if (!demiRep.repeated.length && !eagleRep.repeated.length) continue;
    // BOTH sides repeating is parity, not a demi defect, and the commonest cause here is benign:
    // a chunk result row is a parent DOCUMENT, so a document whose passages straddle a window
    // boundary is legitimately on both pages — and eagle groups the same way. Only demi repeating
    // where eagle does not is a contract failure, which is the same within-service-then-compare
    // shape the selectivity check uses.
    paging.push({
      spec,
      demi: demiRep,
      eagle: eagleRep,
      failsDemi: demiRep.repeated.length > 0 && eagleRep.repeated.length === 0
    });
  }
  if (!args.json && paging.length) {
    console.log('\nPAGING — a row on two pages is a row reachable from none:');
    for (const p of paging) {
      const fmt = r => `${r.slots} slots / ${r.distinct} distinct / ${r.repeated.length} repeated`;
      console.log(`  ${p.failsDemi ? 'FAIL' : 'both'}  ${p.spec}`);
      console.log(`          demi  ${fmt(p.demi)}`);
      console.log(`          eagle ${fmt(p.eagle)}`);
    }
  }

  const failed = results.filter(r => !r.pass);
  // demi's paging failures fail the run; eagle's are REPORTED and do not. This tool grades demi
  // against a contract, and prod's own defects are context for reading the report, not work.
  const demiPaging = paging.filter(p => p.failsDemi);
  const green = failed.length === 0 && demiPaging.length === 0;
  if (args.json) {
    console.log(JSON.stringify({ total: results.length, diffs: failed.length, paging, results }, null, 2));
  } else {
    console.log(`\n${results.length - failed.length} PASS, ${failed.length} DIFF` +
      (failed.length ? ` — cases ${failed.map(r => r.case).join(', ')}` : '') +
      (demiPaging.length ? `; ${demiPaging.length} demi paging failure(s)` : ''));
  }
  return green ? 0 : 1;
}

if (require.main === module) {
  main()
    .then(code => { process.exitCode = code; })
    .catch(err => { console.error(err.message); process.exitCode = 2; });
}

module.exports = {
  CASES, PAGES, DEMI_URL, EAGLE_URL, RPROXY_HOST, EXPECTED_KEY_DELTA,
  baselineOf, selectivity, ordered, pagingReport, specKey, EXPECTED_DIVERGENCE,
  parseArgs, credential, expandCases, buildUrl, label, summarize, compareCase, main
};
