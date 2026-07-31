'use strict';

/**
 * Grade the extracted text already in the corpus. READ-ONLY — this script writes nothing.
 *
 * Why it exists: Deep Search made the text visible for the first time, and some of it is clearly
 * damaged — OCR word-salad, characters spaced apart mid-word, chunks that are nothing but docling
 * `<!-- image -->` placeholders. Extraction is ~7% done, so the question "how bad is it, and which
 * extraction path produced it" has to be answered now, before the other 93% is produced the same
 * way. Writing a cleaner first would be designing against a guess.
 *
 * WHAT THE SCORES ARE FOR. These heuristics stratify the sample and describe artefacts. They are
 * NOT the verdict on quality. The only honest measure of a search corpus is whether a
 * human-visible phrase retrieves its own document. This script picks WHICH documents to labour
 * over by hand; the retrieval run decides whether the text is good.
 *
 * KNOWN BLIND SPOT, measured rather than assumed: character-spacing damage — real corpus text
 * reading `Tum ble r Ridge` and `Ge orge` — scores CLEAN here. Every fragment is pronounceable
 * and none is vowelless, so no cheap metric sees it; catching it needs a dictionary or a bigram
 * model this deliberately does not carry. That artefact is a text-layer defect rather than OCR,
 * and it is exactly the kind of damage only the retrieval test can expose.
 *
 * Deterministic by construction: sampling is seeded, so two runs over an unchanged corpus produce
 * identical JSON and a later run can be diffed against this one. That is the whole point of
 * committing it rather than throwing it away.
 *
 * Cosmos is private-endpoint-only and keyless, so this must run INSIDE the app container over the
 * App Service SSH tunnel — not Kudu's /api/command, whose SCM container has no managed-identity
 * endpoint. See MIGRATION.md for the recipe.
 *
 * Usage:
 *   node src/scripts/audit-chunk-quality.js [--docs 400] [--chunks-per-doc 5]
 *                                           [--sample 40] [--seed 1] [--out report.json]
 */

const documents = require('../repositories/documents');
const chunks = require('../repositories/chunks');
const { systemAccess } = require('../helpers/access-sql');

const DEFAULTS = { docs: 400, chunksPerDoc: 5, sample: 40, seed: 1, out: '' };

// docling emits this for every picture; there is no way to turn it off (image_export_mode admits
// only placeholder/embedded/referenced), so it is stripped or tolerated, never prevented.
const IMAGE_PLACEHOLDER = /<!--\s*image\s*-->/gi;
const VOWEL = /[aeiouy]/i;

/**
 * Seeded PRNG. Math.random() would make two runs incomparable, which defeats the purpose of a
 * before/after scorecard.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Metrics for one chunk of text.
 *
 * Every ratio is over the chunk AFTER placeholders are removed, so a chunk that is half image
 * placeholders is not also scored as having poor letter density — that would count one defect
 * twice and make the thresholds impossible to reason about.
 */
function measure(text) {
  const raw = String(text || '');
  const placeholders = (raw.match(IMAGE_PLACEHOLDER) || []).length;
  const body = raw.replace(IMAGE_PLACEHOLDER, ' ');
  const length = raw.length;

  const letters = (body.match(/[A-Za-z]/g) || []).length;
  const digits = (body.match(/[0-9]/g) || []).length;
  const nonAscii = (body.match(/[^\x20-\x7E\s]/g) || []).length;

  const tokens = body.split(/\s+/).filter(Boolean);
  const shortTokens = tokens.filter(tok => tok.replace(/[^A-Za-z0-9]/g, '').length <= 2);

  // PURELY ALPHABETIC tokens only. Measured against the real corpus: identifiers like `PH12-3-3`
  // and units like `3E-06` are legitimately vowelless, and counting them made a hydrology data
  // table score identically to OCR word-salad (vowelless 0.27 vs 0.24) — the two were
  // indistinguishable on every cheap metric until digits were excluded here.
  const words = tokens
    .map(tok => tok.replace(/[^A-Za-z0-9]/g, ''))
    .filter(tok => tok.length >= 3 && /^[A-Za-z]+$/.test(tok));
  const vowelless = words.filter(w => !VOWEL.test(w));

  // Tabular text is legitimately fragmented and letter-poor. Detected so the fragmentation rules
  // can exempt it rather than reporting a quality crisis made of perfectly good tables.
  //
  // BOTH forms, because the first version only knew pipe tables and duly flagged a table of
  // earthquake records (`56.98  -122.26  1.0  2.2  No  119 km WNW of…`) as OCR debris. Columns
  // separated by whitespace are still columns.
  const lines = body.split('\n').filter(l => l.trim());
  const pipeLines = lines.filter(l => (l.match(/\|/g) || []).length >= 2).length;
  const numericLines = lines.filter(l => (l.match(/(^|\s)-?\d+(\.\d+)?(?=\s|$)/g) || []).length >= 3).length;
  const tabular = lines.length > 0 && (pipeLines + numericLines) / lines.length >= 0.5;

  const denom = Math.max(body.replace(/\s/g, '').length, 1);
  const maxRepeat = (body.match(/(.)\1{3,}/g) || [])
    .reduce((longest, run) => Math.max(longest, run.length), 0);

  // How much of the chunk is separator furniture — dot leaders, rules, form underscores.
  //
  // The LENGTH of the longest run is the wrong measure and produced a 29% garbage rate that was
  // mostly false: a table of contents in a perfectly clean document carries a 100-character dot
  // leader, and a document is not damaged for having one. What matters is whether the chunk is
  // MOSTLY furniture, so this is a share, not a maximum.
  const separatorChars = (body.match(/[.\-_=·•*]{4,}/g) || [])
    .reduce((total, run) => total + run.length, 0);
  const separatorRatio = round(separatorChars / denom);

  return {
    length,
    placeholders,
    // Share of the ORIGINAL chunk that was placeholder markup rather than text.
    placeholderRatio: length ? round((length - body.trim().length) / length) : 0,
    alphaRatio: round(letters / denom),
    digitRatio: round(digits / denom),
    nonAsciiRatio: round(nonAscii / denom),
    tokenCount: tokens.length,
    wordCount: words.length,
    tabular,
    meanTokenLength: tokens.length ? round(tokens.join('').length / tokens.length) : 0,
    shortTokenRatio: tokens.length ? round(shortTokens.length / tokens.length) : 0,
    vowellessRatio: words.length ? round(vowelless.length / words.length) : 0,
    maxRepeatRun: maxRepeat,
    separatorRatio
  };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * Classify a chunk and say WHY.
 *
 * The reasons matter more than the label: "which artefact, how often" is what decides whether the
 * fix belongs in OCR settings, in the chunker, or nowhere. A label alone would collapse three
 * different problems into one number.
 *
 * The digit exemption is deliberate. Tables of measurements are legitimately low on letters and
 * high on digits, and they are perfectly findable content — scoring them as garbage would
 * manufacture a problem and then "fix" real data out of the index.
 */
function classify(m) {
  const reasons = [];

  if (m.placeholderRatio > 0.5) reasons.push('mostly-image-placeholders');
  // The load-bearing signal. Vowelless ALPHABETIC words are what OCR debris is made of, and
  // nothing legitimate produces them in bulk — 0.2 sits between the measured corpus garbage
  // (0.24 after excluding identifiers) and clean prose (0.0).
  if (m.wordCount >= 5 && m.vowellessRatio > 0.2) reasons.push('vowelless-tokens');
  if (m.nonAsciiRatio > 0.15) reasons.push('non-ascii-noise');
  // Furniture AND letter-poor, both. Separator share alone still condemned tables of contents —
  // measured on the corpus, a real TOC page runs separatorRatio 0.40-0.58 while carrying
  // alphaRatio 0.37-0.56, because it is mostly SECTION TITLES with dot leaders between them.
  // Those titles are findable content; the page is not damaged. What is actually junk (a chunk
  // that is nothing but a horizontal rule) has almost no letters at all.
  if (m.separatorRatio > 0.3 && m.alphaRatio < 0.35) reasons.push('mostly-separator-furniture');
  // Both fragmentation rules exempt tables, which are legitimately letter-poor and chopped up.
  if (!m.tabular && m.shortTokenRatio > 0.5) reasons.push('fragmented-tokens');
  if (!m.tabular && m.alphaRatio < 0.5 && m.digitRatio < 0.3) reasons.push('low-letter-density');

  if (reasons.length > 0) return { verdict: 'garbage', reasons };

  if (m.placeholderRatio > 0.2) reasons.push('some-image-placeholders');
  if (m.separatorRatio > 0.1) reasons.push('some-separator-furniture');
  if (m.wordCount >= 5 && m.vowellessRatio > 0.1) reasons.push('some-vowelless-tokens');
  if (!m.tabular && m.shortTokenRatio > 0.35) reasons.push('some-fragmented-tokens');
  if (!m.tabular && m.meanTokenLength > 0 && m.meanTokenLength < 3) {
    reasons.push('very-short-tokens');
  }

  if (reasons.length > 0) return { verdict: 'marginal', reasons };
  return { verdict: 'clean', reasons };
}

function scoreChunk(text) {
  const metrics = measure(text);
  return { ...classify(metrics), metrics };
}

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--docs') args.docs = parseInt(argv[++i], 10);
    else if (a === '--chunks-per-doc') args.chunksPerDoc = parseInt(argv[++i], 10);
    else if (a === '--sample') args.sample = parseInt(argv[++i], 10);
    else if (a === '--seed') args.seed = parseInt(argv[++i], 10);
    else if (a === '--out') args.out = String(argv[++i]);
    else throw new Error(`[audit] unknown argument: ${a}`);
  }
  return args;
}

/** Documents that claim to have been extracted, up to a bounded scan budget. */
async function collectDocuments(limit) {
  const collected = [];
  let continuationToken;

  do {
    const page = await documents.listVisible(systemAccess(), {
      extracted: true,
      pageSize: Math.min(200, limit - collected.length),
      continuationToken
    });
    for (const doc of page.items || []) {
      collected.push({
        id: String(doc.id),
        projectId: String(doc.projectId),
        displayName: doc.displayName || doc.documentFileName || '(untitled)',
        // Absent on everything extracted before provenance existed — which is most of the corpus,
        // and is itself a finding rather than a gap to paper over.
        extraction: doc.extraction || null,
        contentPageCount: doc.contentPageCount
      });
      if (collected.length >= limit) break;
    }
    continuationToken = page.continuationToken;
  } while (continuationToken && collected.length < limit);

  return collected;
}

async function scoreDocument(doc, chunksPerDoc) {
  const { items } = await chunks.listVisible(systemAccess(), {
    documentId: doc.id,
    pageSize: chunksPerDoc
  });

  const scored = items.slice(0, chunksPerDoc).map(chunk => scoreChunk(chunk.content));
  const counts = { clean: 0, marginal: 0, garbage: 0 };
  const reasons = {};
  for (const s of scored) {
    counts[s.verdict]++;
    for (const r of s.reasons) reasons[r] = (reasons[r] || 0) + 1;
  }

  // A document's score is its WORST-weighted share, not its average: one clean chunk in a
  // document of debris does not make the document findable.
  const sampled = scored.length || 1;
  return {
    id: doc.id,
    projectId: doc.projectId,
    displayName: doc.displayName,
    extraction: doc.extraction,
    chunksSampled: scored.length,
    counts,
    reasons,
    garbageShare: round(counts.garbage / sampled),
    usableShare: round(counts.clean / sampled)
  };
}

/**
 * @param {string[]} argv  CLI-style arguments, so the SSH wrapper and the CLI share one entry
 *                         point. See MIGRATION.md — a standalone script in the app container
 *                         needs /proc/1/environ and a crypto shim, which the wrapper supplies.
 */
async function audit(argv = []) {
  const args = parseArgs(argv);
  const started = new Date().toISOString();

  const docs = await collectDocuments(args.docs);
  const scoredDocs = [];
  for (const doc of docs) {
    try {
      scoredDocs.push(await scoreDocument(doc, args.chunksPerDoc));
    } catch (err) {
      console.error(`[audit] ${doc.id}: ${err.message}`);
    }
  }

  // Two strata, never merged. The random one estimates how bad the corpus is; the worst one
  // describes what "bad" looks like. One blended number would answer neither question.
  const rand = mulberry32(args.seed);
  const shuffled = scoredDocs
    .map(d => ({ d, k: rand() }))
    .sort((a, b) => a.k - b.k)
    .map(x => x.d);
  const randomStratum = shuffled.slice(0, args.sample);

  const worstStratum = [...scoredDocs]
    .sort((a, b) => b.garbageShare - a.garbageShare || a.id.localeCompare(b.id))
    .slice(0, args.sample);

  const totals = { clean: 0, marginal: 0, garbage: 0 };
  const reasonTotals = {};
  let withProvenance = 0;
  for (const d of scoredDocs) {
    for (const k of Object.keys(totals)) totals[k] += d.counts[k];
    for (const [r, n] of Object.entries(d.reasons)) reasonTotals[r] = (reasonTotals[r] || 0) + n;
    if (d.extraction) withProvenance++;
  }
  const chunksScored = totals.clean + totals.marginal + totals.garbage;

  const report = {
    started,
    // Stated in the output, because a scorecard without its sampling method is not evidence.
    sampling: {
      documentsScanned: scoredDocs.length,
      chunksPerDocument: args.chunksPerDoc,
      chunksScored,
      stratumSize: args.sample,
      seed: args.seed,
      note: 'worst stratum is the worst N of documentsScanned, not of the whole corpus'
    },
    provenance: {
      documentsWithExtractionField: withProvenance,
      documentsWithout: scoredDocs.length - withProvenance,
      note: 'absent means extracted before provenance existed; path is unknown, not "text"'
    },
    chunkVerdicts: totals,
    chunkVerdictShare: chunksScored
      ? {
        clean: round(totals.clean / chunksScored),
        marginal: round(totals.marginal / chunksScored),
        garbage: round(totals.garbage / chunksScored)
      }
      : null,
    artefactFrequency: reasonTotals,
    randomStratum,
    worstStratum
  };

  if (args.out) {
    require('fs').writeFileSync(args.out, JSON.stringify(report, null, 2));
    console.log(`[audit] wrote ${args.out}`);
  }
  return report;
}

if (require.main === module) {
  audit(process.argv.slice(2))
    .then(report => { if (!report.sampling.out) console.log(JSON.stringify(report, null, 2)); })
    .catch(err => {
      console.error('[audit] failed:', err);
      process.exit(1);
    });
}

module.exports = { audit, scoreChunk, measure, classify, mulberry32 };
