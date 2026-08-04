'use strict';

/**
 * Is the labelled phrase actually IN the stored chunk?
 *
 * Every retrieval hypothesis tested so far has been about the query — label length, page furniture,
 * index coverage, the ` AND ` join. All four were rejected, and recall@10 is still ~0.55. This
 * instruments the link in the middle that nobody has measured: the labels were read out of each
 * source PDF by an INDEPENDENT extractor, so the words are provably on the page; whether they
 * survived into the extraction is unknown.
 *
 * It reads Cosmos, not the search index. `content` is `retrievable: false`, so the search service
 * cannot return chunk text on any plane — only `@search.highlights` fragments come back. Cosmos is
 * the only place the text can be read, which also means this must run INSIDE the app container over
 * the App Service SSH tunnel; see MIGRATION.md for the recipe.
 *
 * Read-only. It opens no writer and touches no index.
 */

const fs = require('fs');

// parseLabels, not a second copy of it: it allows `#` provenance lines, throws on a malformed line
// rather than skipping (a skipped label shrinks the denominator and quietly raises any rate), and
// keeps the 1-based source line so a finding names the line to re-label.
const { parseLabels } = require('./score-retrieval');
const chunks = require('../repositories/chunks');
const { systemAccess } = require('../helpers/access-sql');
const aiSearch = require('../search/ai-search');

const DEFAULTS = { labels: '', scorecard: '', out: '', maxChunks: 4000, pageSize: 1000 };

// Tightest first. The class is the FIRST rung that matches, which is what makes these a partition
// rather than a set of overlapping flags — a phrase that is present verbatim is not also "damaged".
const RUNGS = ['exact', 'whitespace', 'punct', 'despaced'];

// Non-global on purpose. A /g regex carries lastIndex between .test() calls, which makes a
// character-wise loop skip every other match.
const MARK = /\p{M}/u;
const SEPARATOR = /[\s\p{P}\p{S}]/u;

/**
 * One char-wise fold producing both loose rungs and the index maps back to the original.
 *
 * Built in a single pass rather than three regex passes because the report has to SHOW the reader
 * the matched span — a class label on its own is a claim nobody can check — and because the
 * `joined` vs `split` verdict needs to know how many spaces the matched span contained.
 *
 * Mapping every `\p{P}\p{S}` to a space subsumes en-dash-vs-hyphen, curly quotes and ligatures in
 * one rule. NFKD alone does NOT fold `–` to `-`, so a plain normalize() would silently miss those.
 */
function fold(input) {
  const nf = String(input == null ? '' : input).normalize('NFKD');
  const toNf = [];          // despaced index -> index into nf, for the evidence slice
  const spacesBefore = [];  // despaced index -> spaces emitted into `spaced` before this character
  let spaced = '';
  let despaced = '';
  let lastWasSpace = true;  // true, so a leading separator run emits nothing
  let spaces = 0;

  for (let i = 0; i < nf.length; i++) {
    const ch = nf[i];
    if (MARK.test(ch)) continue;              // combining mark left behind by NFKD
    if (SEPARATOR.test(ch)) {
      if (!lastWasSpace) { spaced += ' '; spaces++; lastWasSpace = true; }
      continue;
    }
    toNf.push(i);
    spacesBefore.push(spaces);
    const lower = ch.toLowerCase();
    spaced += lower;
    despaced += lower;
    lastWasSpace = false;
  }

  return { nf, spaced: spaced.trim(), despaced, toNf, spacesBefore };
}

/** Whitespace-and-case only. Deliberately keeps punctuation, so the `punct` rung stays meaningful. */
function loose(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Strictest rung at which `phrase` appears in `text`, or null.
 *
 * Returns the fold and offset too, because the caller needs them to build evidence and to tell
 * word-joining from character-spacing.
 */
function ladder(text, phrase) {
  if (!phrase) return null;

  if (String(text).includes(phrase)) return { rung: 'exact' };
  if (loose(text).includes(loose(phrase))) return { rung: 'whitespace' };

  const hay = fold(text);
  const needle = fold(phrase);
  if (!needle.despaced) return null;

  if (hay.spaced.includes(needle.spaced)) return { rung: 'punct' };

  const at = hay.despaced.indexOf(needle.despaced);
  if (at === -1) return null;
  return { rung: 'despaced', at, hay, needle };
}

/**
 * Which whitespace defect the `despaced` rung caught.
 *
 * The rung is SYMMETRIC: `tovoicemyopposition` and `Tum ble r Ridge` both match it. They are
 * opposite defects with opposite fixes — one is OCR gluing words together, the other is OCR
 * splitting a word apart — so the class alone would be useless. The sign of the space-count
 * difference separates them.
 */
function despacedKind(match) {
  const { at, hay, needle } = match;
  const end = at + needle.despaced.length - 1;
  const spanSpaces = hay.spacesBefore[end] - hay.spacesBefore[at];
  const needleSpaces = (needle.spaced.match(/ /g) || []).length;
  if (spanSpaces < needleSpaces) return 'joined';
  if (spanSpaces > needleSpaces) return 'split';
  return 'other';
}

/** The matched span, sliced out of the NFKD form so a reader can see what actually sits there. */
function evidenceFor(match, pad = 40) {
  const { at, hay, needle } = match;
  const end = at + needle.despaced.length - 1;
  const from = Math.max(0, hay.toNf[at] - pad);
  const to = Math.min(hay.nf.length, hay.toNf[end] + 1 + pad);
  return hay.nf.slice(from, to).replace(/\s+/g, ' ').trim();
}

/**
 * Share of the query's terms present anywhere in the document.
 *
 * A measure, NOT a fifth rung: a partial match is not a kind of presence, it is a description of how
 * absent the phrase is. Matched against the DESPACED document, the most generous haystack there is —
 * `tumbler` is found inside `tumblerridge` — so a low coverage genuinely means the letters are not
 * on the page, which is the only reading that argues for spending GPU hours on re-extraction.
 *
 * Uses the same tokenizer the search uses, so the count is comparable to score-retrieval's.
 */
function tokenCoverage(phrase, despacedDoc) {
  const tokens = [...new Set(aiSearch.tokenize(phrase).map(t => t.toLowerCase()))];
  if (tokens.length === 0) return { coverage: null, missingTokens: [], terms: 0 };
  const missing = tokens.filter(t => !despacedDoc.includes(t));
  return {
    coverage: Math.round(((tokens.length - missing.length) / tokens.length) * 10000) / 10000,
    missingTokens: missing,
    terms: tokens.length
  };
}

/**
 * Classify one label against one document's chunks. Pure — this is the part that can be wrong
 * quietly, so it is the part the tests drive.
 *
 * @param {string} phrase
 * @param {string[]} contents  chunk text, ALREADY sorted into chunkIndex order
 */
function classifyLabel(phrase, contents) {
  if (!contents || contents.length === 0) {
    return { class: 'no-chunks', coverage: null, missingTokens: [], terms: 0 };
  }

  // Per chunk first, and this ordering is the point: AI Search indexes CHUNKS, so a query is only
  // satisfiable inside one of them. A phrase that exists only across a seam is unfindable no matter
  // how good the ranking is, and that is a different defect with a different fix.
  for (const rung of RUNGS) {
    for (let i = 0; i < contents.length; i++) {
      const match = ladder(contents[i], phrase);
      if (match && match.rung === rung) {
        const out = { class: rung, matchedChunk: i };
        if (rung === 'despaced') {
          out.despacedKind = despacedKind(match);
          out.evidence = evidenceFor(match);
        }
        return { ...out, ...coverageOf(phrase, contents) };
      }
    }
  }

  // Chunks are strictly disjoint and were produced by splitting one continuous markdown string, so
  // joining them in chunkIndex order reconstructs source order. That catches a phrase spanning
  // three chunks as cheaply as two, which pairwise adjacency would not.
  const joined = contents.join('\n\n');
  const match = ladder(joined, phrase);
  if (match) {
    const out = { class: `straddle-${match.rung}` };
    if (match.rung === 'despaced') out.despacedKind = despacedKind(match);
    return { ...out, ...coverageOf(phrase, contents) };
  }

  return { class: 'absent', ...coverageOf(phrase, contents) };
}

function coverageOf(phrase, contents) {
  const { coverage, missingTokens, terms } = tokenCoverage(phrase, fold(contents.join(' ')).despaced);
  return { coverage, missingTokens, terms };
}

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--labels') args.labels = String(argv[++i]);
    else if (a === '--scorecard') args.scorecard = String(argv[++i]);
    else if (a === '--out') args.out = String(argv[++i]);
    else if (a === '--max-chunks') args.maxChunks = parseInt(argv[++i], 10);
    else if (a === '--page-size') args.pageSize = parseInt(argv[++i], 10);
    else throw new Error(`[probe-phrase-presence] unknown argument: ${a}`);
  }
  if (!args.labels) throw new Error('[probe-phrase-presence] --labels <file.jsonl> is required');
  if (!Number.isInteger(args.maxChunks) || args.maxChunks < 1) {
    throw new Error('[probe-phrase-presence] --max-chunks must be a positive integer');
  }
  return args;
}

/**
 * Every chunk of one document, in chunkIndex order.
 *
 * Paged DELIBERATELY. `cosmos.query()` calls fetchAll() when maxItemCount is absent, i.e. the whole
 * partition in one call — and under `--max-old-space-size=224` an oversized document gets the
 * process OOM-killed with NO error in the log; it simply vanishes. Truncation is reported instead,
 * because a truncated chunk list reads exactly like "the phrase is absent".
 */
async function loadChunks(documentId, args) {
  const items = [];
  let continuationToken;
  let truncated = false;
  let requestCharge = 0;

  do {
    const page = await chunks.listVisible(systemAccess(), {
      documentId,
      pageSize: args.pageSize,
      continuationToken
    });
    requestCharge += Number(page.requestCharge || 0);
    for (const c of page.items || []) {
      items.push({
        chunkIndex: Number(c.chunkIndex),
        pageNumber: Number(c.pageNumber),
        content: String(c.content || ''),
        extractedAt: c.extractedAt
      });
    }
    continuationToken = page.continuationToken;
    if (items.length >= args.maxChunks) { truncated = true; break; }
  } while (continuationToken);

  // SELECT * returns no order and listVisible sorts nothing. An unsorted join makes the straddle
  // test meaningless NONDETERMINISTICALLY — the one failure mode a re-run cannot reproduce.
  items.sort((a, b) => a.chunkIndex - b.chunkIndex || a.pageNumber - b.pageNumber);
  return { items, truncated, requestCharge };
}

/** Rank per label from a score-retrieval report, so the 2x2 falls out of one file. */
function ranksFrom(scorecardFile) {
  if (!scorecardFile) return { ranks: new Map(), started: null };
  const report = JSON.parse(fs.readFileSync(scorecardFile, 'utf8'));
  const ranks = new Map();
  for (const r of report.results || []) ranks.set(`${r.documentId}|${r.phrase}`, r.rank);
  return { ranks, started: report.started || null };
}

async function probe(argv = []) {
  const args = parseArgs(argv);
  const started = new Date().toISOString();
  const labels = parseLabels(fs.readFileSync(args.labels, 'utf8'));
  const { ranks, started: scorecardStarted } = ranksFrom(args.scorecard);

  const results = [];
  let requestCharge = 0;

  // Serial, same reason as score-retrieval: this is an instrument, not a job.
  for (const label of labels) {
    const loaded = await loadChunks(label.documentId, args);
    requestCharge += loaded.requestCharge;
    const contents = loaded.items.map(c => c.content);
    const verdict = classifyLabel(label.phrase, contents);
    const newestExtractedAt = loaded.items
      .map(c => c.extractedAt).filter(Boolean).sort().slice(-1)[0] || null;

    results.push({
      ...label,
      ...verdict,
      rank: ranks.has(`${label.documentId}|${label.phrase}`)
        ? ranks.get(`${label.documentId}|${label.phrase}`)
        : null,
      chunkCount: loaded.items.length,
      truncated: loaded.truncated,
      newestExtractedAt,
      // The presence test and the retrieval result describe different corpora if the document was
      // re-extracted in between. Reported, not silently paired.
      staleVsScorecard: Boolean(scorecardStarted && newestExtractedAt &&
        newestExtractedAt > scorecardStarted),
      atTermCap: verdict.terms >= 16
    });
  }

  const report = {
    started,
    input: {
      labelsFile: args.labels,
      scorecard: args.scorecard || null,
      maxChunks: args.maxChunks,
      note: 'class = FIRST matching rung, tightest first; straddle-* means the phrase spans a seam'
    },
    byClass: tally(results, r => r.class),
    despacedKinds: tally(results.filter(r => r.despacedKind), r => r.despacedKind),
    // The control half of the 2x2. A retrieval HIT that classes `absent` means the instrument is
    // broken — wrong id, wrong container, truncated paging — and nothing else here can be read.
    crossTab: {
      retrievalHit: tally(results.filter(r => r.rank > 0), r => r.class),
      retrievalMiss: tally(results.filter(r => r.rank === 0), r => r.class),
      rankUnknown: tally(results.filter(r => r.rank === null), r => r.class)
    },
    excluded: {
      noChunks: results.filter(r => r.class === 'no-chunks').map(pick),
      truncated: results.filter(r => r.truncated).map(pick),
      staleVsScorecard: results.filter(r => r.staleVsScorecard).map(pick)
    },
    requestCharge: Math.round(requestCharge * 100) / 100,
    results
  };

  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
    console.log(`[probe-phrase-presence] wrote ${args.out}`);
  }
  return report;
}

function tally(rows, keyOf) {
  const out = {};
  for (const r of rows) { const k = keyOf(r); out[k] = (out[k] || 0) + 1; }
  return out;
}

function pick(r) {
  return { documentId: r.documentId, phrase: r.phrase, line: r.line, class: r.class };
}

if (require.main === module) {
  probe(process.argv.slice(2))
    .then(report => { if (!report.input.out) console.log(JSON.stringify(report.byClass, null, 2)); })
    .catch(err => {
      console.error('[probe-phrase-presence] failed:', err.message);
      process.exit(1);
    });
}

module.exports = { probe, parseArgs, fold, loose, ladder, classifyLabel, tokenCoverage, despacedKind };
