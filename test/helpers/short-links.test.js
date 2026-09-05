'use strict';

/**
 * The project short link is minted by jobs, not by a request, so the repository is an in-memory
 * fake and every assertion is on what the job was ASKED to write.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  generateCode, shortUrlFor, ensureProjectShortLink
} = require('../../src/helpers/short-links');
const config = require('../../src/config');

/** The links repository, in memory. `create` is the only call a project link makes. */
function fakeLinks(onCreate) {
  const created = [];
  let calls = 0;
  return {
    created,
    create: async (record) => {
      if (onCreate) await onCreate(record, calls++);
      created.push(record);
      return record;
    }
  };
}

const PROJECT = () => ({ id: '207', name: 'Nicomen Wind Energy', eagleId: '58851172aaecd9001b820335' });

test('generateCode', async (t) => {
  await t.test('is 8 characters of the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      assert.match(generateCode(), /^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/,
        'a code a reader has to guess a glyph in is a dead printed link');
    }
  });

  await t.test('does not repeat itself', () => {
    const codes = new Set(Array.from({ length: 500 }, generateCode));
    assert.ok(codes.size > 490, `only ${codes.size} distinct codes in 500`);
  });
});

test('shortUrlFor composes the public form of a code', () => {
  assert.strictEqual(shortUrlFor('kq7bt2rm'), `${config.linkBaseUrl}/s/kq7bt2rm`);
});

test('ensureProjectShortLink', async (t) => {
  await t.test('mints one link at the project\'s public page and stamps the code on', async () => {
    const project = PROJECT();
    const links = fakeLinks();

    const code = await ensureProjectShortLink(project, links);

    assert.strictEqual(links.created.length, 1);
    const [record] = links.created;
    assert.strictEqual(record.id, code);
    assert.strictEqual(project.shortCode, code, 'the caller upserts the project it was handed');
    assert.strictEqual(record.url, `${config.linkBaseUrl}/p/${project.eagleId}`);
    assert.strictEqual(record.note, 'Nicomen Wind Energy');
    assert.strictEqual(record.personal, false, 'a project link is not one person\'s');
    assert.strictEqual(record.createdBy, 'system');
    assert.strictEqual(record.updatedAt, null);
    assert.match(record.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  await t.test('a second call reuses the code, and writes nothing', async () => {
    const project = PROJECT();
    const links = fakeLinks();

    const first = await ensureProjectShortLink(project, links);
    const second = await ensureProjectShortLink(project, links);

    assert.strictEqual(second, first, 'a printed link must survive the next nightly run');
    assert.strictEqual(links.created.length, 1);
  });

  await t.test('a project with no Eagle id has no public page, so no link', async () => {
    const project = { id: '412', name: 'Track only', eagleId: null };
    const links = fakeLinks();

    assert.strictEqual(await ensureProjectShortLink(project, links), null);
    assert.deepStrictEqual(links.created, []);
    assert.strictEqual(project.shortCode, undefined);
  });

  await t.test('a code Cosmos already holds is retried once', async () => {
    const project = PROJECT();
    const links = fakeLinks((_record, calls) => {
      if (calls === 0) {
        const err = new Error('Conflict');
        err.code = 409;
        throw err;
      }
    });

    const code = await ensureProjectShortLink(project, links);

    assert.strictEqual(links.created.length, 1, 'the losing code is not stored');
    assert.strictEqual(links.created[0].id, code);
    assert.strictEqual(project.shortCode, code);
  });

  await t.test('any other write failure is raised, not swallowed into a codeless project', async () => {
    const project = PROJECT();
    const links = fakeLinks(() => { throw new Error('links container not configured'); });

    await assert.rejects(() => ensureProjectShortLink(project, links), /not configured/);
    assert.strictEqual(project.shortCode, undefined,
      'a project must never carry a code with no link behind it');
  });
});
