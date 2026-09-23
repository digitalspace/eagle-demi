'use strict';

/**
 * The project short link is minted by jobs, not by a request, so the repository is an in-memory
 * fake and every assertion is on what the job was ASKED to write.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  CUSTOM_CODE, generateCode, shortUrlFor, slugify, ensureProjectShortLink
} = require('../../src/helpers/short-links');
const config = require('../../src/config');
const { logger } = require('../../src/utils/logger');

/**
 * The two repositories a project link reaches, in memory. `ids` are link records already stored,
 * `owners` maps a code to the project ids claiming it.
 */
function fakeRepos(onCreate, { ids = {}, owners = {} } = {}) {
  const created = [];
  const stored = new Map(Object.entries(ids));
  let calls = 0;
  return {
    created,
    links: {
      create: async (record) => {
        if (onCreate) await onCreate(record, calls++);
        if (stored.has(record.id)) throw conflict();
        created.push(record);
        stored.set(record.id, record);
        return record;
      },
      getById: async (id) => stored.get(id) || null
    },
    projects: { listShortCodeOwners: async (code) => owners[code] || [] }
  };
}

/** What Cosmos throws for a duplicate id. */
const conflict = () => Object.assign(new Error('Conflict'), { code: 409 });

/** Link records under these ids already point somewhere else. */
function takenRepos(taken) {
  return fakeRepos(null, {
    ids: Object.fromEntries(taken.map(id => [id, { id, url: 'https://projects.eao.gov.bc.ca/p/elsewhere' }]))
  });
}

const RANDOM = /^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/;

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

test('slugify', async (t) => {
  const REVELSTOKE = 'Revelstoke Sand and Gravel Pits Expansion Project and Columbia River Reclamation Plans';
  const cases = [
    ['Site C Clean Energy', 'site-c-clean-energy'],
    ['Tsilhqot\'in Power Development', 'tsilhqotin-power-development'],
    ['Tsilhqot\u2019in Power Development', 'tsilhqotin-power-development'],
    ['Tom MacKay Lake Waste Rock & Tailings', 'tom-mackay-lake-waste-rock-and-tailings'],
    // 42 characters; the cut falls on the last word boundary inside 40.
    ['Cougar South/Main Pits and West Spoil Coal', 'cougar-south-main-pits-and-west-spoil'],
    [REVELSTOKE, 'revelstoke-sand-and-gravel-pits'],
    ['Caf\u00e9 \u00c9lan Mine', 'cafe-elan-mine'],
    ['  --Ruby Creek--  ', 'ruby-creek'],
    ['Abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstu', 'abcdefghijklmnopqrstuvwxyzabcdefghijklmn']
  ];
  for (const [name, slug] of cases) {
    await t.test(`${JSON.stringify(name)} -> ${slug}`, () => {
      assert.strictEqual(slugify(name), slug);
      assert.match(slug, CUSTOM_CODE, 'the resolver has to accept it');
      assert.ok(slug.length <= 40);
    });
  }

  await t.test('the Revelstoke premise: the name is over the cap', () => {
    assert.strictEqual(REVELSTOKE.length, 86);
  });

  for (const name of ['', 'A', '-', '??', null]) {
    await t.test(`${JSON.stringify(name)} is too short to be a code`, () => {
      assert.strictEqual(slugify(name), null);
    });
  }
});

test('ensureProjectShortLink', async (t) => {
  await t.test('mints one link at the project\'s public page and stamps the code on', async () => {
    const project = PROJECT();
    const repos = fakeRepos();

    const code = await ensureProjectShortLink(project, repos);

    assert.strictEqual(repos.created.length, 1);
    const [record] = repos.created;
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
    const repos = fakeRepos();

    const first = await ensureProjectShortLink(project, repos);
    const second = await ensureProjectShortLink(project, repos);

    assert.strictEqual(second, first, 'a printed link must survive the next nightly run');
    assert.strictEqual(repos.created.length, 1);
  });

  await t.test('a project with no Eagle id has no public page, so no link', async () => {
    const project = { id: '412', name: 'Track only', eagleId: null };
    const repos = fakeRepos();

    assert.strictEqual(await ensureProjectShortLink(project, repos), null);
    assert.deepStrictEqual(repos.created, []);
    assert.strictEqual(project.shortCode, undefined);
  });

  await t.test('the code is the name slug', async () => {
    const project = PROJECT();
    const repos = fakeRepos();

    assert.strictEqual(await ensureProjectShortLink(project, repos), 'nicomen-wind-energy');
    assert.strictEqual(project.shortCodeSource, 'name');
  });

  await t.test('a taken slug is suffixed -2, -3 ...', async () => {
    const project = PROJECT();
    const repos = takenRepos(['nicomen-wind-energy', 'nicomen-wind-energy-2']);

    assert.strictEqual(await ensureProjectShortLink(project, repos), 'nicomen-wind-energy-3');
    assert.deepStrictEqual(repos.created.map(l => l.id), ['nicomen-wind-energy-3']);
  });

  await t.test('the project\'s own orphaned record under its slug is adopted', async () => {
    const project = PROJECT();
    const url = `${config.linkBaseUrl}/p/${project.eagleId}`;
    const repos = fakeRepos(null, { ids: { 'nicomen-wind-energy': { id: 'nicomen-wind-energy', url } } });

    assert.strictEqual(await ensureProjectShortLink(project, repos), 'nicomen-wind-energy',
      'a write that failed after its link landed must not push the retry to -2');
    assert.deepStrictEqual(repos.created, []);
  });

  await t.test('a record at the same page that another project claims is not adopted', async () => {
    const project = PROJECT();
    const url = `${config.linkBaseUrl}/p/${project.eagleId}`;
    const repos = fakeRepos(null, {
      ids: { 'nicomen-wind-energy': { id: 'nicomen-wind-energy', url } },
      owners: { 'nicomen-wind-energy': ['eagle-58851172aaecd9001b820335'] }
    });

    assert.strictEqual(await ensureProjectShortLink(project, repos), 'nicomen-wind-energy-2');
  });

  await t.test('a legacy code already listed is not listed twice', async (t) => {
    const project = { ...PROJECT(), shortCode: 'kq7bt2rm', legacyShortCodes: ['kq7bt2rm'] };
    t.mock.method(logger, 'info', () => {});

    await ensureProjectShortLink(project, fakeRepos());

    assert.deepStrictEqual(project.legacyShortCodes, ['kq7bt2rm']);
  });

  await t.test('a slug taken through -5 falls back to a random code', async (t) => {
    const project = PROJECT();
    const taken = ['', '-2', '-3', '-4', '-5'].map(s => `nicomen-wind-energy${s}`);
    const repos = takenRepos(taken);
    const warn = t.mock.method(logger, 'warn', () => {});

    const code = await ensureProjectShortLink(project, repos);

    assert.match(code, RANDOM);
    assert.strictEqual(project.shortCodeSource, 'random');
    assert.strictEqual(warn.mock.callCount(), 1, 'the fallback is logged');
  });

  await t.test('a name too short for a slug gets a random code', async () => {
    const project = { ...PROJECT(), name: 'A' };

    assert.match(await ensureProjectShortLink(project, fakeRepos()), RANDOM);
    assert.strictEqual(project.shortCodeSource, 'random');
  });

  await t.test('a pre-slug random code moves to legacyShortCodes', async (t) => {
    const project = { ...PROJECT(), shortCode: 'kq7bt2rm' };
    const repos = fakeRepos();
    const info = t.mock.method(logger, 'info', () => {});

    assert.strictEqual(await ensureProjectShortLink(project, repos), 'nicomen-wind-energy');
    assert.deepStrictEqual(project.legacyShortCodes, ['kq7bt2rm']);
    assert.strictEqual(project.shortCodeSource, 'name');
    assert.deepStrictEqual(repos.created.map(l => l.id), ['nicomen-wind-energy']);
    assert.strictEqual(info.mock.callCount(), 1, 'the migration is logged');
  });

  await t.test('a migrated project is not migrated again', async () => {
    const project = { ...PROJECT(), shortCode: 'kq7bt2rm' };
    await ensureProjectShortLink(project, fakeRepos());
    const repos = fakeRepos();

    assert.strictEqual(await ensureProjectShortLink(project, repos), 'nicomen-wind-energy');
    assert.deepStrictEqual(repos.created, []);
    assert.deepStrictEqual(project.legacyShortCodes, ['kq7bt2rm']);
  });

  await t.test('a legacy code with no free slug is kept, not swapped for another random one', async (t) => {
    const project = { ...PROJECT(), shortCode: 'kq7bt2rm' };
    const taken = ['', '-2', '-3', '-4', '-5'].map(s => `nicomen-wind-energy${s}`);
    t.mock.method(logger, 'warn', () => {});

    assert.strictEqual(await ensureProjectShortLink(project, takenRepos(taken)), 'kq7bt2rm');
    assert.strictEqual(project.shortCodeSource, 'random', 'so the next night does not retry');
    assert.strictEqual(project.legacyShortCodes, undefined);
  });

  await t.test('a staff code is never migrated, however random it looks', async () => {
    const project = { ...PROJECT(), shortCode: 'kemess23', shortCodeSource: 'staff' };
    const repos = fakeRepos();

    assert.strictEqual(await ensureProjectShortLink(project, repos), 'kemess23');
    assert.deepStrictEqual(repos.created, []);
  });

  await t.test('a slug, once set, does not follow a rename', async () => {
    const project = PROJECT();
    await ensureProjectShortLink(project, fakeRepos());
    project.name = 'Nicomen Wind Energy Phase Two';

    assert.strictEqual(await ensureProjectShortLink(project, fakeRepos()), 'nicomen-wind-energy');
  });

  await t.test('a random code Cosmos already holds is retried once', async () => {
    const project = { ...PROJECT(), name: 'A' };
    const repos = fakeRepos((_record, calls) => {
      if (calls === 0) {
        const err = new Error('Conflict');
        err.code = 409;
        throw err;
      }
    });

    const code = await ensureProjectShortLink(project, repos);

    assert.strictEqual(repos.created.length, 1, 'the losing code is not stored');
    assert.strictEqual(repos.created[0].id, code);
    assert.strictEqual(project.shortCode, code);
  });

  await t.test('any other write failure is raised, not swallowed into a codeless project', async () => {
    const project = PROJECT();
    const repos = fakeRepos(() => { throw new Error('links container not configured'); });

    await assert.rejects(() => ensureProjectShortLink(project, repos), /not configured/);
    assert.strictEqual(project.shortCode, undefined,
      'a project must never carry a code with no link behind it');
  });
});
