'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const searchController = require('../../src/controllers/search');
const aiSearch = require('../../src/search/ai-search');
const projectsRepo = require('../../src/repositories/projects');

// A Track-only project has no Eagle `sector`; the displayed `sector` shows Track's sub-type in its
// place, in eagle-admin's vocabulary, and 'Other' only when neither exists. Display only:
// `and[sector]` and `sortBy=sector` still read the stored column, so they do not match the fallback.

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
      { id: 'e', projectSubType: '  ', ...PUBLIC },
      // The year beats the Act label when both are present.
      { id: 'f', projectSubType: 'Solid Waste Management Facilities', legislationYear: 2002,
        legislation: '2018 Environmental Assessment Act', ...PUBLIC },
      { id: 'g', projectSubType: 'Solid Waste Management Facilities', legislationYear: null,
        legislation: '2002 Environmental Assessment Act', ...PUBLIC },
      // Stored before the merge trimmed; the filter panel's value has no trailing space.
      { id: 'h', sector: 'Groundwater Extraction ', projectSubType: 'Dams', ...PUBLIC }
    ];
    t.mock.method(projectsRepo, 'listVisible', async () => ({ items: rows }));
    t.mock.method(projectsRepo, 'countVisible', async () => rows.length);

    assert.deepStrictEqual(await sectors({ pageSize: '10' }), [
      ['a', 'Mining'],
      ['b', 'Electric Transmission Lines'],
      ['c', 'Local Government Solid Waste Management Facilities'],
      ['d', 'Solid Waste Management'],
      ['e', 'Other'],
      ['f', 'Local Government Solid Waste Management Facilities'],
      ['g', 'Local Government Solid Waste Management Facilities'],
      ['h', 'Groundwater Extraction']
    ]);
  });

  await t.test('AI Search: sub-type from the index row, named for its legislation year', async () => {
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 7,
      items: [
        { id: 'a', sector: 'Mining', projectSubType: 'Coal Mines', read: ['public'] },
        { id: 'b', sector: null, projectSubType: 'Transmission Lines', read: ['public'] },
        { id: 'c', projectSubType: 'Solid Waste Management Facilities', read: ['public'] },
        { id: 'd', projectSubType: null, read: ['public'] },
        { id: 'e', projectSubType: 'Solid Waste Management Facilities', legislationYear: 2002,
          read: ['public'] },
        { id: 'f', projectSubType: 'Marine Port Projects', legislationYear: 2002, read: ['public'] },
        { id: 'g', sector: 'Groundwater Extraction ', read: ['public'] }
      ]
    }));

    assert.deepStrictEqual(await sectors({ keywords: 'mine', pageSize: '10' }), [
      ['a', 'Mining'],
      ['b', 'Electric Transmission Lines'],
      ['c', 'Solid Waste Management'],
      ['d', 'Other'],
      ['e', 'Local Government Solid Waste Management Facilities'],
      ['f', 'Marine Port Facilities'],
      ['g', 'Groundwater Extraction']
    ]);
  });

  // A dial that hides `sector` from the public must not leak the sub-type in its place.
  await t.test('a sector withheld by a dial stays withheld on both paths', async () => {
    t.mock.method(projectsRepo, 'listVisible', async () => ({
      items: [{ id: 'a', sector: 'Mining', projectSubType: 'Coal Mines', vis: { sector: 2 }, ...PUBLIC }]
    }));
    t.mock.method(projectsRepo, 'countVisible', async () => 1);
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 1,
      items: [{ id: 'a', sector: 'Mining', projectSubType: 'Coal Mines',
        vis: JSON.stringify({ sector: 2 }), read: ['public'] }]
    }));

    assert.deepStrictEqual(await sectors({ pageSize: '10' }), [['a', 'Other']]);
    assert.deepStrictEqual(await sectors({ keywords: 'mine', pageSize: '10' }), [['a', 'Other']]);
  });
});
