'use strict';

/**
 * The increment check against real `pdf-title/titler.py` output (fixtures written by it from the
 * titler's own test builders) and against hand-built increments. `classic-xmp.in-place.pdf` is
 * from the earlier titler that revised XMP in place, which the check now refuses.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const pdfTail = require('../../src/helpers/pdf-tail');
const { readOriginal } = require('../../src/helpers/pdf-original');
const { fixture, classicTail, classicPdf } = require('./pdf-build');


function load(name, titled = 'titled', ext = '.pdf') {
  return { original: fixture(`${name}.original${ext}`), titled: fixture(`${name}.${titled}${ext}`) };
}

const readFacts = (original) => readOriginal(async (offset, length) => original.subarray(offset, offset + length), original.length);

/** The title hand-built increments write; fixtures pass their own. */
const TITLE = 'New';
const FINAL = 'Site C Report, Final (2026) \u00e9';
const checkTail = (bytes, length, facts, title = TITLE) => pdfTail.checkTail(bytes, length, facts, title);

/** An XMP packet the way the titler leaves one, with `inner` added inside the dc description. */
const packet = (title = TITLE, inner = '') => '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
  '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
  `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title>${inner}\n` +
  '</rdf:Description></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>';
/** An XMP stream object holding `body` as UTF-8, as a latin1 body string for `classicTail`. */
const xmpObject = (body = packet()) => {
  const bytes = Buffer.from(body, 'utf8');
  return `<< /Type /Metadata /Subtype /XML /Length ${bytes.length} >>\nstream\n${bytes.toString('latin1')}\nendstream`;
};
const XMP = xmpObject();

test('real titler output passes', async (t) => {
  const shapes = [['classic-info', FINAL], ['classic-info', 'Site C Report', 'retitled'], ['xrefstream-noinfo', FINAL]];
  for (const [name, title, titledAs = 'titled', ext] of shapes) {
    await t.test(`${name} ${titledAs}`, async () => {
      const { original, titled } = load(name, titledAs, ext);
      assert.ok(titled.subarray(0, original.length).equals(original));
      const facts = await readFacts(original);
      assert.ok(!facts.error, facts.error);
      assert.equal(checkTail(titled.subarray(original.length), original.length, facts, title), null);
      // The same bytes for any other title are refused.
      assert.equal(checkTail(titled.subarray(original.length), original.length, facts, `${title}.`), 'tail-info-title');
    });
  }
});

test('XMP fixtures from a titler that copies PDF/A conformance B raw are refused', async (t) => {
  // Rebuild them once the titler writes operator words as character references.
  const shapes = [['classic-xmp', FINAL], ['xrefstream-xmp', FINAL], ['objstm-xmp', 'Site C Report'], ['linearized-large', 'Site C Report', '.pdf.gz']];
  for (const [name, title, ext] of shapes) {
    await t.test(name, async () => {
      const { original, titled } = load(name, 'titled', ext);
      assert.match(titled.subarray(original.length).toString('latin1'), /<pdfaid:conformance>B</);
      const facts = await readFacts(original);
      assert.equal(checkTail(titled.subarray(original.length), original.length, facts, title), 'tail-xmp-body');
    });
  }
});

test('an XMP word cannot paint a path an earlier content stream left open', async () => {
  // Page 3 draws stream 4, which builds a path and never paints it, then object 7, which the original never defines.
  const original = classicPdf([
    [1, '<< /Title (Old) >>'],
    [2, '<< /Type /Catalog /Pages 3 0 R /Metadata 5 0 R >>'],
    [3, '<< /Type /Page /MediaBox [0 0 200 200] /Contents [4 0 R 7 0 R] >>'],
    [4, '<< /Length 14 >>\nstream\n0 0 200 200 re\nendstream'],
    [5, xmpObject(packet('Old'))],
    [6, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>']
  ], '/Size 7 /Root 2 0 R /Info 1 0 R');
  const facts = await readFacts(original);
  assert.equal(facts.size, 7);
  const titled = (conformance) => classicTail(original, [
    [1, '<< /Title (New) >>'],
    [2, '<< /Type /Catalog /Pages 3 0 R /Metadata 7 0 R >>'],
    [7, xmpObject(packet(TITLE, `<pdfaid:conformance>${conformance}</pdfaid:conformance>`))]
  ], `/Size 8 /Root 2 0 R /Info 1 0 R /Prev ${facts.prev}`);
  assert.equal(checkTail(titled('B'), original.length, facts), 'tail-xmp-body');
  assert.equal(checkTail(titled('&#66;'), original.length, facts), null);
});

test('XMP revised in place is refused, whatever the object at that number is', async (t) => {
  await t.test('the earlier titler\'s output', async () => {
    const { original, titled } = load('classic-xmp', 'in-place');
    const facts = await readFacts(original);
    assert.equal(checkTail(titled.subarray(original.length), original.length, facts, FINAL), 'tail-xmp-in-place');
  });

  await t.test('a /Metadata that is also page 1\'s content stream', async () => {
    const original = classicPdf([
      [1, '<< /Title (Old) >>'],
      [2, '<< /Type /Catalog /Pages 3 0 R /Metadata 5 0 R >>'],
      [3, '<< /Type /Pages /Kids [4 0 R] /Count 1 >>'],
      [4, '<< /Type /Page /Parent 3 0 R /MediaBox [0 0 200 200] /Contents 5 0 R >>'],
      [5, '<< /Length 5 >>\nstream\nBT ET\nendstream']
    ], '/Size 6 /Root 2 0 R /Info 1 0 R');
    const facts = await readFacts(original);
    const page = '<< /Type /Metadata /Subtype /XML /Length 38 >>\nstream\nBT /F1 48 Tf 72 700 Td (anything) Tj ET\nendstream';
    const tail = classicTail(original, [[1, '<< /Title (New) >>'], [5, page]], `/Size 6 /Root 2 0 R /Info 1 0 R /Prev ${facts.prev}`);
    assert.equal(checkTail(tail, original.length, facts), 'tail-xmp-in-place');
  });
});

test('XMP at a new number with the Catalog revised for it', async (t) => {
  const { original } = load('classic-xmp');
  const facts = await readFacts(original);
  const n = facts.size;
  const trailer = `/Size ${n + 1} /Root 3 0 R /Info 1 0 R /Prev ${facts.prev}`;
  // The original Info and Catalog in other spellings: hex strings, other key order.
  const info = '<< /ModDate <443a3230303430313032303330343035> /Title (New) /Producer (Acrobat Distiller 6.0.1) >>';
  const catalog = (extra = '') => `<< /Metadata ${n} 0 R /Pages 2 0 R /Type /Catalog ${extra}>>`;
  const check = (bodies, dict = trailer) => checkTail(classicTail(original, bodies, dict), original.length, facts);

  await t.test('commits', () => {
    assert.equal(check([[1, info], [3, catalog()], [n, XMP]]), null);
  });

  const cases = {
    'a Catalog with a key added, even one Info may never hold': [[[1, info], [3, catalog('/OpenAction 9 0 R ')], [n, XMP]], 'tail-catalog-changed'],
    'a Catalog with a key dropped': [[[1, info], [3, `<< /Metadata ${n} 0 R /Type /Catalog >>`], [n, XMP]], 'tail-catalog-changed'],
    'a Catalog still naming the old XMP': [[[1, info], [3, '<< /Metadata 6 0 R /Pages 2 0 R /Type /Catalog >>'], [n, XMP]], 'tail-catalog-changed'],
    'a new XMP the Catalog does not name': [[[1, info], [n, XMP]], 'tail-xmp'],
    'a Catalog revised with no new XMP': [[[1, info], [3, catalog()]], 'tail-catalog-changed'],
    'a new XMP under a number the original uses': [[[1, info], [3, '<< /Metadata 4 0 R /Pages 2 0 R /Type /Catalog >>'], [4, XMP]], 'tail-xmp-number'],
    'a Catalog that is a stream': [[[1, info], [3, `${catalog().slice(0, -2)}/Length 1 >>\nstream\nx\nendstream`], [n, XMP]], 'tail-object']
  };
  for (const [label, [bodies, reason]] of Object.entries(cases)) {
    await t.test(label, () => assert.equal(check(bodies), reason));
  }

  await t.test('a file with no XMP gets no Catalog revision', async () => {
    const plain = load('classic-info').original;
    const plainFacts = await readFacts(plain);
    const m = plainFacts.size;
    const tail = classicTail(plain, [[1, info], [3, `<< /Type /Catalog /Pages 2 0 R /Metadata ${m} 0 R >>`], [m, XMP]],
      `/Size ${m + 1} /Root 3 0 R /Info 1 0 R /Prev ${plainFacts.prev}`);
    assert.equal(checkTail(tail, plain.length, plainFacts), 'tail-catalog-changed');
  });
});

test('the new XMP body is strict XML whose only text is the title', async (t) => {
  const { original } = load('classic-xmp');
  const facts = await readFacts(original);
  const n = facts.size;
  const trailer = `/Size ${n + 1} /Root 3 0 R /Info 1 0 R /Prev ${facts.prev}`;
  const catalog = `<< /Metadata ${n} 0 R /Pages 2 0 R /Type /Catalog >>`;
  const check = (body, { title = TITLE, info = '(New)' } = {}) => checkTail(
    classicTail(original, [[1, `<< /ModDate (D:20040102030405) /Producer (Acrobat Distiller 6.0.1) /Title ${info} >>`], [3, catalog], [n, xmpObject(body)]], trailer),
    original.length, facts, title);

  const accepted = {
    'the titler\'s packet': packet(),
    'PDF/A identification values, B as a character reference': packet(TITLE, '<pdfaid:part>1</pdfaid:part><pdfaid:conformance>&#66;</pdfaid:conformance>'),
    'dates and ids as text': packet(TITLE, '<xmp:CreateDate>2004-01-02T03:04:05Z</xmp:CreateDate><xmpMM:DocumentID>uuid:6c9a-11</xmpMM:DocumentID>'),
    'an older dc:title attribute': packet(TITLE, '<x:a dc:title="New"/>'),
    'a Producer with parentheses': packet(TITLE, '<pdf:Producer>Adobe Acrobat 11.0 (Windows)</pdf:Producer>'),
    'an attribute with a comma and parentheses': packet(TITLE, '<x:a x:xmptk="Adobe XMP Core 5.6-c015 (84.1), 2016/09/10"/>'),
    'non-ASCII and apostrophes as text': packet(TITLE, '<xmp:CreatorTool>Microsoft\u00ae Word\u2019s</xmp:CreatorTool>'),
    'no xpacket wrapper': packet().replace(/<\?xpacket[^>]*>/g, '')
  };
  for (const [label, body] of Object.entries(accepted)) {
    await t.test(`accepted: ${label}`, () => assert.equal(check(body), null));
  }
  await t.test('a title holding an operator word is accepted only as a character reference', () => {
    const info = '(Appendix F)';
    assert.equal(check(packet('Appendix &#70;'), { title: 'Appendix F', info }), null);
    assert.equal(check(packet('Appendix &#x46;'), { title: 'Appendix F', info }), null);
    assert.equal(check(packet('Appendix F'), { title: 'Appendix F', info }), 'tail-xmp-body');
    assert.equal(check(packet('Plan B'), { title: 'Plan B', info: '(Plan B)' }), 'tail-xmp-body');
    assert.equal(check(packet('Plan &#66;'), { title: 'Plan B', info: '(Plan B)' }), null);
  });

  await t.test('accepted: a title with markup characters, escaped', () => {
    assert.equal(check(packet('A &amp; &#66; &lt;1&gt;'), { title: 'A & B <1>', info: '(A & B <1>)' }), null);
  });

  const refused = {
    'PDF/A conformance B written raw': packet(TITLE, '<pdfaid:part>1</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>'),
    'page operators as a text node': packet(TITLE, '<x:a>BT /F1 48 Tf 72 700 Td (x) Tj ET</x:a>'),
    'path operators without delimiters': packet(TITLE, '<x:a>0 0 999 999 re f</x:a>'),
    'an operator glued to a number': packet(TITLE, '<x:a>1re</x:a>'),
    'a dc:title other than the wanted title': packet('Other'),
    'a second language with another title': packet().replace('</rdf:Alt>', '<rdf:li xml:lang="fr">Autre</rdf:li></rdf:Alt>'),
    'an empty dc:title': packet().replace(`>${TITLE}<`, '><'),
    'no dc:title at all': packet().replace(/<dc:title>.*<\/dc:title>/, ''),
    'a dc:title attribute with another title': packet(TITLE, '<x:a dc:title="Other"/>'),
    'a DOCTYPE with an entity': `<!DOCTYPE x [<!ENTITY e "BT">]>${packet()}`,
    'an undeclared entity': packet(TITLE, '<x:a>&e;</x:a>'),
    'CDATA': packet(TITLE, '<x:a><![CDATA[BT]]></x:a>'),
    'a comment': packet(TITLE, '<!-- > re f -->'),
    'another processing instruction': packet(TITLE, '<?x y?>'),
    'a > inside an attribute value': packet(TITLE, '<x:a b="1 > re"/>'),
    'an unbalanced ( in text': packet(TITLE, '<pdf:Producer>Adobe (Windows</pdf:Producer>'),
    'a ) before its ( in text': packet(TITLE, '<pdf:Producer>a) (b</pdf:Producer>'),
    'a % in text': packet(TITLE, '<x:a>100%</x:a>'),
    'a backslash in text': packet(TITLE, '<x:a>a\\b</x:a>'),
    'brackets in text': packet(TITLE, '<x:a>[1]</x:a>'),
    'a control character in text': packet(TITLE, '<x:a>a\u0007b</x:a>'),
    'a > in text': packet(TITLE, '<x:a>a > b</x:a>'),
    'an operator after a string': packet(TITLE, '<x:a>(x) Tj</x:a>'),
    'an operator glued to a string': packet(TITLE, '<x:a>(x)Tj</x:a>'),
    'a lone quote operator': packet(TITLE, '<x:a>(x) \'</x:a>'),
    'a stray & in an attribute': packet(TITLE, '<x:a b="a & b"/>'),
    'mismatched tags': packet(TITLE, '<x:a></x:b>'),
    'a second root': `${packet()}<x:b/>`,
    'text after the packet': `${packet()}f`,
    'bytes that are not UTF-8': `${packet()}\xff`,
    'over 64 KiB': packet(TITLE, ' '.repeat(64 * 1024))
  };
  for (const [label, body] of Object.entries(refused)) {
    await t.test(`refused: ${label}`, () => {
      const bytes = label === 'bytes that are not UTF-8' ? null : body;
      const result = bytes === null
        ? checkTail(classicTail(original, [[1, '<< /ModDate (D:20040102030405) /Producer (Acrobat Distiller 6.0.1) /Title (New) >>'], [3, catalog],
          [n, `<< /Type /Metadata /Subtype /XML /Length ${body.length} >>\nstream\n${body}\nendstream`]], trailer), original.length, facts, TITLE)
        : check(bytes);
      assert.equal(result, 'tail-xmp-body');
    });
  }

  await t.test('a long unclosed tag is refused quickly', () => {
    const started = Date.now();
    assert.equal(check(packet(TITLE, `<x:a${' b="1"'.repeat(5000)}${' '.repeat(30000)}`)), 'tail-xmp-body');
    assert.ok(Date.now() - started < 1000);
  });
});

test('Info /Title decodes to the wanted title', () => {
  const { original } = load('classic-info');
  const check = async (title, info) => {
    const facts = await readFacts(original);
    const trailer = `/Size ${facts.size} /Root 3 0 R /Info 1 0 R /Prev ${facts.prev}`;
    const kept = '/Producer (Acrobat Distiller 6.0.1) /ModDate (D:20040102030405)';
    return checkTail(classicTail(original, [[1, `<< ${kept} /Title ${info} >>`]], trailer), original.length, facts, title);
  };
  return Promise.all([
    check('a\u2013b', '(a\\205b)').then(r => assert.equal(r, null, 'PDFDocEncoding en dash')),
    check('\u4e2d', '<FEFF4E2D>').then(r => assert.equal(r, null, 'UTF-16BE')),
    check('caf\u00e9', '(caf\\351)').then(r => assert.equal(r, null, 'Latin-1 e acute')),
    check('a\u2013b', '(a-b)').then(r => assert.equal(r, 'tail-info-title')),
    check('x', '(x\\237)').then(r => assert.equal(r, 'tail-info-title', 'an undefined PDFDocEncoding byte'))
  ]);
});

test('a revised Info changes only /Title; a new Info holds only /Title', async (t) => {
  const { original } = load('classic-info');
  const facts = await readFacts(original);
  const trailer = `/Size ${facts.size} /Root 3 0 R /Info 1 0 R /Prev ${facts.prev}`;
  const kept = '/Producer (Acrobat Distiller 6\\0560\\0561) /ModDate (D\\07220040102030405)';
  const check = (info) => checkTail(classicTail(original, [[1, info]], trailer), original.length, facts);

  assert.equal(check(`<< ${kept} /Title (New) >>`), null);
  assert.equal(check(`<< ${kept} /Title (New) /Author (x) >>`), 'tail-info-changed');
  assert.equal(check(`<< ${kept.replace('6\\0560', '7\\0560')} /Title (New) >>`), 'tail-info-changed');
  assert.equal(check(`<< ${kept.replace('2004', '2026')} /Title (New) >>`), 'tail-info-changed');
  assert.equal(check('<< /Producer (Acrobat Distiller 6.0.1) /Title (New) >>'), 'tail-info-changed');
  assert.equal(check(`<< ${kept} /Title /New >>`), 'tail-info');

  await t.test('a new Info', async () => {
    const { original: bare } = load('xrefstream-noinfo');
    const bareFacts = await readFacts(bare);
    const n = bareFacts.size;
    const fresh = (info) => checkTail(classicTail(bare, [[n, info]], `/Size ${n + 1} /Root 1 0 R /Info ${n} 0 R /Prev ${bareFacts.prev}`), bare.length, bareFacts);
    assert.equal(fresh('<< /Title (New) >>'), null);
    assert.equal(fresh('<< /Title (New) /Author (x) >>'), 'tail-info');
    // A new number may be one an original page names as an ExtGState and never defines.
    assert.equal(fresh('<< /Title (New) /ca 0 >>'), 'tail-info');
  });
});

test('deep nesting in an increment is refused, not a stack overflow', () => {
  const tail = (depth) => Buffer.from(`1 0 obj\n<< /Title (x) /K ${'['.repeat(depth)}${']'.repeat(depth)} >>\nendobj\n`, 'latin1');
  const facts = { size: 9, root: [3, 0], info: [1, 0], metadata: null, catalog: '', infoKept: '' };
  // The Info dictionary is one level, so 31 arrays inside it reach the cap and pass the parse.
  assert.equal(checkTail(tail(31), 100, facts), 'tail-info-changed');
  assert.equal(checkTail(tail(32), 100, facts), 'tail-syntax');
  assert.equal(checkTail(tail(100000), 100, facts), 'tail-syntax');
});

test('facts not in the structural reader\'s shape are refused', async () => {
  const { original, titled } = load('classic-info');
  const facts = await readFacts(original);
  const tail = titled.subarray(original.length);
  // The previous reader's shape, without the Catalog and Info it now keeps, fails closed.
  const { catalog, infoKept, ...older } = facts;
  assert.ok(catalog && infoKept);
  assert.equal(checkTail(tail, original.length, older, FINAL), 'original-unscanned');
  // So does the retired text scan's shape.
  assert.equal(checkTail(tail, original.length, { ...older, metadataObjects: [] }, FINAL), 'original-unscanned');
  assert.equal(checkTail(tail, original.length, null, FINAL), 'original-unscanned');
  assert.equal(checkTail(tail, original.length, facts, FINAL), null);
  assert.equal(checkTail(tail, original.length, facts, null), 'tail-no-title');
});

test('a fake metadata header after a literal endstream cannot make a page XMP (N9)', async () => {
  // The content stream has an indirect /Length, and its data holds `endstream` and then a
  // metadata header for object 4, the page.
  const decoy = 'BT ET\n% endstream\n4 0 obj\n<< /Type /Metadata /Subtype /XML /Length 0 >>\nstream\n\nendstream\nendobj\n';
  const original = classicPdf([
    [1, '<< /Title (Old) >>'],
    [2, '<< /Type /Catalog /Pages 3 0 R >>'],
    [3, '<< /Type /Pages /Kids [4 0 R] /Count 1 >>'],
    [4, '<< /Type /Page /Parent 3 0 R /MediaBox [0 0 200 200] /Contents 5 0 R >>'],
    [5, `<< /Length 6 0 R >>\nstream\n${decoy}\nendstream`],
    [6, String(decoy.length + 1)]
  ], '/Size 7 /Root 2 0 R /Info 1 0 R');
  const facts = await readFacts(original);
  assert.equal(facts.metadata, null);
  const xmp = '<< /Type /Metadata /Subtype /XML /Length 5 >>\nstream\n<x/>\n\nendstream';
  const tail = classicTail(original, [[1, '<< /Title (New) >>'], [4, xmp]], `/Size 7 /Root 2 0 R /Info 1 0 R /Prev ${facts.prev}`);
  assert.equal(checkTail(tail, original.length, facts), 'tail-xmp-number');
});

test('hostile increments are refused', async (t) => {
  const { original } = load('classic-info');
  const facts = await readFacts(original);
  const trailer = `/Size ${facts.size} /Root ${facts.root.join(' ')} R /Info 1 0 R /Prev ${facts.prev}`;
  const info = '<< /Title (New) /Producer (Acrobat Distiller 6.0.1) /ModDate (D:20040102030405) >>';
  const check = (tail) => checkTail(tail, original.length, facts);

  await t.test('the hand-built control passes, so each refusal below is its own', () => {
    assert.equal(check(classicTail(original, [[1, info]], trailer)), null);
  });

  const cases = {
    'a page object added': [[[1, info], [9, '<< /Type /Page /Parent 2 0 R /Contents 10 0 R >>']], /tail-forbidden:Contents|tail-info/],
    'OpenAction in the Info dictionary': [[[1, '<< /Title (x) /OpenAction 5 0 R >>']], /tail-forbidden:OpenAction/],
    'JavaScript as a name value': [[[1, '<< /Title (x) /S /JavaScript >>']], /tail-forbidden:JavaScript/],
    'a hex-escaped JS key': [[[1, '<< /Title (x) /#4A#53 (app.alert(1)) >>']], /tail-forbidden:JS/],
    'a URI inside an array': [[[1, '<< /Title (x) /K [/URI] >>']], /tail-forbidden:URI/],
    'an Info value that is a reference': [[[1, '<< /Title (x) /Author 4 0 R >>']], /tail-info-changed/],
    'an Info value that is a dictionary': [[[1, '<< /Title (x) /Pages << /Count 1 >> >>']], /tail-info-changed/],
    'an Info without a title': [[[1, '<< /Producer (x) >>']], /tail-info/],
    'two Info dictionaries': [[[1, info], [9, info]], /tail-info/],
    'the Info revised under another number': [[[2, info]], /tail-info-number|tail-info-ref/],
    'a filtered stream': [[[1, info], [9, '<< /Type /Metadata /Subtype /XML /Filter /FlateDecode /Length 1 >>\nstream\nx\nendstream']], /tail-forbidden:Filter/],
    'an object stream': [[[1, info], [9, '<< /Type /ObjStm /N 1 /First 4 /Length 1 >>\nstream\nx\nendstream']], /tail-forbidden:ObjStm/],
    'an XMP stream on a number that was not metadata': [[[1, info], [2, '<< /Type /Metadata /Subtype /XML /Length 1 >>\nstream\nx\nendstream']], /tail-xmp-number/],
    'a stream of another type': [[[1, info], [9, '<< /Length 1 >>\nstream\nx\nendstream']], /tail-object/]
  };
  for (const [label, [bodies, reason]] of Object.entries(cases)) {
    await t.test(label, () => {
      assert.match(String(check(classicTail(original, bodies, trailer))), reason);
    });
  }

  await t.test('a trailer naming another root', () => {
    assert.equal(check(classicTail(original, [[1, info]], trailer.replace(`/Root ${facts.root.join(' ')} R`, '/Root 1 0 R'))), 'tail-root');
  });

  await t.test('a trailer with a wrong /Prev', () => {
    assert.equal(check(classicTail(original, [[1, info]], trailer.replace(`/Prev ${facts.prev}`, '/Prev 9'))), 'tail-prev');
  });

  await t.test('an extra trailer key such as /Encrypt', () => {
    assert.equal(check(classicTail(original, [[1, info]], `${trailer} /Encrypt 7 0 R`)), 'tail-trailer');
  });

  await t.test('an xref entry pointing back into the original', () => {
    const tail = classicTail(original, [[1, info]], trailer);
    const text = tail.toString('latin1');
    const entry = String(original.length).padStart(10, '0');
    const moved = Buffer.from(text.replace(`${entry} 00000 n`, '0000000009 00000 n'), 'latin1');
    assert.equal(check(moved), 'tail-xref');
  });

  await t.test('bytes after %%EOF', () => {
    assert.equal(check(Buffer.concat([classicTail(original, [[1, info]], trailer), Buffer.from('3 0 obj\n<< >>\nendobj\n')])), 'tail-trailing-bytes');
  });

  await t.test('a trailer /Size that does not cover the new numbers', () => {
    const bodies = [[1, info], [facts.size + 3, '<< /Title (x) >>']];
    assert.match(String(check(classicTail(original, bodies, trailer))), /tail-info|tail-size/);
    const fresh = { ...facts, info: null };
    const newInfo = classicTail(original, [[facts.size + 3, '<< /Title (New) >>']], trailer.replace('/Info 1 0 R', `/Info ${facts.size + 3} 0 R`));
    assert.equal(checkTail(newInfo, original.length, fresh), 'tail-size');
  });

  await t.test('an xref generation that differs from the object\'s', () => {
    const tail = classicTail(original, [[1, info]], trailer);
    const bent = Buffer.from(tail.toString('latin1').replace(' 00000 n', ' 00001 n'), 'latin1');
    assert.equal(check(bent), 'tail-xref');
  });

  await t.test('a comment after %%EOF', () => {
    assert.equal(check(Buffer.concat([classicTail(original, [[1, info]], trailer), Buffer.from('% note\n')])), 'tail-trailing-bytes');
  });

  await t.test('an original the reader refused refuses everything', () => {
    const tail = classicTail(original, [[1, info]], trailer);
    assert.equal(checkTail(tail, original.length, { error: 'original-no-startxref' }), 'original-no-startxref');
  });
});

test('an xref stream may not take a number the original uses', async () => {
  const { original, titled } = load('xrefstream-noinfo');
  const facts = await readFacts(original);
  const tail = titled.subarray(original.length).toString('latin1');
  const xrefNum = Number(/(\d+) 0 obj\n<< \/Type \/XRef/.exec(tail)[1]);
  assert.ok(xrefNum >= facts.size, 'the titler takes a fresh number');
  // Same bytes, but the original is told its numbers reach past the xref stream's.
  assert.equal(checkTail(titled.subarray(original.length), original.length, { ...facts, size: xrefNum + 1 }, FINAL), 'tail-object-number');
});
