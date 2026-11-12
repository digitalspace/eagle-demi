'use strict';

/**
 * A project's federal decision, parsed from the IAAC registry's HTML: it has no API. Not a crawler: a
 * fixed walk, a request cap, the robots.txt crawl delay; fetch, sleep and the PDF reader are injected.
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { logger } = require('../utils/logger');
const { decodeEntities, withoutControls } = require('../helpers/html-entities');

/** The registry's origin. Every href on a document page is relative to it. */
const REGISTRY_ORIGIN = 'https://iaac-aeic.gc.ca';
const EVALUATIONS = `${REGISTRY_ORIGIN}/050/evaluations`;

/** Who we say we are. The registry has no key and no quota; this is how an operator finds us. */
const USER_AGENT = 'demi-project-summary/1.0';

/** `Crawl-delay: 5` in the host's robots.txt, in milliseconds. */
const CRAWL_DELAY_MS = 5000;

/**
 * Requests to the host per project; a cache hit is not counted. Five is the whole path: search,
 * project page, document list, document page, PDF.
 */
const MAX_REQUESTS = 5;

/** How much text one PDF may yield. Poppler streams; this bounds what we hold. */
const PDF_TEXT_MAX_BYTES = 16 * 1024 * 1024;

/** A CEAR project reference in a registry link: `.../050/evaluations/proj/80105`. */
const PROJ_LINK = /\/proj\/(\d+)/;

/** Markup to the words in it, on one line. Titles carry `<br />` and `<em>`. */
function textOf(html) {
  return withoutControls(decodeEntities(String(html).replace(/<[^>]*>/g, ' '))).replace(/\s+/g, ' ').trim();
}

/** The first capture of `re` in `html`, as text, or `null`. */
function firstText(html, re) {
  const match = re.exec(String(html));
  return match ? textOf(match[1]) : null;
}

/**
 * The CEAR id in a project catalog's `CEAALink`, or null. The field is free text; only a
 * `/proj/<id>` link answers, because every other read here is keyed on that id.
 */
function cearIdFromLink(link) {
  const match = PROJ_LINK.exec(String(link || ''));
  return match ? match[1] : null;
}

/** One `<span class="noctitle">` — the title on both a search result and a document row. */
const NOC_TITLE = /<span class="noctitle">([\s\S]*?)<\/span>/i;

/**
 * The CEAR project a search page names, matched on title: search ranks on full text, so the top hit
 * is often another project's document, and a wrong decision statement is worse than none.
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
 * Every document row on a list page, in registry order; the list is unpaged below 50 rows. A row
 * missing an id or a title is skipped, since a row with a guessed id would be fetched.
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
/**
 * A row filed ABOUT a decision statement: press release, transition notice, media advisory. The
 * registry files these under the same project, with the same words, often on the same day.
 */
const ABOUT_A_DECISION = /\b(?:notice|news release|media|backgrounder|transition)\b/i;
const NEWS_CATEGORY = /news release/i;
/**
 * The statement itself under any qualifier ("Updated Decision Statement"). Other text before it
 * ("Extension of Time Limit for the Issuance of a Decision Statement") marks a document about it.
 */
const IS_THE_STATEMENT =
  /^(?:(?:minister(?:'|\u2019)s|updated|amended|revised|environmental assessment|impact assessment)\s+)*decision statement\b/i;

/** A row's date as a sortable string. An undated row sorts oldest, never newest. */
const rowDate = row => String((row && row.date) || '');

/**
 * The decision statement to summarise, or null: rows about one dropped, the statement by name over a
 * document named after it, then newest. "Updated" wins only when at least as new as the plain one.
 */
function pickDecisionStatement(rows) {
  const candidates = (rows || []).filter(r => r
    && DECISION_STATEMENT.test(String(r.title || ''))
    && !ABOUT_A_DECISION.test(String(r.title || ''))
    && !NEWS_CATEGORY.test(String(r.category || '')));
  const named = candidates.filter(r => IS_THE_STATEMENT.test(String(r.title)));
  const matching = named.length ? named : candidates;
  if (matching.length === 0) return null;

  const newest = matching.slice().sort((a, b) => rowDate(b).localeCompare(rowDate(a)))[0];
  const updated = matching
    .filter(r => UPDATED.test(String(r.title)))
    .sort((a, b) => rowDate(b).localeCompare(rowDate(a)))[0];

  return updated && rowDate(updated) >= rowDate(newest) ? updated : newest;
}

/**
 * The PDF a document page offers, and the heading above it. Neither template quotes the href, so the
 * anchor is found by its target, a PDF under `/050/documents/`: the one part both templates share.
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
 * The GC template around every document page. Its menu carries an `<h2>` ("Registry") ahead of the
 * document's own, so a read that kept it would take the menu for the title.
 */
const FURNITURE = /<(script|style|form|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Where the document stops and the template resumes: the page-details block, or `</main>`. */
const CONTENT_END = /<div\b[^>]*\bid=["']?def-preFooter\b|<\/main\b/i;

/** Tags that end a paragraph. An inline tag — `<em>`, `<abbr>` — does not, so a sentence stays one. */
const BLOCK_BREAK = /<\/(?:p|div|section|h[1-6]|li|ul|ol|tr|table|blockquote|dt|dd|dl)\s*>/gi;

/** About one printed page of a decision statement, in characters. */
const INLINE_PAGE_CHARS = 3000;

/** The least text that can be a decision; below it the page is a stub, not a statement. */
const INLINE_MIN_CHARS = 500;

/**
 * The decision a page prints in its own body: CEAA 2012-era statements have no PDF. Read as markup,
 * not a DOM: the pages are unbalanced and a strict parser would reject them.
 *
 * @returns {{text: string, title: string|null}|null} paragraphs, or null with no main content
 */
function parseInlineContent(html) {
  let markup = String(html).replace(/<!--[\s\S]*?-->/g, ' ').replace(FURNITURE, ' ');
  const end = CONTENT_END.exec(markup);
  if (end) markup = markup.slice(0, end.index);

  // The document's heading is where its content starts: everything above it belongs to the page.
  const heading = /<h2\b[^>]*>/i.exec(markup);
  if (!heading) return null;
  const body = markup.slice(heading.index);

  const paragraphs = body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(BLOCK_BREAK, '\n\n')
    .replace(/<[^>]*>/g, ' ')
    .split(/\n{2,}/)
    .map(part => withoutControls(decodeEntities(part)).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return null;

  return {
    text: paragraphs.join('\n\n'),
    title: firstText(body, /<h2[^>]*>([\s\S]*?)<\/h2>/i)
  };
}

/**
 * Inline text as numbered pages for citations, cut only between paragraphs so no quote straddles a
 * cut. A paragraph longer than a page is its own page.
 *
 * @returns {Array<{page: number, text: string}>}
 */
function inlinePages(text, size = INLINE_PAGE_CHARS) {
  const pages = [];
  let current = '';
  for (const paragraph of String(text).split(/\n{2,}/)) {
    if (current && current.length + paragraph.length + 2 > size) {
      pages.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) pages.push(current);
  return pages.map((page, i) => ({ page: i + 1, text: page }));
}

/**
 * A PDF's pages via `pdftotext -layout`, which keeps condition tables in reading order; form feeds
 * give page numbers. The binary is absent on a Function host, so that answers `{error}`, no throw.
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
        // Poppler ends every page with a form feed. Drop the last empty part by position, so a blank
        // page in the middle keeps its number.
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
 * Fetched pages keyed by URL under the OS temp directory, so a `--section federal` rerun does not
 * spend the request budget and crawl delay again.
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
 * One project's CEAR entry, document list and decision text. Throws on a registry failure; a listed
 * decision that cannot be read still returns, with empty `pages` and `decision.error` set.
 *
 * @param {object} project  a DEMI project row: `name`/`displayName` and, from Track, `CEAALink`
 * @param {object} [opts]
 * @param {Function} [opts.fetch]  test seam; defaults to the global
 * @param {Function} [opts.sleep]  test seam; defaults to a timer
 * @param {Function} [opts.pdfToPages]  test seam; defaults to this module's extractor
 * @returns {Promise<object|null>} the source, or null when the registry has no such project
 */
async function fetchFederalSource(project, opts = {}) {
  const doFetch = opts.fetch || globalThis.fetch;
  const sleep = opts.sleep || timerSleep;
  // Injected like `fetch`: CI runners and Function hosts lack `pdftotext`.
  const extractPages = opts.pdfToPages || pdfToPages;
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
      const err = new Error(`GET ${url} -> ${res ? res.status : 'no response'}`);
      // The status travels with the error: on the decision path the caller names it as a reason
      // rather than losing the whole read.
      err.status = res ? res.status : null;
      throw err;
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

  // A listed decision that cannot be read is not "no decision": the row returns either way, with
  // `decision.error` naming the cause. `format` (PDF or page body) stays null until there is text.
  source.decision = {
    docId: row.docId,
    title: row.title,
    date: row.date || null,
    pdfUrl: null,
    pageUrl: null,
    format: null,
    pages: []
  };
  const unreadable = (error) => {
    source.decision.error = error;
    logger.warn(`[federal-source] CEAR ${cearId} decision statement ${row.docId} ` +
      `could not be read (${error})`, { cearId, docId: row.docId, reason: error });
    return source;
  };
  const fetchFailed = err => `pdf_fetch_failed:${err.status || 'no_response'}`;

  const docUrl = `${EVALUATIONS}/document/${row.docId}`;
  let docHtml;
  try {
    docHtml = await getText(docUrl);
  } catch (err) {
    return unreadable(fetchFailed(err));
  }
  if (docHtml === null) return unreadable('request_budget_spent');
  // The page was read, so it is a place a reader can be sent even when the document behind it
  // could not be: a citation with no PDF still has somewhere to point.
  source.decision.pageUrl = docUrl;

  const link = parsePdfLink(docHtml);
  if (!link) {
    // No file to fetch, because the older statements were never filed as one — the registry prints
    // the decision on this page. Reading it costs no request: the page is already here.
    const inline = parseInlineContent(docHtml);
    if (!inline || inline.text.length < INLINE_MIN_CHARS) return unreadable('no_pdf_link');

    source.decision.title = inline.title || row.title;
    source.decision.format = 'html';
    source.decision.pages = inlinePages(inline.text);
    logger.info(`[federal-source] CEAR ${cearId} decision statement ${row.docId} is inline HTML: ` +
      `${inline.text.length} characters`, {
      cearId, docId: row.docId, pages: source.decision.pages.length, requests: spent
    });
    return source;
  }
  source.decision.pdfUrl = link.pdfUrl;
  source.decision.format = 'pdf';
  source.decision.title = link.title || row.title;

  let pdf;
  try {
    pdf = await get(link.pdfUrl);
  } catch (err) {
    return unreadable(fetchFailed(err));
  }
  if (pdf === null) return unreadable('request_budget_spent');

  const pages = await extractPages(pdf);
  if (!Array.isArray(pages)) return unreadable(pages.error);
  if (!pages.some(page => String(page.text || '').trim())) return unreadable('no_text');

  source.decision.pages = pages;
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
  parseInlineContent,
  inlinePages,
  pdfToPages,
  fetchFederalSource,
  MAX_REQUESTS,
  CRAWL_DELAY_MS,
  USER_AGENT
};
