'use strict';

// Legacy `/search` project reads against a project's own dials: a project whose dial hides a sorted,
// filtered or searched field from the caller is left out of the index call, not just redacted after it.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const searchController = require('../../src/controllers/search');
const aiSearch = require('../../src/search/ai-search');
const projectsRepo = require('../../src/repositories/projects');
const updatesRepo = require('../../src/repositories/updates');
const notificationsRepo = require('../../src/repositories/notifications');
const { storedFieldsOf } = require('../../src/vis/catalog/index-projects-renames');
const projectsCatalog = require('../../src/vis/catalog/projects');
const projectsIndex = require('../../azure/search/indexes/projects.json');
const { resolveAccess } = require('../../src/helpers/access-sql');
const { logger } = require('../../src/utils/logger');
const { mockRes } = require('../helpers/mock-res');
const { dialRow, hiddenStore } = require('../helpers/projects-dial-store');
const { updateRow, notificationRow, NOTIFICATION_EAGLE_ID } = require('../helpers/search-reads');

const anonymous = query => ({ query, header: () => null });
const staff = query => ({ query, header: () => null, user: { realm_access: { roles: ['staff'] } } });

const EXCLUSION = /not search\.in\(id, '([^']*)', ','\)/;
const excludedIn = filter => (EXCLUSION.exec(filter || '')?.[1] || '').split(',').filter(Boolean);

const hit = (id, over = {}) => ({ id, name: id, read: ['public'], isPublished: true, ...over });

/** The projects index: answers `hits` minus the ids the filter excludes, and records each call. */
function projectIndex(t, hits) {
  const sent = [];
  t.mock.method(aiSearch, 'searchProjects', async (opts) => {
    sent.push(opts);
    const items = hits.filter(h => !excludedIn(opts.filter).includes(h.id)).slice(0, opts.top);
    return { items, count: items.length };
  });
  return sent;
}

/** One `/search` call as `req` makes it, answered over Cosmos `rows`; returns the response and the index calls. */
async function projectSearch(t, req, rows) {
  hiddenStore(t, rows, resolveAccess(req));
  t.mock.method(projectsRepo, 'listRowsByIds', async () => []);
  const sent = projectIndex(t, rows.map(r => hit(r.id)));
  const res = mockRes();
  await searchController.search(req, res);
  return { res, ids: (res.body[0]?.searchResults || []).map(r => r.id), sent };
}

/** Over the cap: one row past it, each dialled on every field a request here reads. */
const overCap = () => Array.from({ length: projectsRepo.DIAL_HIDDEN_MAX_IDS + 1 }, (_, i) =>
  dialRow(`p${i}`, { name: 2, decisionDate: 2, description: 2 }));

function stubFeed(t) {
  t.mock.method(updatesRepo, 'listTop', async () => [updateRow({ id: 'news-1', eagleId: 'news-1', type: 'News', pinned: false })]);
  t.mock.method(notificationsRepo, 'listDecisions', async () => [notificationRow({
    decision: 'Certificate Issued', decisionDate: '2026-09-07T00:00:00.000Z'
  })]);
}

test('an index column maps to the stored field whose dial governs it', () => {
  const columns = projectsIndex.fields.filter(f => f.filterable || f.sortable).map(f => f.name);
  const searched = aiSearch.PROJECT_SEARCH_FIELDS.split(',');
  for (const column of [...columns, ...searched]) {
    for (const field of storedFieldsOf(column)) {
      assert.ok(Object.hasOwn(projectsCatalog, field), `${column} -> ${field}, which no dial can name`);
    }
  }
  assert.deepStrictEqual(storedFieldsOf('eacDecisionId'), ['eacDecision']);
  assert.deepStrictEqual(storedFieldsOf('currentPhaseNameId'), ['currentPhaseName']);
  assert.deepStrictEqual(storedFieldsOf('legacyEagleId'), ['eagleId']);
  assert.deepStrictEqual(storedFieldsOf('nameTokens'), ['name']);
  // Native `/projects` filters the proponent on `proponentName`; its id is the same fact.
  assert.deepStrictEqual(storedFieldsOf('proponentId').sort(), ['proponentId', 'proponentName']);
});

test('GET /search?dataset=Project under per-project dials', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a sort on a dialled field leaves the project out; without the sort it stays', async () => {
    const rows = [dialRow('open'), dialRow('dialled', { decisionDate: 2 })];

    const sorted = await projectSearch(t, anonymous({ dataset: 'Project', keywords: 'wind', sortBy: '+decisionDate' }), rows);
    assert.deepStrictEqual(sorted.ids, ['open']);
    assert.strictEqual(sorted.res.body[0].count, 1);

    t.mock.restoreAll();
    const unsorted = await projectSearch(t, anonymous({ dataset: 'Project', keywords: 'wind' }), rows);
    assert.deepStrictEqual(unsorted.ids, ['open', 'dialled']);
  });

  await t.test('and[proponent] answers to the proponent name dial and its own', async () => {
    const rows = [dialRow('open'), dialRow('named', { proponentName: 2 }), dialRow('id', { proponentId: 2 })];

    const { ids } = await projectSearch(t, anonymous({ dataset: 'Project', 'and[proponent]': 'org-1' }), rows);

    assert.deepStrictEqual(ids, ['open']);
  });

  await t.test('a keyword leaves out a project whose searched field is dialled', async () => {
    const rows = [dialRow('open'), dialRow('described', { description: 2 }), dialRow('dated', { decisionDate: 2 })];

    const { ids } = await projectSearch(t, anonymous({ dataset: 'Project', keywords: 'wind' }), rows);

    assert.deepStrictEqual(ids, ['open', 'dated']);
  });

  await t.test('the default name order on a filtered list reads the name dial', async () => {
    const rows = [dialRow('open'), dialRow('named', { name: 2 })];

    const { ids, sent } = await projectSearch(t, anonymous({ dataset: 'Project', 'and[region]': 'Cariboo' }), rows);

    assert.match(sent[0].orderby, /^name asc/);
    assert.deepStrictEqual(ids, ['open']);
  });

  await t.test('a staff caller still sees a project dialled at the staff level', async () => {
    const rows = [dialRow('open'), dialRow('dialled', { decisionDate: 2, description: 2 })];

    const { ids } = await projectSearch(t, staff({ dataset: 'Project', keywords: 'wind', sortBy: '+decisionDate' }), rows);

    assert.deepStrictEqual(ids, ['open', 'dialled']);
  });

  await t.test('over the cap the search answers 502', async () => {
    t.mock.method(logger, 'error', () => {});

    const { res, sent } = await projectSearch(t, anonymous({ dataset: 'Project', keywords: 'wind' }), overCap());

    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(sent.length, 0, 'no index call without the exclusion');
  });
});

test('GET /search?dataset=Document leg two under per-project dials', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const documentSearch = async (req, rows) => {
    hiddenStore(t, rows, resolveAccess(req));
    const sent = [];
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => { sent.push(opts); return { items: [], count: 0 }; });
    const res = mockRes();
    await searchController.search(req, res);
    return { res, sent };
  };

  await t.test('a name dial stops the project name matching; a description dial does not', async () => {
    const rows = [dialRow('described', { description: 2 }), dialRow('named', { name: 2 })];

    const { sent } = await documentSearch(anonymous({ dataset: 'Document', keywords: 'wind' }), rows);

    assert.deepStrictEqual(excludedIn(sent[0].projectFilter), ['named']);
  });

  await t.test('over the cap the search answers 502', async () => {
    t.mock.method(logger, 'error', () => {});

    const { res } = await documentSearch(anonymous({ dataset: 'Document', keywords: 'wind' }), overCap());

    assert.strictEqual(res.statusCode, 502);
  });
});

test('GET /search/counts Project badge under per-project dials', async (t) => {
  t.afterEach(() => {
    t.mock.restoreAll();
    searchController.resetCountsCache();
  });

  const counts = async (keywords, rows) => {
    const req = anonymous({ keywords, datasets: 'Project' });
    const pages = hiddenStore(t, rows, resolveAccess(req));
    const sent = [];
    t.mock.method(aiSearch, 'countProjects', async (opts) => { sent.push(opts); return 12; });
    const documents = [];
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => { documents.push(opts); return { items: [], count: 0 }; });
    t.mock.method(aiSearch, 'countActivities', async () => 0);
    t.mock.method(aiSearch, 'countNotifications', async () => 0);
    t.mock.method(updatesRepo, 'count', async () => 0);
    t.mock.method(notificationsRepo, 'count', async () => 0);
    const res = mockRes();
    await searchController.counts(req, res);
    return { res, sent, pages, documents };
  };

  await t.test('a keyword count leaves out a project whose searched field is dialled', async () => {
    const rows = [dialRow('open'), dialRow('named', { name: 2 }), dialRow('described', { description: 2 })];

    const { sent, documents } = await counts('wind', rows);

    assert.deepStrictEqual(excludedIn(sent[0].filter), ['named', 'described']);
    assert.deepStrictEqual(excludedIn(documents[0].projectFilter), ['named'], 'the Documents badge leg two');
  });

  await t.test('a keywordless count reads no dials', async () => {
    const { sent, pages } = await counts('', [dialRow('named', { name: 2 })]);

    assert.deepStrictEqual(excludedIn(sent[0].filter), []);
    assert.strictEqual(pages.length, 0);
  });

  await t.test('over the cap the badge is unknown, not a number', async () => {
    t.mock.method(logger, 'error', () => {});

    const { res } = await counts('wind', overCap());

    assert.strictEqual(res.body[0].counts.Project, null);
    assert.deepStrictEqual(res.body[0].meta[0].unavailable, ['Project']);
  });
});

test('GET /search?dataset=HomeFeed decisions under per-project dials', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const feed = async (rows, hits, pageSize = '3') => {
    const req = anonymous({ dataset: 'HomeFeed', pageSize });
    hiddenStore(t, rows, resolveAccess(req));
    stubFeed(t);
    const sent = projectIndex(t, hits);
    const res = mockRes();
    await searchController.search(req, res);
    return { res, rows: res.body[0]?.searchResults || [], sent };
  };

  await t.test('a dialled decision does not use up a slot', async () => {
    const hits = [
      hit('dialled', { decisionDate: '2026-09-09T00:00:00Z', vis: JSON.stringify({ decisionDate: 2 }) }),
      hit('open', { decisionDate: '2026-09-08T00:00:00Z' })
    ];

    const { rows } = await feed([dialRow('dialled', { decisionDate: 2 }), dialRow('open')], hits, '1');

    assert.deepStrictEqual(rows.map(r => `${r.kind}:${r.id}`), ['decision:open']);
  });

  await t.test('over the cap the feed still serves news and notification decisions', async () => {
    const error = t.mock.method(logger, 'error', () => {});

    const { res, rows, sent } = await feed(overCap(), [hit('open', { decisionDate: '2026-09-08T00:00:00Z' })]);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(rows.map(r => `${r.kind}:${r.id}`), [`decision:${NOTIFICATION_EAGLE_ID}`, 'update:news-1']);
    assert.strictEqual(sent.length, 0);
    assert.ok(error.mock.callCount() >= 1);
  });

  await t.test('any other failure of the decisions read is a 502', async () => {
    t.mock.method(logger, 'error', () => {});
    stubFeed(t);
    t.mock.method(aiSearch, 'searchProjects', async () => { throw new Error('index down'); });
    const res = mockRes();

    await searchController.search(anonymous({ dataset: 'HomeFeed', pageSize: '3' }), res);

    assert.strictEqual(res.statusCode, 502);
  });
});
