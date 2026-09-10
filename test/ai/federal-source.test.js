'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  cearIdFromLink, parseSearch, parseProjectStatus, parseDocumentRows, pickDecisionStatement,
  parsePdfLink, parseInlineContent, inlinePages, pdfToPages, fetchFederalSource, MAX_REQUESTS,
  CRAWL_DELAY_MS, USER_AGENT
} = require('../../src/ai/federal-source');

/**
 * Trimmed copies of the registry's own pages, captured 2026-09-10.
 *
 * Trimmed, not written: the markup, the entity escaping and the unquoted `href` are the registry's,
 * because those are exactly what the parsers have to survive. What was removed is boilerplate — the
 * GC template chrome, the stylesheets, and the free-text snippet each result carries.
 */
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'iaac');
const fixture = name => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const TILBURY = 'Tilbury Marine Jetty Project';

/** Whether poppler is installed here. It is not on a CI runner, and not on a Function host. */
function hasPdftotext() {
  return !spawnSync('pdftotext', ['-v']).error;
}
const needsPoppler = hasPdftotext() ? false : 'pdftotext is not installed on this host';

/** A one-page PDF with nothing on the page — what a statement filed as a scan reads like. */
const BLANK_PDF = Buffer.from([
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj',
  'trailer<</Root 1 0 R>>'
].join('\n'), 'utf8');

/** The decision statement PDF the walk fetches: two pages, one line of text on each. */
const TWO_PAGE_PDF = fs.readFileSync(path.join(FIXTURES, 'two-page.pdf'));

/**
 * The extractor as a stub, for every test about the WALK rather than about extraction.
 *
 * A runner without poppler answered `no_pdf_extractor` to all of them, which asserted what the
 * host has installed instead of what the walk does with the pages it gets back. The text below is
 * what `pdftotext -layout` reads out of these two fixtures; the gated tests over the real binary
 * are what keep that claim honest.
 */
const stubPdfToPages = async (buffer) => {
  if (buffer.equals(BLANK_PDF)) return [{ page: 1, text: '\n' }];
  if (buffer.equals(TWO_PAGE_PDF)) {
    return [
      { page: 1, text: 'Decision Statement page one\n' },
      { page: 2, text: 'Condition 3.1 page two\n' }
    ];
  }
  return { error: 'pdf_extract_failed' };
};

test('cearIdFromLink', async (t) => {
  await t.test('reads the CEAR id out of a catalog link', () => {
    assert.strictEqual(
      cearIdFromLink('https://iaac-aeic.gc.ca/050/evaluations/proj/80105'), '80105');
  });

  await t.test('answers null for a link that is not a project link', () => {
    // `CEAALink` is free text on a Track-sourced row. A link to the registry's home page, or to a
    // document, is not a project id, and guessing one would read another project's decision.
    assert.strictEqual(cearIdFromLink('https://iaac-aeic.gc.ca/050/evaluations/document/157936'),
      null);
    assert.strictEqual(cearIdFromLink('https://www.ceaa-acee.gc.ca/'), null);
    assert.strictEqual(cearIdFromLink(''), null);
    assert.strictEqual(cearIdFromLink(null), null);
  });
});

test('parseSearch', async (t) => {
  await t.test('names the project whose title matches', () => {
    assert.deepStrictEqual(parseSearch(fixture('search-tilbury.html'), TILBURY), {
      cearId: '80105',
      title: 'Tilbury Marine Jetty Project',
      status: 'Completed'
    });
  });

  await t.test('matches case-insensitively', () => {
    const found = parseSearch(fixture('search-tilbury.html'), 'tilbury marine jetty');
    assert.strictEqual(found.cearId, '80105');
  });

  await t.test('skips a higher-ranked result whose title is a different project', () => {
    // The registry ranks on full text, so a project that merely MENTIONS this one outranks it
    // regularly. The decoy below is the real result block with its id and title swapped, so the
    // markup is the registry's and only the values differ.
    const real = fixture('search-tilbury.html');
    const decoy = real
      .slice(real.indexOf('<a class="resultJobItem"'))
      .replace('/proj/80105', '/proj/99999')
      .replace('>Tilbury Marine Jetty Project<', '>Fraser River Crossing Project<');
    const found = parseSearch(real.replace('<article>', `<article>${decoy}</article><article>`),
      TILBURY);
    assert.strictEqual(found.cearId, '80105', 'the title decides, not the ranking');
  });

  await t.test('answers null when nothing on the page is this project', () => {
    assert.strictEqual(parseSearch(fixture('search-tilbury.html'), 'Site C Clean Energy'), null);
    assert.strictEqual(parseSearch(fixture('search-tilbury.html'), ''), null);
  });
});

test('parseProjectStatus', async (t) => {
  await t.test('reads the assessment state and the registry title', () => {
    assert.deepStrictEqual(parseProjectStatus(fixture('proj-80105.html')), {
      status: 'Completed',
      title: 'Tilbury Marine Jetty Project'
    });
  });

  await t.test('answers nulls for a page that carries neither', () => {
    assert.deepStrictEqual(parseProjectStatus('<html><body>nothing</body></html>'),
      { status: null, title: null });
  });

  await t.test('decodes every entity the registry escapes', () => {
    // A title is stored, shown and matched against /decision statement/i, so an entity left
    // encoded is a title a reader sees raw and a pattern that stops matching.
    const decoded = markup => parseProjectStatus(`<title>${markup}</title>`).title;
    assert.strictEqual(decoded('Deep &amp; Wide'), 'Deep & Wide');
    assert.strictEqual(decoded('&lt;Phase&gt;'), '<Phase>');
    assert.strictEqual(decoded('&quot;Phase 2&quot;'), '"Phase 2"');
    assert.strictEqual(decoded('Minister&apos;s'), "Minister's");
    assert.strictEqual(decoded('Site C&mdash;Stage 2'), 'Site C—Stage 2');
    assert.strictEqual(decoded('2014&ndash;2024'), '2014–2024');
    assert.strictEqual(decoded('Tilbury&nbsp;Marine'), 'Tilbury Marine');
    assert.strictEqual(decoded('Minister&#39;s'), "Minister's");
    assert.strictEqual(decoded('Minister&#x27;s'), "Minister's");
    // Accents come by name on this bilingual registry, and a Nation's name is not a place to
    // lose one. Case is the letter's own: `&Eacute;` is not `&eacute;`.
    assert.strictEqual(decoded('Caf&eacute; Project'), 'Café Project');
    assert.strictEqual(decoded('Secw&eacute;pemc &amp; Stk&#39;eml&uacute;psemc'),
      "Secwépemc & Stk'emlúpsemc");
    assert.strictEqual(decoded('&Eacute;nergie Saguenay'), 'Énergie Saguenay');
    // Not in the table: written through as it stands, never dropped or turned into "undefined".
    assert.strictEqual(decoded('Phase 2&hellip;'), 'Phase 2&hellip;');
  });
});

test('parseDocumentRows', async (t) => {
  await t.test('reads every row of a key-documents list', () => {
    const rows = parseDocumentRows(fixture('docs-80105-key.html'));
    assert.strictEqual(rows.length, 5);
    assert.deepStrictEqual(rows[0], {
      docId: '158078',
      // The registry writes `Minister&#39;s`; a stored title and a title compared against
      // /decision statement/i both need the apostrophe back.
      title: "Minister's Environmental Assessment Decision Statement",
      date: '2024-07-03',
      category: 'Additional Information'
    });
    assert.deepStrictEqual(rows.map(r => r.docId),
      ['158078', '157942', '129572', '132376', '132377']);
  });

  await t.test('reads a list whose rows are all something else', () => {
    const rows = parseDocumentRows(fixture('docs-brucec-key.html'));
    assert.strictEqual(rows.length, 20);
    assert.deepStrictEqual(rows[0], {
      docId: '165368',
      title: 'Plant Parameter Envelope Plain Language Summary',
      date: '2026-03-09',
      category: 'Additional Information'
    });
  });

  await t.test('answers an empty list for a page with no rows', () => {
    assert.deepStrictEqual(parseDocumentRows('<html><body>No results</body></html>'), []);
  });
});

test('pickDecisionStatement', async (t) => {
  const row = (docId, title, date) => ({ docId, title, date, category: 'Additional Information' });

  await t.test('finds the decision statement in a real key-documents list', () => {
    const picked = pickDecisionStatement(parseDocumentRows(fixture('docs-80105-key.html')));
    assert.strictEqual(picked.docId, '158078');
    assert.strictEqual(picked.date, '2024-07-03');
  });

  await t.test('answers null when the registry lists none', () => {
    assert.strictEqual(
      pickDecisionStatement(parseDocumentRows(fixture('docs-brucec-key.html'))), null);
    assert.strictEqual(pickDecisionStatement([]), null);
    assert.strictEqual(pickDecisionStatement(null), null);
  });

  await t.test('newest wins among plain decision statements', () => {
    const picked = pickDecisionStatement([
      row('1', 'Decision Statement', '2014-10-14'),
      row('2', 'Decision Statement', '2019-02-01'),
      row('3', 'Assessment Report', '2026-01-01')
    ]);
    assert.strictEqual(picked.docId, '2');
  });

  await t.test('prefers an updated statement when it is newer', () => {
    const picked = pickDecisionStatement([
      row('1', 'Decision Statement', '2014-10-14'),
      row('2', 'Updated Decision Statement', '2021-11-05')
    ]);
    assert.strictEqual(picked.docId, '2');
  });

  await t.test('prefers an updated statement filed the same day as the newest', () => {
    // The equal-date case: an update filed the day a statement was issued supersedes it, so the
    // tiebreak has to go to the update rather than to the plain row.
    const picked = pickDecisionStatement([
      row('1', 'Decision Statement', '2024-07-03'),
      row('2', 'Updated Decision Statement', '2024-07-03')
    ]);
    assert.strictEqual(picked.docId, '2');
  });

  await t.test('leaves a superseded updated statement behind', () => {
    // An update filed against an older statement does not outrank a decision issued after it.
    const picked = pickDecisionStatement([
      row('1', 'Updated Decision Statement', '2016-03-02'),
      row('2', "Minister's Environmental Assessment Decision Statement", '2024-07-03')
    ]);
    assert.strictEqual(picked.docId, '2');
  });
});

test('parsePdfLink', async (t) => {
  await t.test('reads the older unquoted `id="download"` anchor', () => {
    assert.deepStrictEqual(parsePdfLink(fixture('doc-157936.html')), {
      pdfUrl: 'https://iaac-aeic.gc.ca/050/documents/p80105/157936E.pdf',
      title: 'Decision Statement Issued under Section 54 of the ' +
        'Canadian Environmental Assessment Act, 2012'
    });
  });

  await t.test('reads the newer `class="gc-dwnld"` anchor', () => {
    // Two templates, two anchors, one parser: a page rendered either way still yields the file.
    assert.deepStrictEqual(parsePdfLink(fixture('doc-164236.html')), {
      pdfUrl: 'https://iaac-aeic.gc.ca/050/documents/p63919/164236E.pdf',
      title: 'Updated Decision Statement'
    });
  });

  await t.test('answers null for a page that offers no PDF', () => {
    assert.strictEqual(parsePdfLink('<html><body><h2>Decision</h2><p>HTML only</p></body></html>'),
      null);
  });
});

test('parseInlineContent', async (t) => {
  await t.test('reads the decision the page prints instead of linking', () => {
    const content = parseInlineContent(fixture('doc-121216.html'));

    assert.strictEqual(content.title, 'Environmental Assessment Decision Statement ' +
      'Ajax Mine Project, British Columbia');
    assert.match(content.text, /^Environmental Assessment Decision Statement/);
    assert.match(content.text, /The Honourable Catherine McKenna, Minister of Environment/);
    // A list item is a paragraph of its own: the Minister's findings are the decision.
    assert.match(content.text, /the Project is likely to result in significant adverse/);
    // Registry markup is entity-escaped, and a Nation's name is not a place to lose accents.
    assert.match(content.text, /Stk'emlúpsemc te Secwépemc Nation/);
    assert.ok(content.text.split(/\n{2,}/).length >= 5,
      `the paragraph breaks are what the pages are cut on: ${JSON.stringify(content.text)}`);
  });

  await t.test('keeps the template out of the decision', () => {
    const text = parseInlineContent(fixture('doc-121216.html')).text;

    // The registry menu carries its own `<h2>` ahead of the document's, the search form carries a
    // placeholder, the stylesheet carries CSS, and the page footer carries a date. None of it is
    // Canada's decision, and all of it would be quoted back as if it were.
    for (const furniture of [/Registry/, /Search by keyword/, /overflow-wrap/,
      /Report a problem/, /Date modified/]) {
      assert.doesNotMatch(text, furniture);
    }
  });

  await t.test('answers null for a page with no document heading', () => {
    assert.strictEqual(parseInlineContent('<html><body><p>No heading here</p></body></html>'),
      null);
  });
});

test('inlinePages', async (t) => {
  const paragraph = n => `${n} `.repeat(50).trim();

  await t.test('numbers the pages it cuts from 1', () => {
    const pages = inlinePages([paragraph(1), paragraph(2), paragraph(3)].join('\n\n'), 150);
    assert.deepStrictEqual(pages.map(p => p.page), [1, 2, 3]);
  });

  await t.test('cuts at a paragraph boundary, never inside one', () => {
    // A citation carries a page number and a quote. A cut inside a paragraph would produce a page
    // that holds half a sentence, so the quote a reader checks would be on no page at all.
    const text = [paragraph(1), paragraph(2), paragraph(3), paragraph(4)].join('\n\n');
    const pages = inlinePages(text, 400);

    assert.ok(pages.length > 1, 'four paragraphs do not fit on one 400-character page');
    for (const page of pages) {
      for (const part of page.text.split(/\n{2,}/)) {
        assert.ok(text.includes(part), `a whole paragraph, not a piece of one: ${part}`);
        assert.match(part, /^(\d) (?:\1 )*\1$/, `unbroken: ${part}`);
      }
    }
    assert.strictEqual(pages.map(p => p.text).join('\n\n'), text, 'and nothing is dropped');
  });

  await t.test('gives a paragraph longer than a page its own page', () => {
    const pages = inlinePages(paragraph(1), 50);
    assert.deepStrictEqual(pages, [{ page: 1, text: paragraph(1) }]);
  });
});

test('pdfToPages', async (t) => {
  await t.test('splits a PDF into numbered pages', { skip: needsPoppler }, async () => {
    const pages = await pdfToPages(TWO_PAGE_PDF);
    assert.ok(Array.isArray(pages), `expected pages, got ${JSON.stringify(pages)}`);
    // Two pages, not three: poppler writes a form feed AFTER the last page as well.
    assert.strictEqual(pages.length, 2);
    assert.deepStrictEqual(pages.map(p => p.page), [1, 2]);
    assert.match(pages[0].text, /Decision Statement page one/);
    assert.match(pages[1].text, /Condition 3\.1 page two/);
  });

  await t.test('answers `no_pdf_extractor` when poppler is not installed', async () => {
    // A bare Function host has no poppler. The absence is an answer — the federal section is not
    // generated — and never a throw that loses the rest of the record.
    const realPath = process.env.PATH;
    process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'no-poppler-'));
    try {
      assert.deepStrictEqual(await pdfToPages(TWO_PAGE_PDF), { error: 'no_pdf_extractor' });
    } finally {
      process.env.PATH = realPath;
    }
  });

  await t.test('answers `pdf_extract_failed` for something that is not a PDF',
    { skip: needsPoppler }, async () => {
      assert.deepStrictEqual(await pdfToPages(Buffer.from('not a pdf')),
        { error: 'pdf_extract_failed' });
    });
});

test('fetchFederalSource', async (t) => {
  /** A fresh temp root per test, so one test's cache cannot answer the next one's request. */
  let tmpdir;
  const realTmpdir = process.env.TMPDIR;
  t.beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'federal-source-'));
    process.env.TMPDIR = tmpdir;
  });
  t.afterEach(() => {
    if (realTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = realTmpdir;
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  /**
   * The registry, as files. Records every request so a test can assert the path walked, the headers
   * sent and the number of requests spent.
   *
   * `document/158078` is served the page captured under `document/157936`: the registry files this
   * one decision statement under both ids, and 157936 is the id whose page was captured. What the
   * stub proves is the walk and the budget, not which id the registry chose.
   */
  const registry = (routes) => {
    const calls = [];
    const sleeps = [];
    const stub = {
      calls,
      sleeps,
      fetch: async (url, init) => {
        calls.push({ url: String(url), headers: (init && init.headers) || {} });
        const hit = Object.keys(routes).find(key => String(url).includes(key));
        if (!hit) return { ok: false, status: 404, arrayBuffer: async () => Buffer.alloc(0) };
        const body = routes[hit];
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'))
        };
      },
      sleep: async ms => { sleeps.push(ms); },
      pdfToPages: stubPdfToPages
    };
    return stub;
  };

  const FULL = () => ({
    'exploration?search=': fixture('search-tilbury.html'),
    'proj/80105': fixture('proj-80105.html'),
    'projDocs=80105&keyDocs=true': fixture('docs-80105-key.html'),
    'document/158078': fixture('doc-157936.html'),
    '157936E.pdf': TWO_PAGE_PDF
  });

  await t.test('walks the registry from a catalog link and returns the decision', async () => {
    const stub = registry(FULL());
    const source = await fetchFederalSource(
      { name: TILBURY, CEAALink: 'https://iaac-aeic.gc.ca/050/evaluations/proj/80105' }, stub);

    assert.strictEqual(source.cearId, '80105');
    assert.strictEqual(source.status, 'Completed');
    assert.strictEqual(source.projectUrl, 'https://iaac-aeic.gc.ca/050/evaluations/proj/80105');
    assert.strictEqual(source.documents.length, 5);
    assert.deepStrictEqual(
      { ...source.decision, pages: source.decision.pages.length },
      {
        docId: '158078',
        title: 'Decision Statement Issued under Section 54 of the ' +
          'Canadian Environmental Assessment Act, 2012',
        date: '2024-07-03',
        pdfUrl: 'https://iaac-aeic.gc.ca/050/documents/p80105/157936E.pdf',
        pageUrl: 'https://iaac-aeic.gc.ca/050/evaluations/document/158078',
        format: 'pdf',
        pages: 2
      });

    // The catalog link is what makes the search unnecessary, so four requests, not five.
    assert.deepStrictEqual(stub.calls.map(c => c.url), [
      'https://iaac-aeic.gc.ca/050/evaluations/proj/80105',
      'https://iaac-aeic.gc.ca/050/evaluations/exploration?projDocs=80105&keyDocs=true',
      'https://iaac-aeic.gc.ca/050/evaluations/document/158078',
      'https://iaac-aeic.gc.ca/050/documents/p80105/157936E.pdf'
    ]);
  });

  await t.test('identifies itself and waits the crawl delay between requests', async () => {
    const stub = registry(FULL());
    await fetchFederalSource({ name: TILBURY, CEAALink: '/050/evaluations/proj/80105' }, stub);

    for (const call of stub.calls) {
      assert.strictEqual(call.headers['User-Agent'], USER_AGENT);
    }
    // A gap between requests, not a pause before the first: four requests, three waits.
    assert.deepStrictEqual(stub.sleeps,
      [CRAWL_DELAY_MS, CRAWL_DELAY_MS, CRAWL_DELAY_MS],
      `robots.txt asks for ${CRAWL_DELAY_MS}ms between requests to this host`);
  });

  await t.test('searches for the project when the catalog holds no link', async () => {
    const stub = registry(FULL());
    const source = await fetchFederalSource({ name: TILBURY, CEAALink: '' }, stub);

    assert.strictEqual(source.cearId, '80105');
    assert.strictEqual(source.decision.docId, '158078');
    assert.match(stub.calls[0].url, /exploration\?search=Tilbury/);
    assert.strictEqual(stub.calls.length, 5, 'the search is the fifth request, not a sixth');
  });

  await t.test('never spends more than the request budget', async () => {
    // Worst case: no catalog link, and a key-documents list that comes back empty so the full list
    // has to be tried too. That is six steps of work and five requests of budget.
    const routes = FULL();
    routes['projDocs=80105&keyDocs=true'] = '<html><body>No results</body></html>';
    routes['projDocs=80105'] = fixture('docs-80105-key.html');
    const stub = registry(routes);
    const source = await fetchFederalSource({ name: TILBURY }, stub);

    assert.strictEqual(stub.calls.length, MAX_REQUESTS);
    assert.strictEqual(source.documents.length, 5, 'the fallback list was still read');
    assert.deepStrictEqual(source.decision, {
      docId: '158078',
      title: 'Decision Statement Issued under Section 54 of the ' +
        'Canadian Environmental Assessment Act, 2012',
      date: '2024-07-03',
      pdfUrl: 'https://iaac-aeic.gc.ca/050/documents/p80105/157936E.pdf',
      pageUrl: 'https://iaac-aeic.gc.ca/050/evaluations/document/158078',
      format: 'pdf',
      pages: [],
      error: 'request_budget_spent'
    }, 'the registry listed a decision; the budget is why the PDF was not read');
  });

  await t.test('caches what it read, so a rerun fetches nothing', async () => {
    const first = registry(FULL());
    const link = 'https://iaac-aeic.gc.ca/050/evaluations/proj/80105';
    await fetchFederalSource({ name: TILBURY, CEAALink: link }, first);
    assert.strictEqual(first.calls.length, 4);

    // The same temp root, which is what `--section federal` regenerating one project sees.
    const again = registry(FULL());
    const source = await fetchFederalSource({ name: TILBURY, CEAALink: link }, again);
    assert.strictEqual(again.calls.length, 0);
    assert.deepStrictEqual(again.sleeps, []);
    assert.strictEqual(source.decision.docId, '158078');
  });

  await t.test('answers null when the registry knows no such project', async () => {
    const stub = registry({ 'exploration?search=': fixture('search-tilbury.html') });
    assert.strictEqual(await fetchFederalSource({ name: 'Sunshine Coast Gravel Pit' }, stub), null);
    assert.strictEqual(await fetchFederalSource({ name: '' }, stub), null);
  });

  // A decision statement the registry LISTS and this code could not read. Each cause below returns
  // the row with empty pages and names itself, because the caller stores "we could not read it"
  // and "Canada issued no decision" as different things and can only tell them apart here.
  const unread = async (routes, over = {}, opts = {}) => {
    const source = await fetchFederalSource(
      { name: TILBURY, CEAALink: '/050/evaluations/proj/80105' },
      { ...registry(routes), ...opts });
    assert.strictEqual(source.cearId, '80105', 'the rest of the read still stands');
    assert.deepStrictEqual(source.decision, {
      docId: '158078',
      title: "Minister's Environmental Assessment Decision Statement",
      date: '2024-07-03',
      pdfUrl: null,
      pageUrl: 'https://iaac-aeic.gc.ca/050/evaluations/document/158078',
      format: null,
      pages: [],
      ...over
    });
    return source;
  };

  await t.test('reads a decision the registry prints on the page itself', async () => {
    // The CEAA 2012 statements — Ajax Mine and three others in this corpus — have no PDF at all.
    // The page is the statement, so the walk reads it and stops there: no file to fetch.
    const routes = FULL();
    routes['document/158078'] = fixture('doc-121216.html');
    delete routes['157936E.pdf'];
    const stub = registry(routes);
    const source = await fetchFederalSource(
      { name: TILBURY, CEAALink: '/050/evaluations/proj/80105' }, stub);

    const { pages, ...decision } = source.decision;
    assert.deepStrictEqual(decision, {
      docId: '158078',
      title: 'Environmental Assessment Decision Statement ' +
        'Ajax Mine Project, British Columbia',
      date: '2024-07-03',
      pdfUrl: null,
      pageUrl: 'https://iaac-aeic.gc.ca/050/evaluations/document/158078',
      format: 'html'
    }, 'no file, so a citation points at the page that holds the text');
    assert.deepStrictEqual(pages.map(p => p.page), [1]);
    assert.match(pages[0].text, /The Honourable Catherine McKenna, Minister of Environment/);
    assert.strictEqual(stub.calls.length, 3, 'the page was already fetched; nothing follows it');
  });

  await t.test('reports a decision statement with no PDF rather than inventing one', async () => {
    const routes = FULL();
    routes['document/158078'] = '<html><body><h2>Decision Statement</h2>HTML only</body></html>';
    await unread(routes, { error: 'no_pdf_link' });
  });

  await t.test('will not call a page too short to be a decision one', async () => {
    // A page that rendered without its document still renders its heading and a line or two. That
    // is not Canada's decision, and storing it as one would put the Minister's name on nothing.
    const routes = FULL();
    routes['document/158078'] = '<html><body><h2>Decision Statement</h2>' +
      `<p>${'The Minister has decided. '.repeat(10)}</p></body></html>`;
    await unread(routes, { error: 'no_pdf_link' });
  });

  await t.test('names the status when the PDF itself cannot be fetched', async () => {
    const routes = FULL();
    delete routes['157936E.pdf'];
    await unread(routes, {
      title: 'Decision Statement Issued under Section 54 of the ' +
        'Canadian Environmental Assessment Act, 2012',
      pdfUrl: 'https://iaac-aeic.gc.ca/050/documents/p80105/157936E.pdf',
      format: 'pdf',
      error: 'pdf_fetch_failed:404'
    });
  });

  await t.test('names the missing extractor on a host without poppler', async () => {
    // The bare Function host. No poppler means no text, which is not the same as no decision.
    // What the extractor answers is the unit test above; that the walk carries the answer through
    // to the row instead of losing the read is this one.
    await unread(FULL(), {
      title: 'Decision Statement Issued under Section 54 of the ' +
        'Canadian Environmental Assessment Act, 2012',
      pdfUrl: 'https://iaac-aeic.gc.ca/050/documents/p80105/157936E.pdf',
      format: 'pdf',
      error: 'no_pdf_extractor'
    }, { pdfToPages: async () => ({ error: 'no_pdf_extractor' }) });
  });

  await t.test('names a PDF that holds no text', async () => {
    // A scanned statement filed as images: pages come back, every one of them blank.
    const routes = FULL();
    routes['157936E.pdf'] = BLANK_PDF;
    await unread(routes, {
      title: 'Decision Statement Issued under Section 54 of the ' +
        'Canadian Environmental Assessment Act, 2012',
      pdfUrl: 'https://iaac-aeic.gc.ca/050/documents/p80105/157936E.pdf',
      format: 'pdf',
      error: 'no_text'
    });
  });

  await t.test('throws when the registry answers an error', async () => {
    const stub = registry({});
    await assert.rejects(
      () => fetchFederalSource({ name: TILBURY, CEAALink: '/050/evaluations/proj/80105' }, stub),
      /-> 404/);
  });
});
