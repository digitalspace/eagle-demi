'use strict';

/**
 * The federal half of a project's story, read from the Impact Assessment Agency of Canada registry.
 *
 * WHY THIS EXISTS: the `federal` section of a stored summary can only be generated from a federal
 * decision, and DEMI holds five Decision Statements in the whole corpus. The document itself is
 * public on the IAAC registry for every project that had a federal assessment — it is just not in
 * DEMI, and the registry has no API. So this reads the registry's own HTML.
 *
 * WHAT IT IS NOT: a crawler. Every function here is a parser over one page, and the one function
 * that fetches walks a fixed four-step path — project, document list, document, PDF — with a hard
 * request ceiling per project. `robots.txt` allows `/050/evaluations/` with `Crawl-delay: 5`, so
 * requests to the host are spaced by that delay and the run caches what it read: a rerun, or a
 * `--section federal` regeneration, refetches nothing.
 *
 * `fetch` and `sleep` are INJECTED. A test that reaches the registry is a test that fails when
 * Ottawa deploys, so nothing in `test/` touches the network and the fixtures are trimmed copies of
 * the real pages.
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { logger } = require('../utils/logger');

/** The registry's origin. Every href on a document page is relative to it. */
const REGISTRY_ORIGIN = 'https://iaac-aeic.gc.ca';
const EVALUATIONS = `${REGISTRY_ORIGIN}/050/evaluations`;

/** Who we say we are. The registry has no key and no quota; this is how an operator finds us. */
const USER_AGENT = 'demi-project-summary/1.0';

/** `Crawl-delay: 5` in the host's robots.txt, in milliseconds. */
const CRAWL_DELAY_MS = 5000;

/**
 * Requests to the host per project, counting only the ones that actually go out — a cache hit costs
 * nothing and is not counted. Five is the whole path: search (when the catalog has no link),
 * project page, document list, document page, PDF.
 */
const MAX_REQUESTS = 5;

/** How much text one PDF may yield. Poppler streams; this bounds what we hold. */
const PDF_TEXT_MAX_BYTES = 16 * 1024 * 1024;

/** A CEAR project reference in a registry link: `.../050/evaluations/proj/80105`. */
const PROJ_LINK = /\/proj\/(\d+)/;

/** The named entities the registry actually emits, plus the numeric forms. */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–'
};

/** Registry markup is entity-escaped ("Minister&#39;s"), and a title is compared and stored. */
function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/** Markup to the words in it, on one line. Titles carry `<br />` and `<em>`. */
function textOf(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** The first capture of `re` in `html`, as text, or `null`. */
function firstText(html, re) {
  const match = re.exec(String(html));
  return match ? textOf(match[1]) : null;
}

/**
 * The CEAR id in a project catalog's `CEAALink`, or null.
 *
 * The field is free text on a Track-sourced row: it holds a registry link on most projects, an
 * empty string on many, and on a few a link to something else entirely. Only a `/proj/<id>` link
 * answers, because that id is the one every other read here is keyed on.
 */
function cearIdFromLink(link) {
  const match = PROJ_LINK.exec(String(link || ''));
  return match ? match[1] : null;
}

/** One `<span class="noctitle">` — the title on both a search result and a document row. */
const NOC_TITLE = /<span class="noctitle">([\s\S]*?)<\/span>/i;

/**
 * The CEAR project a search page names, matched on title.
 *
 * The registry's search is a relevance ranking over full text, so the top hit is regularly a
 * DOCUMENT of another project that mentions this one. Matching on the title is what keeps a
 * federal decision belonging to a different project out of this project's summary — a wrong
 * decision statement is worse here than none at all.
 *
 * @returns {{cearId: string, title: string, status: string|null}|null}
 */
function parseSearch(html, name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;

  for (const block of String(html).split(/(?=<a class="resultJobItem")/).slice(1)) {
    const cearId = cearIdFromLink(block);
    const title = firstText(block, NOC_TITLE);
    if (!cearId || !title) continue;
    if (!title.toLowerCase().includes(wanted)) continue;
    return { cearId, title, status: firstText(block, /<strong>Status: <\/strong>([^<]*)</i) };
  }
  return null;
}

/** A project page's own words about itself: the assessment's state and the registry's title. */
function parseProjectStatus(html) {
  return {
    status: firstText(html, /<meta name="Status" content="([^"]*)"/i),
    title: firstText(html, /<title>([\s\S]*?)<\/title>/i)
  };
}

/**
 * Every document row on a document list page, in the order the registry printed them.
 *
 * The list is unpaginated below 50 rows and a project's key documents never approach that, so there
 * is no paging to follow. A row missing an id or a title is skipped rather than half-built: every
 * field here is either read from the page or absent, and a row with a guessed id would be fetched.
 *
 * @returns {Array<{docId: string, title: string, date: string|null, category: string|null}>}
 */
function parseDocumentRows(html) {
  const rows = [];
  for (const block of String(html).split(/(?=<a class="wrapper document-wrapper")/).slice(1)) {
    const id = /\/document\/(\d+)/.exec(block);
    const title = firstText(block, NOC_TITLE);
    if (!id || !title) continue;
    rows.push({
      docId: id[1],
      title,
      date: firstText(block, /<strong>Document Date: <\/strong>([^<]*)</i) || null,
      category: firstText(block, /<strong>Document Category: <\/strong>([^<]*)</i) || null
    });
  }
  return rows;
}

const DECISION_STATEMENT = /decision statement/i;
const UPDATED = /\bupdated\b/i;

/** A row's date as a sortable string. An undated row sorts oldest, never newest. */
const rowDate = row => String((row && row.date) || '');

/**
 * The decision statement to summarise, or null.
 *
 * Newest wins. "Updated Decision Statement" is preferred ONLY when it is at least as new as the
 * plain one — Site C's updated statement supersedes the 2014 original, but a registry that files an
 * amendment to an old statement after issuing a newer one would otherwise have the superseded
 * document read as current.
 */
function pickDecisionStatement(rows) {
  const matching = (rows || []).filter(r => r && DECISION_STATEMENT.test(String(r.title || '')));
  if (matching.length === 0) return null;

  const newest = matching.slice().sort((a, b) => rowDate(b).localeCompare(rowDate(a)))[0];
  const updated = matching
    .filter(r => UPDATED.test(String(r.title)))
    .sort((a, b) => rowDate(b).localeCompare(rowDate(a)))[0];

  return updated && rowDate(updated) >= rowDate(newest) ? updated : newest;
}

/**
 * The PDF a document page offers, and the heading above it.
 *
 * The registry renders this anchor two ways — `class="gc-dwnld"` on the newer template,
 * `id="download"` on the older one — and neither quotes the href. So the anchor is found by what it
 * points AT: a PDF under `/050/documents/`. That is the one part of the markup both templates
 * agree on, and the part that would have to change for the link to stop being a link.
 *
 * @returns {{pdfUrl: string, title: string|null}|null}
 */
function parsePdfLink(html) {
  const text = String(html);
  const anchor = /<a\b[^>]*?href=["']?(\/050\/documents\/[^\s"'>]+\.pdf)["']?[^>]*>/i.exec(text);
  if (!anchor) return null;

  // The heading the anchor sits under, which is what the registry calls this document on its own
  // page. The list row's title is the catalog's name for it and the two differ.
  const before = text.slice(0, anchor.index);
  const openedAt = before.lastIndexOf('<h2');
  const heading = openedAt === -1
    ? null
    : firstText(before.slice(openedAt), /<h2[^>]*>([\s\S]*?)<\/h2>/i);

  return { pdfUrl: `${REGISTRY_ORIGIN}${anchor[1]}`, title: heading };
}

/**
 * A PDF's pages as text, through poppler's `pdftotext`.
 *
 * `-layout` because a decision statement's conditions are a numbered table and reading order
 * without it interleaves the columns. Pages are separated by a form feed, which is what makes a
 * page number available at all — and a page number is what a citation needs to be checkable
 * against the registry's own copy.
 *
 * The binary is not a dependency of this package and is absent on a bare Function host, so its
 * absence is an ANSWER, not a throw: the federal section is then simply not generated.
 *
 * @returns {Promise<Array<{page: number, text: string}>|{error: string}>}
 */
function pdfToPages(buffer) {
  return new Promise(resolve => {
    const child = execFile('pdftotext', ['-layout', '-', '-'],
      { encoding: 'buffer', maxBuffer: PDF_TEXT_MAX_BYTES },
      (error, stdout) => {
        if (error && error.code === 'ENOENT') {
          logger.warn('[federal-source] pdftotext is not installed; no federal text can be read');
          return resolve({ error: 'no_pdf_extractor' });
        }
        if (error) return resolve({ error: 'pdf_extract_failed' });

        const text = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || '');
        // Poppler writes a form feed AFTER every page, so the split leaves a trailing empty
        // element. Dropping it by position, not by emptiness: a genuinely blank page in the middle
        // still holds its page number, and the numbers are what citations are checked against.
        const parts = text.split('\f');
        if (parts.length > 1 && parts[parts.length - 1].trim() === '') parts.pop();
        resolve(parts.map((page, i) => ({ page: i + 1, text: page.replace(/\r\n/g, '\n') })));
      });
    child.on('error', () => { /* handled in the callback */ });
    child.stdin.on('error', () => { /* the binary is missing; the callback answers */ });
    child.stdin.end(buffer);
  });
}

/** A URL to a filename that survives a filesystem. */
const cacheKey = url => String(url).replace(/[^a-z0-9]+/gi, '_').slice(-120);

/**
 * The per-run cache: what was fetched, keyed by URL, under the OS temp directory.
 *
 * The point is `--section federal`. Regenerating one section of one project is the normal way this
 * is run, and without a cache each rerun would spend the whole request budget and 20 seconds of
 * crawl delay refetching pages that did not change between two runs a minute apart.
 */
function diskCache(cearId) {
  const dir = path.join(os.tmpdir(), 'demi-iaac', String(cearId || '_search'));
  return {
    read(url) {
      try {
        return fs.readFileSync(path.join(dir, cacheKey(url)));
      } catch {
        return null;
      }
    },
    write(url, buffer) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, cacheKey(url)), buffer);
      } catch (err) {
        // A cache that cannot be written is slower, not wrong.
        logger.info(`[federal-source] could not cache ${url}: ${err.message}`);
      }
    }
  };
}

const timerSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The federal source for one project: its CEAR entry, its document list, and the text of its
 * decision statement when it has one.
 *
 * Throws on a failure that is about the registry rather than about the project — a non-OK response,
 * a page that does not parse. The caller turns that into a section that is null for a stated
 * reason; it must not turn into a summary generated from nothing.
 *
 * @param {object} project  a DEMI project row: `name`/`displayName` and, where Track has one,
 *   `CEAALink`
 * @param {object} [opts]
 * @param {Function} [opts.fetch]  test seam; defaults to the global
 * @param {Function} [opts.sleep]  test seam; defaults to a timer
 * @returns {Promise<object|null>} the source, or null when the registry has no such project
 */
async function fetchFederalSource(project, opts = {}) {
  const doFetch = opts.fetch || globalThis.fetch;
  const sleep = opts.sleep || timerSleep;
  const name = String((project && (project.name || project.displayName)) || '').trim();

  let spent = 0;
  let fetchedOnce = false;
  let cache = diskCache(null);

  /**
   * One GET, inside the budget and behind the crawl delay.
   *
   * @returns {Promise<Buffer|null>} the body, or null when the budget is spent
   */
  const get = async (url) => {
    const cached = cache.read(url);
    if (cached) return cached;
    if (spent >= MAX_REQUESTS) {
      logger.warn(`[federal-source] request budget of ${MAX_REQUESTS} spent; not fetching ${url}`);
      return null;
    }
    // Between requests to the host, never before the first: the delay is a gap, not a preamble.
    if (fetchedOnce) await sleep(CRAWL_DELAY_MS);
    spent += 1;
    fetchedOnce = true;

    const res = await doFetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res || !res.ok) {
      throw new Error(`GET ${url} -> ${res ? res.status : 'no response'}`);
    }
    const body = Buffer.from(await res.arrayBuffer());
    cache.write(url, body);
    return body;
  };

  const getText = async (url) => {
    const body = await get(url);
    return body === null ? null : body.toString('utf8');
  };

  // The catalog's own link first: it is the project's recorded federal counterpart, where a search
  // is a guess ranked by relevance.
  let cearId = cearIdFromLink(project && project.CEAALink);
  let searched = null;
  if (!cearId) {
    if (!name) return null;
    const html = await getText(`${EVALUATIONS}/exploration?search=${encodeURIComponent(name)}`);
    if (html === null) return null;
    searched = parseSearch(html, name);
    if (!searched) {
      logger.info(`[federal-source] the registry search names no project called "${name}"`);
      return null;
    }
    cearId = searched.cearId;
  }
  cache = diskCache(cearId);

  const projectUrl = `${EVALUATIONS}/proj/${cearId}`;
  const projectHtml = await getText(projectUrl);
  const page = projectHtml === null
    ? { status: searched && searched.status, title: searched && searched.title }
    : parseProjectStatus(projectHtml);

  // Key documents first: on a project with 300 filings it is the five that matter, and a decision
  // statement is always one of them. The full list is the fallback for a project that flags none.
  let documents = [];
  const keyHtml = await getText(`${EVALUATIONS}/exploration?projDocs=${cearId}&keyDocs=true`);
  if (keyHtml !== null) documents = parseDocumentRows(keyHtml);
  if (documents.length === 0) {
    const allHtml = await getText(`${EVALUATIONS}/exploration?projDocs=${cearId}`);
    if (allHtml !== null) documents = parseDocumentRows(allHtml);
  }

  const source = {
    status: page.status || null,
    cearId,
    projectUrl,
    decision: null,
    documents
  };

  const row = pickDecisionStatement(documents);
  if (!row) {
    logger.info(`[federal-source] CEAR ${cearId} lists no decision statement`, {
      cearId, documents: documents.length
    });
    return source;
  }

  const docUrl = `${EVALUATIONS}/document/${row.docId}`;
  const docHtml = await getText(docUrl);
  const link = docHtml === null ? null : parsePdfLink(docHtml);
  if (!link) {
    logger.warn(`[federal-source] ${docUrl} offers no PDF; the decision statement cannot be read`);
    return source;
  }

  const pdf = await get(link.pdfUrl);
  if (pdf === null) return source;

  const pages = await pdfToPages(pdf);
  if (!Array.isArray(pages)) {
    logger.warn(`[federal-source] ${link.pdfUrl} yielded no text (${pages.error})`, {
      cearId, docId: row.docId, reason: pages.error
    });
    return source;
  }

  source.decision = {
    docId: row.docId,
    title: link.title || row.title,
    date: row.date || null,
    pdfUrl: link.pdfUrl,
    pages
  };
  logger.info(`[federal-source] CEAR ${cearId} decision statement ${row.docId}: ` +
    `${pages.length} pages`, { cearId, docId: row.docId, pages: pages.length, requests: spent });
  return source;
}

module.exports = {
  cearIdFromLink,
  parseSearch,
  parseProjectStatus,
  parseDocumentRows,
  pickDecisionStatement,
  parsePdfLink,
  pdfToPages,
  fetchFederalSource,
  REGISTRY_ORIGIN,
  MAX_REQUESTS,
  CRAWL_DELAY_MS,
  USER_AGENT
};
