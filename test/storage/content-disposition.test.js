'use strict';

/**
 * The header is baked into a SIGNED URL, so a malformed one cannot be corrected at response time —
 * the caller gets a broken download and a retry produces the same broken download.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { contentDisposition, inlineType } = require('../../src/storage/content-disposition');

test('contentDisposition', async (t) => {
  await t.test('a plain name needs no escaping', () => {
    assert.strictEqual(contentDisposition('report.pdf'),
      'attachment; filename="report.pdf"; filename*=UTF-8\'\'report.pdf');
  });

  await t.test('a quote cannot end the quoted string early', () => {
    // `a".pdf` would close filename= and leave `.pdf"` as a header parameter of its own.
    assert.strictEqual(contentDisposition('a"b.pdf'),
      'attachment; filename="ab.pdf"; filename*=UTF-8\'\'ab.pdf');
  });

  await t.test('CR and LF cannot split the header', () => {
    const header = contentDisposition('a\r\nX-Injected: 1\r\n.pdf');
    assert.doesNotMatch(header, /[\r\n]/);
  });

  await t.test('a non-ASCII name survives in filename* and is transliterated in filename', () => {
    const header = contentDisposition('Rapport géothermique.pdf');
    assert.match(header, /filename="Rapport g_othermique\.pdf"/,
      'the quoted form is ASCII only — a raw byte there is what old clients mangle');
    assert.match(header, /filename\*=UTF-8''Rapport%20g%C3%A9othermique\.pdf$/);
  });

  await t.test('a backslash cannot escape the closing quote', () => {
    assert.doesNotMatch(contentDisposition('a\\".pdf'), /\\/);
  });

  await t.test('a name that sanitises away still names something', () => {
    assert.strictEqual(contentDisposition('"""'),
      'attachment; filename="download"; filename*=UTF-8\'\'download');
    assert.strictEqual(contentDisposition(undefined),
      'attachment; filename="download"; filename*=UTF-8\'\'download');
  });

  await t.test('a lone surrogate becomes U+FFFD instead of throwing', () => {
    // encodeURIComponent throws URIError on either half of a pair standing alone.
    for (const lone of ['\uD83D', '\uDCC4']) {
      assert.strictEqual(contentDisposition(`Report ${lone} draft.pdf`),
        'attachment; filename="Report _ draft.pdf"; filename*=UTF-8\'\'Report%20%EF%BF%BD%20draft.pdf');
    }
    assert.match(contentDisposition('\u{1F4C4}.pdf'), /filename\*=UTF-8''%F0%9F%93%84\.pdf$/,
      'a whole pair is kept');
  });

  await t.test('inline changes the type and nothing else', () => {
    assert.strictEqual(contentDisposition('Rapport "géo".pdf', { inline: true }),
      'inline; filename="Rapport g_o.pdf"; filename*=UTF-8\'\'Rapport%20g%C3%A9o.pdf');
    for (const name of ['a"b.pdf', 'a\r\nX: 1.pdf', 'Rapport géothermique.pdf', 'a\\".pdf', '"""']) {
      assert.strictEqual(contentDisposition(name, { inline: true }),
        contentDisposition(name).replace(/^attachment;/, 'inline;'), JSON.stringify(name));
    }
  });
});

test('inlineType', async (t) => {
  await t.test('a PDF or a common raster image renders inline', () => {
    assert.strictEqual(inlineType('application/pdf', 'report.pdf'), 'application/pdf');
    assert.strictEqual(inlineType('Application/PDF; charset=binary', 'x'), 'application/pdf');
    for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      assert.strictEqual(inlineType(mime, 'x'), mime);
    }
  });

  await t.test('anything that can run script in the store origin stays an attachment', () => {
    // The recorded type wins over the extension: a `.pdf` name does not make HTML safe.
    for (const mime of ['text/html', 'image/svg+xml', 'application/xml', 'text/xml',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain']) {
      assert.strictEqual(inlineType(mime, 'report.pdf'), null, mime);
    }
  });

  await t.test('the extension decides only when the recorded type says nothing', () => {
    assert.strictEqual(inlineType('', 'Report.PDF'), 'application/pdf');
    assert.strictEqual(inlineType(null, 'photo.jpg'), 'image/jpeg');
    assert.strictEqual(inlineType('application/octet-stream', 'report.pdf'), 'application/pdf');
    for (const name of ['page.html', 'logo.svg', 'data.xml', 'memo.docx', 'noext', 'x.constructor', '']) {
      assert.strictEqual(inlineType('', name), null, name);
    }
  });

  await t.test('other generic binary types also defer to the extension', () => {
    for (const mime of ['binary/octet-stream', 'application/x-download', 'Binary/Octet-Stream; x=1']) {
      assert.strictEqual(inlineType(mime, 'report.pdf'), 'application/pdf', mime);
      assert.strictEqual(inlineType(mime, 'page.html'), null, mime);
    }
  });
});
