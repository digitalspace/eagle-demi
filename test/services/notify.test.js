'use strict';

/**
 * The eagle-notify push. What is asserted is the wire: the URL, the function-key header and the
 * event body, because eagle-notify is a separate service and nothing else in this repo would
 * notice the payload drifting.
 *
 * Retry and dark mode are the other half — a notification that throws would fail the mirror, and a
 * dark environment that "sent" something would suppress the real notification later.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../src/config');
const notify = require('../../src/services/notify');

const ITEM = {
  id: '5cf00c03a266b7e1877504db',
  projectId: '207',
  headline: 'Public comment period opens',
  content: '<p>The <b>comment period</b> opens\n  on Monday.</p>'
};

const realFetch = global.fetch;
const realBase = config.notifyApiBase;
const realKey = config.notifyApiKey;
const realLinkBase = config.linkBaseUrl;
const realReaderLinks = config.notifyUpdateReaderLinks;

function wire(handler) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return handler(calls.length);
  };
  return calls;
}

function restore() {
  global.fetch = realFetch;
  config.notifyApiBase = realBase;
  config.notifyApiKey = realKey;
  config.linkBaseUrl = realLinkBase;
  config.notifyUpdateReaderLinks = realReaderLinks;
}

function configure() {
  config.notifyApiBase = 'https://notify-api-test.azurewebsites.net';
  config.notifyApiKey = 'test-function-key';
  config.linkBaseUrl = 'https://test.projects.eao.gov.bc.ca';
  config.notifyUpdateReaderLinks = false;
}

test('notify.updatePublished', async (t) => {
  t.afterEach(restore);

  await t.test('posts the event eagle-notify expects', async () => {
    configure();
    const calls = wire(() => ({ ok: true, status: 202 }));

    assert.strictEqual(await notify.updatePublished(ITEM, 'Nicomen Wind Energy'), notify.OUTCOME.SENT);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://notify-api-test.azurewebsites.net/api/events');
    assert.strictEqual(calls[0].opts.method, 'POST');
    assert.deepStrictEqual(calls[0].opts.headers, {
      'content-type': 'application/json',
      'x-functions-key': 'test-function-key'
    });
    assert.deepStrictEqual(JSON.parse(calls[0].opts.body), {
      kind: 'project-updated',
      serviceName: 'project:207',
      title: 'Public comment period opens',
      idempotencyKey: ITEM.id,
      id: ITEM.id,
      url: 'https://test.projects.eao.gov.bc.ca/p/207/project-details',
      projectName: 'Nicomen Wind Energy',
      // Tags out, whitespace collapsed — the notification is plain text.
      excerpt: 'The comment period opens on Monday.',
      // No Updates fields on the row: the summary fallback, no shortHeadline and no image keys.
      summary: 'The comment period opens on Monday.'
    });
  });

  await t.test('the Updates fields are sent as written, with the image as an absolute URL', async () => {
    configure();
    const calls = wire(() => ({ ok: true, status: 202 }));

    await notify.updatePublished({
      ...ITEM,
      shortHeadline: 'Comment period opens',
      summary: 'Have your say.'
    }, null, { document: '5cf00c03a266b7e187750002', alt: 'Site map' });

    const body = JSON.parse(calls[0].opts.body);
    assert.strictEqual(body.shortHeadline, 'Comment period opens');
    assert.strictEqual(body.summary, 'Have your say.');
    assert.strictEqual(body.featuredImageUrl, 'https://test.projects.eao.gov.bc.ca/demi-search/' +
      'documents/5cf00c03a266b7e187750002/download?redirect=1');
    assert.strictEqual(body.featuredImageAlt, 'Site map');
  });

  await t.test('no image without alt text, and none the caller did not pass', async () => {
    configure();
    const calls = wire(() => ({ ok: true, status: 202 }));
    const withImage = { ...ITEM, featuredImage: { document: '5cf00c03a266b7e187750002', alt: 'Site map' } };

    await notify.updatePublished(withImage, null, { document: '5cf00c03a266b7e187750002', alt: '' });
    await notify.updatePublished(withImage, null);

    for (const call of calls) {
      const body = JSON.parse(call.opts.body);
      assert.strictEqual(body.featuredImageUrl, undefined);
      assert.strictEqual(body.featuredImageAlt, undefined);
    }
  });

  await t.test('entities are decoded before the text is trimmed', () => {
    const html = '<p>Rock &amp; Roll&rsquo;s &ldquo;Caf&eacute;&rdquo; &#8212; &#x2019;</p>';
    assert.strictEqual(notify.excerptOf(html), 'Rock & Roll’s “Café” — ’');
    assert.strictEqual(notify.summaryOf(html), 'Rock & Roll’s “Café” — ’');
    // An entity costs one character, not six, against the cap.
    assert.strictEqual(notify.summaryOf(`<p>${'&amp;'.repeat(300)}</p>`), '&'.repeat(280));
  });

  await t.test('the fallback summary never carries a tag, split, escaped or unclosed', () => {
    assert.strictEqual(notify.summaryOf('<p><<script>script>alert(1)<</script>/script></p>'), 'scriptalert(1)/script');
    assert.strictEqual(notify.summaryOf('<p>a &lt;script&gt;alert(1)&lt;/script&gt; b</p>'), 'a scriptalert(1)/script b');
    assert.strictEqual(notify.summaryOf('<p>Open <script</p>'), 'Open script');
  });

  await t.test('block tags break words; inline tags do not', () => {
    assert.strictEqual(notify.summaryOf('<ul><li>One</li><li>Two</li></ul><p>Next.</p>'), 'One Two');
    assert.strictEqual(notify.summaryOf('<div>Head</div><p>Body</p>'), 'Head');
    assert.strictEqual(notify.summaryOf('<p>Bo<b>ld</b> word</p>'), 'Bold word');
  });

  await t.test('the fallback summary is the first non-empty paragraph, cut at 280', () => {
    assert.strictEqual(
      notify.summaryOf('<p>&nbsp;</p><p> </p><p>First <i>one</i>,<br>two.</p><p>Second.</p>'),
      'First one, two.');
    assert.strictEqual(notify.summaryOf('Plain first.\n\nPlain second.'), 'Plain first.');
    assert.strictEqual(notify.summaryOf(`<p>${'a'.repeat(900)}</p>`).length, 280);
  });

  await t.test('an update with no project is site-wide', async () => {
    configure();
    const calls = wire(() => ({ ok: true, status: 202 }));

    await notify.updatePublished({ ...ITEM, projectId: null }, null);

    const body = JSON.parse(calls[0].opts.body);
    assert.strictEqual(body.serviceName, 'eao:updates');
    assert.strictEqual(body.url, 'https://test.projects.eao.gov.bc.ca/news');
    assert.strictEqual(body.projectName, null);
  });

  await t.test('with reader links on, a project update links its own reader page', async () => {
    configure();
    config.notifyUpdateReaderLinks = true;
    const calls = wire(() => ({ ok: true, status: 202 }));

    await notify.updatePublished(ITEM, 'Nicomen Wind Energy');

    assert.strictEqual(JSON.parse(calls[0].opts.body).url,
      'https://test.projects.eao.gov.bc.ca/updates/5cf00c03a266b7e1877504db');
  });

  await t.test('with reader links on, a site-wide update links its own reader page', async () => {
    configure();
    config.notifyUpdateReaderLinks = true;
    const calls = wire(() => ({ ok: true, status: 202 }));

    await notify.updatePublished({ ...ITEM, projectId: null }, null);

    assert.strictEqual(JSON.parse(calls[0].opts.body).url,
      'https://test.projects.eao.gov.bc.ca/updates/5cf00c03a266b7e1877504db');
  });

  await t.test('the excerpt is capped at 500 characters', () => {
    assert.strictEqual(notify.excerptOf(`<p>${'a'.repeat(900)}</p>`).length, 500);
  });

  await t.test('a 5xx is retried once, then reported as a failure', async () => {
    configure();
    const calls = wire(() => ({ ok: false, status: 503 }));

    assert.strictEqual(await notify.updatePublished(ITEM, null), notify.OUTCOME.FAILED);
    assert.strictEqual(calls.length, 2, 'two attempts, not more — a later tick retries');
  });

  await t.test('a network error is retried, and a second attempt can succeed', async () => {
    configure();
    const calls = wire((n) => {
      if (n === 1) throw new Error('ECONNRESET');
      return { ok: true, status: 202 };
    });

    assert.strictEqual(await notify.updatePublished(ITEM, null), notify.OUTCOME.SENT);
    assert.strictEqual(calls.length, 2);
  });

  await t.test('a 4xx is not retried', async () => {
    configure();
    const calls = wire(() => ({ ok: false, status: 400 }));

    assert.strictEqual(await notify.updatePublished(ITEM, null), notify.OUTCOME.REJECTED);
    assert.strictEqual(calls.length, 1, 'the same rejected body would only be rejected again');
  });

  await t.test('never throws, whatever fetch does', async () => {
    configure();
    wire(() => { throw new Error('boom'); });
    assert.strictEqual(await notify.updatePublished(ITEM, null), notify.OUTCOME.FAILED);
  });
});

test('notify.updateCancelled carries the same identity, the update id, and cancelled', async (t) => {
  t.afterEach(restore);

  configure();
  const calls = wire(() => ({ ok: true, status: 202 }));

  assert.strictEqual(await notify.updateCancelled(ITEM), notify.OUTCOME.SENT);
  assert.deepStrictEqual(JSON.parse(calls[0].opts.body), {
    kind: 'project-updated',
    serviceName: 'project:207',
    title: 'Public comment period opens',
    idempotencyKey: ITEM.id,
    // eagle-notify cancels every open event for this Update by it.
    id: ITEM.id,
    cancelled: true
  });
});

test('dark until both settings are present', async (t) => {
  t.afterEach(restore);

  await t.test('configured() needs the base AND the key', () => {
    config.notifyApiBase = '';
    config.notifyApiKey = '';
    assert.strictEqual(notify.configured(), false);
    config.notifyApiBase = 'https://notify-api-test.azurewebsites.net';
    assert.strictEqual(notify.configured(), false, 'a base with no key sends nothing');
    config.notifyApiKey = 'test-function-key';
    assert.strictEqual(notify.configured(), true);
  });

  await t.test('a dark push sends nothing and reports success', async () => {
    config.notifyApiBase = '';
    config.notifyApiKey = '';
    const calls = wire(() => { throw new Error('must not fetch'); });

    assert.strictEqual(await notify.updatePublished(ITEM, null), notify.OUTCOME.SENT);
    assert.strictEqual(await notify.updateCancelled(ITEM), notify.OUTCOME.SENT);
    assert.strictEqual(calls.length, 0);
  });
});
