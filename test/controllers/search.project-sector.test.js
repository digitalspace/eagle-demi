'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const searchController = require('../../src/controllers/search');
const aiSearch = require('../../src/search/ai-search');
const projectsRepo = require('../../src/repositories/projects');

// A Track-only project has no Eagle `sector`; the list and the filter panel show Track's sub-type in
// its place, in eagle-admin's vocabulary, and 'Other' only when neither exists.

async function sectors(query) {
  let body;
  const res = { json: (data) => { body = data; return res; }, status: () => res };
  await searchController.search({ query: { dataset: 'Project', ...query }, header: () => null }, res);
  return body[0].searchResults.map(p => [p.id, p.sector]);
}

const PUBLIC = { read: ['public'], isPublished: true };

test('Project sector falls back to the Track sub-type', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('Cosmos list: sub-type named for the legislation year, Eagle sector first', async () => {
    const rows = [
      { id: 'a', sector: 'Mining', projectSubType: 'Coal Mines', ...PUBLIC },
      { id: 'b', sector: '', projectSubType: 'Transmission Lines', ...PUBLIC },
      { id: 'c', projectSubType: 'Solid Waste Management Facilities', legislationYear: 2002, ...PUBLIC },
      { id: 'd', projectSubType: 'Solid Waste Management Facilities',
        legislation: '2018 Environmental Assessment Act', ...PUBLIC },
      { id: 'e', projectSubType: '  ', ...PUBLIC }
    ];
    t.mock.method(projectsRepo, 'listVisible', async () => ({ items: rows }));
    t.mock.method(projectsRepo, 'countVisible', async () => rows.length);

    assert.deepStrictEqual(await sectors({ pageSize: '10' }), [
      ['a', 'Mining'],
      ['b', 'Electric Transmission Lines'],
      ['c', 'Local Government Solid Waste Management Facilities'],
      ['d', 'Solid Waste Management'],
      ['e', 'Other']
    ]);
  });

  await t.test('AI Search: sub-type from the index row, 2018 name with no year', async () => {
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 4,
      items: [
        { id: 'a', sector: 'Mining', projectSubType: 'Coal Mines', read: ['public'] },
        { id: 'b', sector: null, projectSubType: 'Transmission Lines', read: ['public'] },
        { id: 'c', projectSubType: 'Solid Waste Management Facilities', read: ['public'] },
        { id: 'd', projectSubType: null, read: ['public'] }
      ]
    }));

    assert.deepStrictEqual(await sectors({ keywords: 'mine', pageSize: '10' }), [
      ['a', 'Mining'],
      ['b', 'Electric Transmission Lines'],
      ['c', 'Solid Waste Management'],
      ['d', 'Other']
    ]);
  });
});
