'use strict';

/**
 * The header is baked into a SIGNED URL, so a malformed one cannot be corrected at response time —
 * the caller gets a broken download and a retry produces the same broken download.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { contentDisposition } = require('../../src/storage/content-disposition');

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
});
