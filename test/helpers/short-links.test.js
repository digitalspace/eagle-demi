'use strict';

/**
 * The project short link is minted by jobs, not by a request, so the repository is an in-memory
 * fake and every assertion is on what the job was ASKED to write.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  CUSTOM_CODE, generateCode, shortUrlFor, slugify, ensureProjectShortLink, carryShortLink,
  projectTarget, isWrongHostDefault, releaseCreatedCode, repointProjectLinks, claimCode
} = require('../../src/helpers/short-links');
const config = require('../../src/config');
const { logger } = require('../../src/utils/logger');

/**
 * The two repositories a project link reaches, in memory. `ids` are link records already stored,
 * `owners` maps a code to the project ids claiming it. Stored records carry an `_etag` that every
 * write bumps, and a write handed a stale one throws 412, as Cosmos does.
 */
function fakeRepos(onCreate, { ids = {}, owners = {} } = {}) {
  const created = [];
  const removed = [];
  const repointed = [];
  const stored = new Map(Object.entries(ids));
  let calls = 0;
  let revision = 0;
  const guard = (id, etag) => {
    if (etag && (stored.get(id) || {})._etag !== etag) throw preconditionFailed();
  };
  return {
    created,
    removed,
    repointed,
    stored,
    links: {
      create: async (record) => {
        if (onCreate) await onCreate(record, calls++);
        if (stored.has(record.id)) throw conflict();
        created.push(record);
        const saved = { ...record, _etag: `"${++revision}"` };
        stored.set(record.id, saved);
        return saved;
      },
      getById: async (id) => stored.get(id) || null,
      repoint: async (id, url, { etag, claimedBy } = {}) => {
        if (!stored.has(id)) return null;
        guard(id, etag);
        repointed.push({ id, url, etag });
        const saved = { ...stored.get(id), url, ...(claimedBy ? { claimedBy } : {}), _etag: `"${++revision}"` };
        stored.set(id, saved);
        return saved;
      },
      remove: async (id, { etag } = {}) => {
        if (!stored.has(id)) return false;
        guard(id, etag);
        removed.push({ id, etag });
        stored.delete(id);
        return true;
      }
    },
    projects: { listShortCodeOwners: async (code) => owners[code] || [] }
  };
}

/** What Cosmos throws for a duplicate id. */
const conflict = () => Object.assign(new Error('Conflict'), { code: 409 });
/** What Cosmos throws when an IfMatch etag no longer matches. */
const preconditionFailed = () => Object.assign(new Error('Precondition Failed'), { code: 412 });

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
    const repos = fakeRepos(null, {
      ids: { 'nicomen-wind-energy': { id: 'nicomen-wind-energy', url, createdBy: 'system' } }
    });

    assert.strictEqual(await ensureProjectShortLink(project, repos), 'nicomen-wind-energy',
      'a write that failed after its link landed must not push the retry to -2');
    assert.deepStrictEqual(repos.created, []);
  });

  await t.test('a record at the same page that another project claims is not adopted', async () => {
    const project = PROJECT();
    const url = `${config.linkBaseUrl}/p/${project.eagleId}`;
    const repos = fakeRepos(null, {
      ids: { 'nicomen-wind-energy': { id: 'nicomen-wind-energy', url } },
      owners: { 'nicomen-wind-energy': ['208'] }
    });

    assert.strictEqual(await ensureProjectShortLink(project, repos), 'nicomen-wind-energy-2');
  });

  await t.test('a record only this project holds is adopted, even at another url', async () => {
    const project = PROJECT();
    const repos = fakeRepos(null, {
      ids: { 'nicomen-wind-energy': { id: 'nicomen-wind-energy', url: 'https://projects.eao.gov.bc.ca/p/moved' } },
      owners: { 'nicomen-wind-energy': ['207'] }
    });

    assert.strictEqual(await ensureProjectShortLink(project, repos), 'nicomen-wind-energy',
      'the code is already this project\'s; the url check is for codes nobody holds');
    assert.deepStrictEqual(repos.created, []);
    const record = repos.stored.get('nicomen-wind-energy');
    assert.deepStrictEqual([record.url, record.claimedBy], [projectTarget(project), '207'],
      'the adopted record follows the project');
  });

  await t.test('an unheld record another staff member wrote is not adopted', async () => {
    const project = PROJECT();
    const url = `${config.linkBaseUrl}/p/${project.eagleId}`;
    const repos = fakeRepos(null, {
      ids: { 'nicomen-wind-energy': { id: 'nicomen-wind-energy', url, createdBy: 'alice' } }
    });

    assert.strictEqual(await ensureProjectShortLink(project, repos), 'nicomen-wind-energy-2',
      'a shared link alice made at the page is hers, not a leftover of a project write');
    assert.strictEqual(await claimCode(project, 'nicomen-wind-energy', repos, { createdBy: 'bob' }), false);
    assert.strictEqual(await claimCode(project, 'nicomen-wind-energy', repos, { createdBy: 'alice' }), true,
      'the staff member who wrote it may take it onto the project');
  });

  await t.test('an unheld record at `alsoUrl` is adopted and moved to the target', async () => {
    const project = { ...PROJECT(), shortLinkUrl: 'https://www.projects.eao.gov.bc.ca/nicomen' };
    const page = `${config.linkBaseUrl}/p/${project.eagleId}`;
    const repos = fakeRepos(null, {
      ids: { 'site-c': { id: 'site-c', url: page, createdBy: 'system', _etag: '"s1"' } }
    });

    assert.strictEqual(await claimCode(project, 'site-c', repos), false, 'the premise: not at the target');
    assert.strictEqual(await claimCode(project, 'site-c', repos, { alsoUrl: page }), true);
    assert.strictEqual(repos.stored.get('site-c').url, project.shortLinkUrl);
  });

  await t.test('the project\'s Eagle-only twin holding the code counts as the project', async () => {
    const project = PROJECT();
    const repos = fakeRepos(null, {
      ids: { 'nicomen-wind-energy': { id: 'nicomen-wind-energy', url: 'https://projects.eao.gov.bc.ca/p/moved' } },
      owners: { 'nicomen-wind-energy': ['207', 'eagle-58851172aaecd9001b820335'] }
    });

    assert.strictEqual(await ensureProjectShortLink(project, repos), 'nicomen-wind-energy');
  });

  await t.test('a record this project holds beside another project is not adopted', async () => {
    const project = PROJECT();
    const url = `${config.linkBaseUrl}/p/${project.eagleId}`;
    const repos = fakeRepos(null, {
      ids: { 'nicomen-wind-energy': { id: 'nicomen-wind-energy', url } },
      owners: { 'nicomen-wind-energy': ['207', '208'] }
    });

    assert.strictEqual(await ensureProjectShortLink(project, repos), 'nicomen-wind-energy-2');
  });

  await t.test('a staff member\'s personal link at the project page is never adopted', async () => {
    const project = PROJECT();
    const url = `${config.linkBaseUrl}/p/${project.eagleId}`;
    const personal = { id: 'nicomen-wind-energy', url, personal: true, createdBy: 'alice' };
    const repos = fakeRepos(null, { ids: { 'nicomen-wind-energy': personal } });

    assert.strictEqual(await ensureProjectShortLink(project, repos), 'nicomen-wind-energy-2',
      'adopting it would lock alice out of her own link');
    assert.strictEqual(repos.stored.get('nicomen-wind-energy'), personal);
  });

  await t.test('an unheld record is adopted only at the project\'s custom target', async () => {
    const custom = 'https://www.projects.eao.gov.bc.ca/nicomen';
    const project = { ...PROJECT(), shortLinkUrl: custom };
    const repos = fakeRepos(null, {
      ids: {
        'nicomen-wind-energy': { id: 'nicomen-wind-energy', url: `${config.linkBaseUrl}/p/${project.eagleId}` },
        'nicomen-wind-energy-2': { id: 'nicomen-wind-energy-2', url: custom, createdBy: 'system' }
      }
    });

    assert.strictEqual(await ensureProjectShortLink(project, repos), 'nicomen-wind-energy-2',
      'the default page is not where this project\'s codes point any more');
  });

  await t.test('a new code points at the project\'s custom target', async () => {
    const custom = 'https://www.projects.eao.gov.bc.ca/nicomen';
    const project = { ...PROJECT(), shortLinkUrl: custom };
    const repos = fakeRepos();

    await ensureProjectShortLink(project, repos);

    assert.strictEqual(repos.created[0].url, custom);
  });

  await t.test('the attempt records the code it created, and nothing when it adopted', async () => {
    const created = {};
    await ensureProjectShortLink(PROJECT(), fakeRepos(), created);
    assert.deepStrictEqual(created.created, { code: 'nicomen-wind-energy', etag: '"1"' });

    const adopted = { created: { code: 'stale', etag: '"9"' } };
    const url = `${config.linkBaseUrl}/p/58851172aaecd9001b820335`;
    await ensureProjectShortLink(PROJECT(),
      fakeRepos(null, { ids: { 'nicomen-wind-energy': { id: 'nicomen-wind-energy', url, createdBy: 'system' } } }),
      adopted);
    assert.strictEqual(adopted.created, null, 'a record this attempt did not write is not its to remove');
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

test('carryShortLink carries the custom target across a whole-item write', () => {
  const target = carryShortLink({ id: '207' }, { shortCode: 'nicomen', shortLinkUrl: 'https://x.gov.bc.ca/n' });
  assert.strictEqual(target.shortLinkUrl, 'https://x.gov.bc.ca/n');
});

test('projectTarget is the custom target, else the public page', () => {
  assert.strictEqual(projectTarget(PROJECT()), `${config.linkBaseUrl}/p/58851172aaecd9001b820335`);
  assert.strictEqual(projectTarget({ ...PROJECT(), shortLinkUrl: 'https://x.gov.bc.ca/n' }), 'https://x.gov.bc.ca/n');
});

test('isWrongHostDefault', async (t) => {
  const base = config.linkBaseUrl;
  t.after(() => { config.linkBaseUrl = base; });
  config.linkBaseUrl = 'https://eagle-test.apps.silver.devops.gov.bc.ca';
  const eagleId = '58851172aaecd9001b820335';

  await t.test('the project page on the prod host, on test, is wrong-host', () => {
    assert.strictEqual(isWrongHostDefault(PROJECT(), `https://projects.eao.gov.bc.ca/p/${eagleId}`), true);
  });

  await t.test('the project page on LINK_BASE_URL is not', () => {
    assert.strictEqual(isWrongHostDefault(PROJECT(), `${config.linkBaseUrl}/p/${eagleId}`), false);
  });

  await t.test('another project\'s page, or another path, is never touched', () => {
    assert.strictEqual(isWrongHostDefault(PROJECT(), 'https://projects.eao.gov.bc.ca/p/elsewhere'), false);
    assert.strictEqual(isWrongHostDefault(PROJECT(), `https://projects.eao.gov.bc.ca/p/${eagleId}/docs`), false);
    assert.strictEqual(isWrongHostDefault(PROJECT(), 'not a url'), false);
  });

  await t.test('a project with a custom target is left alone', () => {
    const project = { ...PROJECT(), shortLinkUrl: 'https://x.gov.bc.ca/n' };
    assert.strictEqual(isWrongHostDefault(project, `https://projects.eao.gov.bc.ca/p/${eagleId}`), false);
  });
});

test('releaseCreatedCode', async (t) => {
  t.beforeEach(() => t.mock.method(logger, 'info', () => {}));
  t.afterEach(() => t.mock.restoreAll());

  /** A mint that wrote its slug record, as a sync attempt would before its project write. */
  async function minted(opts) {
    const repos = fakeRepos(null, opts);
    const attempt = {};
    await ensureProjectShortLink(PROJECT(), repos, attempt);
    return { repos, attempt };
  }

  await t.test('removes the record it created, guarded on the etag it wrote', async () => {
    const { repos, attempt } = await minted();

    assert.strictEqual(await releaseCreatedCode(attempt, repos), true);
    assert.deepStrictEqual(repos.removed, [{ id: 'nicomen-wind-energy', etag: '"1"' }]);
    assert.strictEqual(attempt.created, null, 'a second release must not try again');
  });

  await t.test('keeps a code a project holds by now', async () => {
    const { repos, attempt } = await minted({ owners: { 'nicomen-wind-energy': ['208'] } });

    assert.strictEqual(await releaseCreatedCode(attempt, repos), false);
    assert.ok(repos.stored.has('nicomen-wind-energy'));
  });

  await t.test('keeps a record that changed since it was written', async () => {
    const { repos, attempt } = await minted();
    await repos.links.repoint('nicomen-wind-energy', 'https://x.gov.bc.ca/staff');

    assert.strictEqual(await releaseCreatedCode(attempt, repos), false);
    assert.strictEqual(repos.stored.get('nicomen-wind-energy').url, 'https://x.gov.bc.ca/staff');
  });

  await t.test('keeps a record another claim adopted after it was written', async () => {
    const { repos, attempt } = await minted();

    assert.strictEqual(await claimCode(PROJECT(), 'nicomen-wind-energy', repos), true);
    assert.strictEqual(await releaseCreatedCode(attempt, repos), false, 'the adoption moved its etag');
    assert.ok(repos.stored.has('nicomen-wind-energy'));
  });

  await t.test('a release landing between an adoption\'s read and its patch is written again', async () => {
    const { repos, attempt } = await minted();
    const read = repos.links.getById;
    repos.links.getById = async (id) => {
      const record = await read(id);
      await releaseCreatedCode(attempt, repos);
      return record;
    };

    assert.strictEqual(await claimCode(PROJECT(), 'nicomen-wind-energy', repos), true);
    assert.deepStrictEqual(repos.removed.map(r => r.id), ['nicomen-wind-energy'], 'the premise: it was deleted');
    assert.ok(repos.stored.has('nicomen-wind-energy'), 'the claimed code still resolves');
  });

  await t.test('does nothing when the attempt created nothing', async () => {
    const repos = fakeRepos();
    assert.strictEqual(await releaseCreatedCode({ created: null }, repos), false);
    assert.strictEqual(await releaseCreatedCode(undefined, repos), false);
  });
});

test('repointProjectLinks', async (t) => {
  t.beforeEach(() => {
    t.mock.method(logger, 'info', () => {});
    t.mock.method(logger, 'warn', () => {});
  });
  t.afterEach(() => t.mock.restoreAll());

  const custom = 'https://www.projects.eao.gov.bc.ca/nicomen';
  const project = () => ({
    ...PROJECT(), shortCode: 'nicomen-wind-energy', legacyShortCodes: ['kq7bt2rm', 'ab3cd4ef'], shortLinkUrl: custom
  });
  const records = () => ({
    'nicomen-wind-energy': { id: 'nicomen-wind-energy', url: 'https://old/p/1', _etag: '"a"' },
    kq7bt2rm: { id: 'kq7bt2rm', url: 'https://old/p/1', _etag: '"b"' },
    ab3cd4ef: { id: 'ab3cd4ef', url: custom, _etag: '"c"' }
  });

  await t.test('moves the current and every legacy record to the target, each on its etag', async () => {
    const repos = fakeRepos(null, { ids: records() });

    const result = await repointProjectLinks(project(), repos, { by: 'staff.person' });

    assert.deepStrictEqual(result, { repointed: ['nicomen-wind-energy', 'kq7bt2rm'], lost: [] });
    assert.deepStrictEqual(repos.repointed, [
      { id: 'nicomen-wind-energy', url: custom, etag: '"a"' },
      { id: 'kq7bt2rm', url: custom, etag: '"b"' }
    ], 'a record already on target is not written');
    const [, fields] = logger.info.mock.calls[0].arguments;
    assert.deepStrictEqual(fields,
      { projectId: '207', code: 'nicomen-wind-energy', from: 'https://old/p/1', to: custom, by: 'staff.person' });
  });

  await t.test('a record written since it was read is listed lost, and the rest still move', async () => {
    const repos = fakeRepos(null, { ids: records() });
    const read = repos.links.getById;
    repos.links.getById = async (id) => {
      const record = await read(id);
      return id === 'nicomen-wind-energy' ? { ...record, _etag: '"stale"' } : record;
    };

    const result = await repointProjectLinks(project(), repos);

    assert.deepStrictEqual(result, { repointed: ['kq7bt2rm'], lost: ['nicomen-wind-energy'] });
    assert.strictEqual(repos.stored.get('nicomen-wind-energy').url, 'https://old/p/1');
  });

  await t.test('a held code with no record is written again at the target', async () => {
    const ids = records();
    delete ids.kq7bt2rm;
    const repos = fakeRepos(null, { ids });

    const result = await repointProjectLinks(project(), repos, { by: 'staff.person' });

    assert.deepStrictEqual(result, { repointed: ['nicomen-wind-energy', 'kq7bt2rm'], lost: [] });
    assert.deepStrictEqual(repos.created.map(r => [r.id, r.url, r.createdBy]), [['kq7bt2rm', custom, 'staff.person']]);
  });

  await t.test('a missing record that cannot be written again is lost, never skipped', async () => {
    const ids = records();
    delete ids.kq7bt2rm;
    const repos = fakeRepos(() => { throw new Error('links container down'); }, { ids });

    const result = await repointProjectLinks(project(), repos);

    assert.deepStrictEqual(result, { repointed: ['nicomen-wind-energy'], lost: ['kq7bt2rm'] });
    assert.ok(logger.warn.mock.calls.some(c => /could not be recreated/.test(c.arguments[0])));
  });

  await t.test('a record deleted between the read and the patch is written again, or lost under `only`', async () => {
    const vanishing = () => {
      const repos = fakeRepos(null, { ids: records() });
      const read = repos.links.getById;
      repos.links.getById = async (id) => {
        const record = await read(id);
        if (id === 'kq7bt2rm') repos.stored.delete(id);
        return record;
      };
      return repos;
    };

    const plain = vanishing();
    const result = await repointProjectLinks(project(), plain, { by: 'staff.person' });
    assert.deepStrictEqual(result, { repointed: ['nicomen-wind-energy', 'kq7bt2rm'], lost: [] });
    assert.strictEqual(plain.stored.get('kq7bt2rm').url, custom);

    const narrowed = vanishing();
    const healed = await repointProjectLinks(project(), narrowed, { only: () => true });
    assert.deepStrictEqual(healed, { repointed: ['nicomen-wind-energy'], lost: ['kq7bt2rm'] });
    assert.deepStrictEqual(narrowed.created, []);
  });

  await t.test('a heal (`only`) never writes a missing record again', async () => {
    const ids = records();
    delete ids.kq7bt2rm;
    const repos = fakeRepos(null, { ids });

    const result = await repointProjectLinks(project(), repos, { only: () => true });

    assert.deepStrictEqual(result, { repointed: ['nicomen-wind-energy'], lost: [] });
    assert.deepStrictEqual(repos.created, []);
  });

  await t.test('`only` narrows which records move, and personal ones never do', async () => {
    const ids = records();
    ids.kq7bt2rm.personal = true;
    const repos = fakeRepos(null, { ids });

    const result = await repointProjectLinks(project(), repos, { only: (r) => r.id !== 'nicomen-wind-energy' });

    assert.deepStrictEqual(result, { repointed: [], lost: [] });
    assert.deepStrictEqual(repos.repointed, []);
  });
});
