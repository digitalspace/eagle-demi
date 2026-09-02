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
}

function configure() {
  config.notifyApiBase = 'https://notify-api-test.azurewebsites.net';
  config.notifyApiKey = 'test-function-key';
  config.linkBaseUrl = 'https://test.projects.eao.gov.bc.ca';
}

test('notify.updatePublished', async (t) => {
  t.afterEach(restore);

  await t.test('posts the event eagle-notify expects', async () => {
    configure();
    const calls = wire(() => ({ ok: true, status: 202 }));

    assert.strictEqual(await notify.updatePublished(ITEM, 'Nicomen Wind Energy'), true);
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
      url: 'https://test.projects.eao.gov.bc.ca/p/207/project-details',
      projectName: 'Nicomen Wind Energy',
      // Tags out, whitespace collapsed — the notification is plain text.
      excerpt: 'The comment period opens on Monday.'
    });
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

  await t.test('the excerpt is capped at 500 characters', () => {
    assert.strictEqual(notify.excerptOf(`<p>${'a'.repeat(900)}</p>`).length, 500);
  });

  await t.test('a 5xx is retried once, then reported as a failure', async () => {
    configure();
    const calls = wire(() => ({ ok: false, status: 503 }));

    assert.strictEqual(await notify.updatePublished(ITEM, null), false);
    assert.strictEqual(calls.length, 2, 'two attempts, not more — the caller retries on next push');
  });

  await t.test('a network error is retried, and a second attempt can succeed', async () => {
    configure();
    const calls = wire((n) => {
      if (n === 1) throw new Error('ECONNRESET');
      return { ok: true, status: 202 };
    });

    assert.strictEqual(await notify.updatePublished(ITEM, null), true);
    assert.strictEqual(calls.length, 2);
  });

  await t.test('a 4xx is not retried', async () => {
    configure();
    const calls = wire(() => ({ ok: false, status: 400 }));

    assert.strictEqual(await notify.updatePublished(ITEM, null), false);
    assert.strictEqual(calls.length, 1, 'the same rejected body would only be rejected again');
  });

  await t.test('never throws, whatever fetch does', async () => {
    configure();
    wire(() => { throw new Error('boom'); });
    assert.strictEqual(await notify.updatePublished(ITEM, null), false);
  });
});

test('notify.updateCancelled carries the same identity plus cancelled', async (t) => {
  t.afterEach(restore);

  configure();
  const calls = wire(() => ({ ok: true, status: 202 }));

  assert.strictEqual(await notify.updateCancelled(ITEM), true);
  assert.deepStrictEqual(JSON.parse(calls[0].opts.body), {
    kind: 'project-updated',
    serviceName: 'project:207',
    title: 'Public comment period opens',
    idempotencyKey: ITEM.id,
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

    assert.strictEqual(await notify.updatePublished(ITEM, null), true);
    assert.strictEqual(await notify.updateCancelled(ITEM), true);
    assert.strictEqual(calls.length, 0);
  });
});
