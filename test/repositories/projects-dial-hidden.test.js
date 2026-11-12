'use strict';

// `projects.listDialHiddenIds` against an in-memory container that evaluates the SQL it sends.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const projects = require('../../src/repositories/projects');
const { logger } = require('../../src/utils/logger');
const { resolveAccess, TIER } = require('../../src/helpers/access-sql');
const { dialRow: row, hiddenStore } = require('../helpers/projects-dial-store');

const anonymous = () => resolveAccess({});
const STAFF = { tier: TIER.PRIVILEGED, roles: ['staff'], projectScope: null, teams: [], level: 2 };

test('projects.listDialHiddenIds', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a decisionDate dial of 2 hides the row from an anonymous caller, not from level 2', async () => {
    const rows = [row('open'), row('dialled', { decisionDate: 2 }), row('other', { name: 2 })];

    hiddenStore(t, rows, anonymous());
    assert.deepStrictEqual(await projects.listDialHiddenIds(anonymous(), ['decisionDate']), ['dialled']);

    t.mock.restoreAll();
    hiddenStore(t, rows, STAFF);
    assert.deepStrictEqual(await projects.listDialHiddenIds(STAFF, ['decisionDate']), []);
  });

  await t.test('a row is hidden when any one of the fields is dialled', async () => {
    hiddenStore(t, [row('open'), row('named', { name: 3 }), row('dated', { decisionDate: 1 })], anonymous());

    const ids = await projects.listDialHiddenIds(anonymous(), ['name', 'decisionDate']);

    assert.deepStrictEqual(ids, ['named', 'dated']);
  });

  await t.test('no field to check reads nothing', async () => {
    const pages = hiddenStore(t, [row('named', { name: 1 })], anonymous());

    assert.deepStrictEqual(await projects.listDialHiddenIds(anonymous(), []), []);
    assert.strictEqual(pages.length, 0);
  });

  await t.test('reads one past the cap and throws over it, with a code and a log line', async () => {
    const many = Array.from({ length: projects.DIAL_HIDDEN_MAX_IDS + 1 }, (_, i) => row(String(i), { name: 1 }));
    const pages = hiddenStore(t, many, anonymous());
    const error = t.mock.method(logger, 'error', () => {});

    await assert.rejects(() => projects.listDialHiddenIds(anonymous(), ['name']),
      err => err.code === projects.DIAL_HIDDEN_OVER_CAP);
    assert.deepStrictEqual(pages[0].options, { size: projects.DIAL_HIDDEN_MAX_IDS + 1 });
    assert.strictEqual(error.mock.callCount(), 1);
  });

  await t.test('exactly the cap is answered whole', async () => {
    const atCap = Array.from({ length: projects.DIAL_HIDDEN_MAX_IDS }, (_, i) => row(String(i), { name: 1 }));
    hiddenStore(t, atCap, anonymous());

    const ids = await projects.listDialHiddenIds(anonymous(), ['name']);

    assert.strictEqual(ids.length, projects.DIAL_HIDDEN_MAX_IDS);
  });
});
