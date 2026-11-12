'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const documentsRepo = require('../../src/repositories/documents');
const worker = require('../../src/jobs/bulk-download');
const controller = require('../../src/controllers/nosql/bulk-download');

// Contract between the `listByIdsUnscoped` projection allowlist and its two callers. The
// bulk-download suites mock this read, so only this file catches a caller asking a forbidden field.

const access = { authenticated: false, roles: ['public'], credentials: [], teams: [] };

test('listByIdsUnscoped projection allowlist', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  for (const [name, select] of [
    ['the worker manifest', worker.DOCUMENT_FIELDS],
    ['the controller size read', controller.MANIFEST_SELECT]
  ]) {
    await t.test(`${name} is accepted and reaches Cosmos as written`, async () => {
      let spec = null;
      t.mock.method(cosmos, 'query', async (container, querySpec) => { spec = querySpec; return { items: [] }; });

      await documentsRepo.listByIdsUnscoped(access, ['d1'], select);

      assert.ok(spec, 'the read must reach the query layer');
      assert.match(spec.query, new RegExp(`^SELECT ${select.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} FROM`));
    });
  }

  for (const select of ['*', 'c.id, c.read', 'c.id) OR true --']) {
    await t.test(`"${select}" is refused before any Cosmos call`, async () => {
      let called = false;
      t.mock.method(cosmos, 'query', async () => { called = true; return { items: [] }; });

      await assert.rejects(
        () => documentsRepo.listByIdsUnscoped(access, ['d1'], select),
        /projection not allowed here/
      );
      assert.strictEqual(called, false);
    });
  }
});
