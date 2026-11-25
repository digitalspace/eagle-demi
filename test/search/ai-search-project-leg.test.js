'use strict';

process.env.NODE_ENV = 'test';
process.env.SEARCH_ENDPOINT = 'https://demi-search-test.search.windows.net';

const test = require('node:test');
const assert = require('node:assert');

const aiSearch = require('../../src/search/ai-search');
const { filterFor } = require('../../src/helpers/access-odata');
const { TIER } = require('../../src/helpers/access-sql');
const { captureFetch, stubToken } = require('../helpers/capture-fetch');

stubToken();

// More matching projects than one service page, so leg two must page to see them all.
const PROJECT_IDS = Array.from({ length: 260 }, (_, n) => `p${String(n).padStart(3, '0')}`);
// Staff also see these. They hold no documents and rank first, as unpublished drafts can.
const STAFF_ONLY_IDS = ['s0', 's1', 's2', 's3', 's4'];
const DOCS_PER_PROJECT = 2;
const DIRECT_COUNT = 3;

const projectFilterFor = (roles, tier) =>
  filterFor({ tier, roles, projectScope: null, teams: [] }, 'id').filter;
const ANON_PROJECTS = projectFilterFor(['public'], TIER.PUBLIC);
const STAFF_PROJECTS = projectFilterFor(['public', 'staff'], TIER.PRIVILEGED);

const projectCalls = calls => calls.filter(c => c.url.includes('/indexes/projects/'));
const scopeOf = filter => /search\.in\(projectId, '([^']*)'/.exec(filter)[1].split(',');
const scopedIds = calls => scopeOf(calls.find(c => c.body.search === '*').body.filter);

// Relevance order shifts with each request's offset, as tied scores can on the service; only
// `orderby: 'id asc'` is stable. Documents answer by their `search.in` project scope.
function serve(t) {
  let calls;
  calls = captureFetch(t, (i) => {
    const { url, body } = calls[i];
    let rows;
    if (url.includes('/indexes/projects/')) {
      const visible = body.filter.includes('staff') ? [...STAFF_ONLY_IDS, ...PROJECT_IDS] : PROJECT_IDS;
      const shift = ((body.skip || 0) * 37) % visible.length;
      rows = body.orderby === 'id asc'
        ? [...visible].sort()
        : [...visible.slice(shift), ...visible.slice(0, shift)];
    } else if (body.search !== '*') {
      rows = Array.from({ length: DIRECT_COUNT }, (_, n) => `d${n}`);
    } else {
      rows = scopeOf(body.filter).filter(id => PROJECT_IDS.includes(id))
        .flatMap(id => Array.from({ length: DOCS_PER_PROJECT }, (_, n) => `${id}-doc${n}`));
    }
    const skip = body.skip || 0;
    return {
      json: { value: rows.slice(skip, skip + body.top).map(id => ({ id })), '@odata.count': rows.length }
    };
  });
  return calls;
}

const search = projectFilter =>
  aiSearch.searchDocuments({ filter: null, projectFilter, keywords: 'mine', top: 10 });

test('leg two scopes documents to every matching project, not the first page of them', async (t) => {
  const calls = serve(t);
  const res = await search(ANON_PROJECTS);

  assert.deepStrictEqual([...scopedIds(calls)].sort(), PROJECT_IDS);
  assert.strictEqual(res.count, DIRECT_COUNT + PROJECT_IDS.length * DOCS_PER_PROJECT);
});

test('leg two pages projects by id, so reshuffled relevance ties cannot drop one', async (t) => {
  const calls = serve(t);
  await search(ANON_PROJECTS);

  assert.ok(projectCalls(calls).length > 1, 'the matches span more than one request');
  assert.ok(projectCalls(calls).every(c => c.body.orderby === 'id asc'),
    'a relevance order reshuffles ties between requests, and a skip then loses ids');
  assert.deepStrictEqual([...scopedIds(calls)].sort(), PROJECT_IDS);
});

test('staff, who see more projects, never get a smaller document total than anonymous',
  async (t) => {
    serve(t);
    const anon = await search(ANON_PROJECTS);
    const staff = await search(STAFF_PROJECTS);

    assert.strictEqual(staff.count, anon.count);
  });
