'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const cosmos = require('../../../src/db/cosmos-nosql');
const controller = require('../../../src/controllers/nosql/pdf-title');
const { logger } = require('../../../src/utils/logger');
const { makeRes } = require('../../../src/http/router');
const { readForLevel } = require('../../../src/helpers/access-sql');

const ID = '5f1d7a3c9b2e4d6f8a0b1c2d';
const DOC = {
  id: ID, projectId: 'p1', s3Key: 'etl/p1/report.pdf', displayName: 'Site C Report',
  mimeType: 'application/pdf', fileExt: 'pdf', fileSize: 1000, read: readForLevel(4)
};

/** The work-list query answers with `pages(n)`, the n-th store page (1-based); other queries see no shared key. */
function storePages(t, pages) {
  const seen = [];
  t.mock.method(cosmos, 'query', async (container, spec, opts) => {
    if (spec.query.includes('ARRAY_CONTAINS(@keys')) return { items: [] };
    seen.push(opts.continuationToken);
    return pages(seen.length);
  });
  return seen;
}

async function listPending() {
  const res = makeRes('test');
  await controller.listPending({ params: {}, query: {}, headers: {}, user: { keyId: 'worker' } }, res);
  return JSON.parse(res.body);
}

test('pdf title work list', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.beforeEach((t) => {
    for (const level of ['info', 'warn', 'error']) t.mock.method(logger, level, () => {});
  });

  await t.test('empty store pages behind a continuation answer in one call', async (t) => {
    const logged = t.mock.method(logger, 'info', () => {});
    const seen = storePages(t, n => ({ items: [], continuationToken: n <= 3 ? `page-${n + 1}` : undefined }));
    assert.deepEqual(await listPending(), { items: [], continuation: null });
    assert.deepEqual(seen, [undefined, 'page-2', 'page-3', 'page-4']);
    const lines = logged.mock.calls.filter(c => c.arguments[0] === '[pdf-title] work list');
    assert.equal(lines.length, 1, 'one log line per call');
    assert.equal(lines[0].arguments[1].fetches, 4);
  });

  await t.test('the first store page with work is answered with its continuation', async (t) => {
    const seen = storePages(t, n => ({ items: n === 2 ? [structuredClone(DOC)] : [], continuationToken: `page-${n + 1}` }));
    const body = await listPending();
    assert.deepEqual(body.items.map(i => i.id), [ID]);
    assert.equal(body.continuation, 'page-3');
    assert.equal(seen.length, 2);
  });

  await t.test('a call that reaches the fetch cap answers with a continuation to resume from', async (t) => {
    const seen = storePages(t, n => ({ items: [], continuationToken: `page-${n + 1}` }));
    const body = await listPending();
    assert.equal(seen.length, controller.PENDING_MAX_FETCHES);
    assert.equal(body.continuation, `page-${controller.PENDING_MAX_FETCHES + 1}`);
  });

  await t.test('a slow store stops the call at its time limit with a continuation', async (t) => {
    let clock = 0;
    t.mock.method(Date, 'now', () => clock);
    const seen = storePages(t, n => {
      clock += 15 * 1000;
      return { items: [], continuationToken: `page-${n + 1}` };
    });
    const body = await listPending();
    assert.equal(seen.length, 2, 'the 20 s limit is past after two 15 s fetches');
    assert.equal(body.continuation, 'page-3');
  });
});
