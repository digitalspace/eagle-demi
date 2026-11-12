'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const searchController = require('../../src/controllers/search');
const aiSearch = require('../../src/search/ai-search');
const documentsRepo = require('../../src/repositories/documents');
const projectsRepo = require('../../src/repositories/projects');
const notificationsRepo = require('../../src/repositories/notifications');
const { NOTIFICATION_EAGLE_ID } = require('../helpers/eagle-mirror-fixtures');
const { ids, pagedCosmos } = require('../helpers/paged-cosmos');
const chunksRepo = require('../../src/repositories/chunks');
const summarizer = require('../../src/ai/summarize');
const { logger } = require('../../src/utils/logger');
const config = require('../../src/config');

// publicView allowlists by ENRICHMENT_SOURCES; test deploys name wildfire.
config.enrichmentSources = ['wildfire'];

test('Search Controller Tests', async (t) => {

  t.afterEach(() => {
    t.mock.restoreAll();
  });

  await t.test('search projects returns projects from Cosmos DB when no keywords are provided', async () => {
    const mockProjects = [
      {
        id: '12345',
        name: 'Ajax Mine',
        region: 'Thompson-Okanagan',
        sector: 'Mining',
        // Cosmos name, not the index name `status`: a fixture using index names hides a branch
        // that reads them off a Cosmos row.
        projectState: 'Completed',
        centroid: { type: 'Point', coordinates: [-120.37, 50.62] },
        read: ['public'],
        isPublished: true,
        // The stored shape. Only the ENRICHMENT_SOURCES keys reach a caller; the raw upstream
        // payloads are traceability.
        sources: {
          track: { proponent_name: 'KGHM' },
          eagle: { projectLeadEmail: 'lead@gov.bc.ca' },
          wildfire: {
            activeCountWithin50km: 2,
            nearestDistanceKm: 12.4,
            firesOfNoteNearby: 1,
            lastCalculatedAt: '2026-08-23T00:00:00.000Z'
          }
        }
      }
    ];

    t.mock.method(projectsRepo, 'listPage', async (access, opts) => {
      // The repository owns the SQL; what this path must not lose is the caller's access context.
      assert.ok(access, 'expected an access context');
      assert.ok(!('trackOnly' in opts), 'provenance must not scope a public project read');
      assert.strictEqual(opts.pageSize, 10);
      return mockProjects;
    });

    const req = {
      query: { dataset: 'Project', keywords: '', pageSize: '10' },
      header: () => null
    };

    let jsonResponse;
    const res = {
      json: (data) => {
        jsonResponse = data;
        return res;
      },
      status: () => res
    };

    await searchController.search(req, res);

    assert.ok(Array.isArray(jsonResponse));
    assert.strictEqual(jsonResponse[0].searchResults.length, 1);
    assert.strictEqual(jsonResponse[0].searchResults[0].name, 'Ajax Mine');
    assert.strictEqual(jsonResponse[0].searchResults[0].sector, 'Mining');
    assert.strictEqual(jsonResponse[0].searchResults[0].isPublished, true);

    const { sources } = jsonResponse[0].searchResults[0];
    assert.strictEqual(sources.track, undefined, 'raw Track payload withheld');
    assert.strictEqual(sources.eagle, undefined, 'raw Eagle payload withheld');
    assert.strictEqual(sources.wildfire.activeCountWithin50km, 2,
      'wildfire aggregate survives for the map');
  });

  // Type, Phase and Decision are columns of the default project list; reading index names off a
  // Cosmos row prints '-' in each.
  await t.test('the Cosmos project branch emits the type, phase and decision columns', async () => {
    t.mock.method(projectsRepo, 'listPage', async () => [{
        id: '46',
        name: 'Caribou Gas Processing Plant',
        projectState: 'Care and Maintenance',
        // COSMOS NAMES. `projectType`, and the two List refs stored whole — not the flat
        // label/id pair the indexer projects.
        projectType: 'Energy - Electricity',
        currentPhaseName: { _id: '5d3f6c7eda7a384218296037', name: 'Post Decision - Care & Maintenance' },
        eacDecision: { _id: '5e27937a749c83437054f214', name: 'Certificate Issued' },
        decisionDate: '1996-11-13T08:00:00.000Z',
        read: ['public']
      }]);

    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: '', pageSize: '10' }, header: () => null }, res);

    const row = jsonResponse[0].searchResults[0];
    assert.strictEqual(row.type, 'Energy - Electricity');
    assert.deepStrictEqual(row.currentPhaseName,
      { _id: '5d3f6c7eda7a384218296037', name: 'Post Decision - Care & Maintenance' });
    assert.deepStrictEqual(row.eacDecision,
      { _id: '5e27937a749c83437054f214', name: 'Certificate Issued' });
    assert.strictEqual(row.decisionDate, '1996-11-13T08:00:00.000Z');
  });

  // The template guards with `?.name || '-'`, so `{}` would print an empty cell instead of a dash.
  await t.test('a project with no phase or decision yields no ref, not an empty object', async () => {
    t.mock.method(projectsRepo, 'listPage', async () => [{ id: '1', name: 'Marshall Road', read: ['public'] }]);

    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: '', pageSize: '10' }, header: () => null }, res);

    const row = jsonResponse[0].searchResults[0];
    assert.strictEqual(row.currentPhaseName, undefined);
    assert.strictEqual(row.eacDecision, undefined);
    assert.strictEqual(row.type, '');
  });

  // The `projects` index has no EAC number column, so only the Cosmos branch can carry it.
  await t.test('the Cosmos project branch emits eaCertificate, and null when there is none', async () => {
    t.mock.method(projectsRepo, 'listPage', async () => [
        { id: '46', name: 'Caribou Gas Processing Plant', eaCertificate: 'E05-01', read: ['public'] },
        { id: '354', name: 'Surrey Langley SkyTrain', read: ['public'] },
        // Track uses the column for certificate STATE as well as numbers, and it reaches the wire
        // unchanged: nothing on this path parses or filters the value.
        { id: '38', name: 'Ajax Mine', eaCertificate: 'Withdrawn', read: ['public'] }
      ]);

    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: '', pageSize: '10' }, header: () => null }, res);

    const [certified, uncertified, withdrawn] = jsonResponse[0].searchResults;
    assert.strictEqual(certified.eaCertificate, 'E05-01');
    assert.strictEqual(withdrawn.eaCertificate, 'Withdrawn');
    // NULL, not '': the frontend renders the row only when the field is truthy, and an empty
    // string would be indistinguishable from a redacted one.
    assert.strictEqual(uncertified.eaCertificate, null);
  });

  // The index stores the label and the id in two flat columns; the response has to put them back
  // together, or the keyword-search view loses the same three columns the list view just gained.
  await t.test('the AI Search project branch rebuilds the List refs from the flat pair', async () => {
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 1,
      items: [{
        id: '46',
        name: 'Caribou Gas Processing Plant',
        type: 'Energy - Electricity',
        currentPhaseName: 'Post Decision - Care & Maintenance',
        currentPhaseNameId: '5d3f6c7eda7a384218296037',
        eacDecision: 'Certificate Issued',
        eacDecisionId: '5e27937a749c83437054f214',
        decisionDate: '1996-11-13T08:00:00Z',
        read: ['public']
      }]
    }));

    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'caribou' }, header: () => null }, res);

    const row = jsonResponse[0].searchResults[0];
    assert.strictEqual(row.type, 'Energy - Electricity');
    assert.deepStrictEqual(row.currentPhaseName,
      { _id: '5d3f6c7eda7a384218296037', name: 'Post Decision - Care & Maintenance' });
    assert.deepStrictEqual(row.eacDecision,
      { _id: '5e27937a749c83437054f214', name: 'Certificate Issued' });
  });

  // "Last updated" is fed by two mappers with separate row shapes; a field missing from
  // `PROJECT_SELECT` reads '-' under a 200 while sorting on it still works.
  await t.test('both project branches carry dateUpdated', async () => {
    const EDITED = '2026-09-10T17:04:00.000Z';
    t.mock.method(projectsRepo, 'listPage', async () => [{ id: '46', name: 'Caribou', dateUpdated: EDITED, read: ['public'] }]);
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 1,
      items: [{ id: '46', name: 'Caribou', dateUpdated: EDITED, read: ['public'] }]
    }));

    const rowFor = async (keywords) => {
      let jsonResponse;
      const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };
      await searchController.search(
        { query: { dataset: 'Project', keywords, pageSize: '10' }, header: () => null }, res);
      return jsonResponse[0].searchResults[0];
    };

    assert.strictEqual((await rowFor('')).dateUpdated, EDITED, 'Cosmos list branch');
    assert.strictEqual((await rowFor('caribou')).dateUpdated, EDITED, 'AI Search branch');

    // NULL, not undefined: a project Eagle has never edited must serialise as an absent date
    // rather than drop the key, which is how the column tells "never edited" from "not asked for".
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 1, items: [{ id: '47', name: 'No edits', read: ['public'] }]
    }));
    assert.strictEqual((await rowFor('no edits')).dateUpdated, null);
  });

  // The index keeps `activeWork` as four flat columns and has no `assessments` column at all, so
  // the two branches build these fields differently but must agree on the shape.
  await t.test('both project branches carry phaseIds and activeWork in the stored shape', async () => {
    const ACTIVE = { trackWorkId: 2201, eaAct: '2018 Act', workType: 'Assessment', currentPhase: 'Process Planning' };
    const ASSESSMENTS = [{ legislationYear: 2018, phases: [] }];
    t.mock.method(projectsRepo, 'listPage', async () => [{
      id: '46', name: 'Caribou', read: ['public'], phaseIds: ['p1', 'p2'], activeWork: ACTIVE, assessments: ASSESSMENTS
    }]);
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 1,
      items: [{
        id: '46', name: 'Caribou', read: ['public'], phaseIds: ['p1', 'p2'], activeWorkId: 2201,
        activeWorkAct: '2018 Act', activeWorkType: 'Assessment', activeWorkPhase: 'Process Planning'
      }]
    }));

    const rowFor = async (keywords) => {
      let jsonResponse;
      const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };
      await searchController.search(
        { query: { dataset: 'Project', keywords, pageSize: '10' }, header: () => null }, res);
      return jsonResponse[0].searchResults[0];
    };

    const cosmos = await rowFor('');
    assert.deepStrictEqual([cosmos.phaseIds, cosmos.activeWork, cosmos.assessments],
      [['p1', 'p2'], ACTIVE, ASSESSMENTS], 'Cosmos list branch');
    const indexed = await rowFor('caribou');
    assert.deepStrictEqual([indexed.phaseIds, indexed.activeWork, 'assessments' in indexed],
      [['p1', 'p2'], ACTIVE, false], 'AI Search branch');
  });

  // The index nulls a non-numeric work id that Cosmos still holds, so only four empty columns mean
  // "no live work".
  await t.test('the index branch answers activeWork null only when all four columns are null', async (tt) => {
    const rowFor = async (hit) => {
      tt.mock.restoreAll();
      tt.mock.method(aiSearch, 'searchProjects', async () => ({ count: 1, items: [{ id: '47', name: 'Idle', read: ['public'], ...hit }] }));
      let jsonResponse;
      const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };
      await searchController.search(
        { query: { dataset: 'Project', keywords: 'idle', pageSize: '10' }, header: () => null }, res);
      return jsonResponse[0].searchResults[0];
    };
    const none = { activeWorkId: null, activeWorkAct: null, activeWorkType: null, activeWorkPhase: null };
    assert.strictEqual((await rowFor(none)).activeWork, null);
    assert.deepStrictEqual((await rowFor({ ...none, activeWorkAct: '2018 Act' })).activeWork,
      { trackWorkId: null, eaAct: '2018 Act', workType: null, currentPhase: null });
  });

  // 2 is below the anonymous caller's level 4, so both fields must come back empty to the public.
  await t.test('a dial on activeWork or phaseIds withholds them on both project branches', async (tt) => {
    const ACTIVE = { trackWorkId: 2201, eaAct: '2018 Act', workType: 'Assessment', currentPhase: 'Process Planning' };
    const FLAT = { activeWorkId: 2201, activeWorkAct: '2018 Act', activeWorkType: 'Assessment', activeWorkPhase: 'Process Planning' };
    const rowFor = async (keywords) => {
      let jsonResponse;
      const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };
      await searchController.search(
        { query: { dataset: 'Project', keywords, pageSize: '10' }, header: () => null }, res);
      return jsonResponse[0].searchResults[0];
    };
    for (const field of ['activeWork', 'phaseIds']) {
      tt.mock.restoreAll();
      tt.mock.method(projectsRepo, 'listPage', async () => [{
        id: '46', name: 'Caribou', read: ['public'], phaseIds: ['p1'], activeWork: ACTIVE, vis: { [field]: 2 }
      }]);
      tt.mock.method(aiSearch, 'searchProjects', async () => ({
        count: 1,
        items: [{ id: '46', name: 'Caribou', read: ['public'], phaseIds: ['p1'], ...FLAT, vis: JSON.stringify({ [field]: 2 }) }]
      }));
      assert.strictEqual((await rowFor(''))[field], null, `${field} on the Cosmos list branch`);
      assert.strictEqual((await rowFor('caribou'))[field], null, `${field} on the AI Search branch`);
    }
  });

  // eagle-public sends `fuzzy=false` but eagle-search always fuzzed; honouring it would answer a
  // smaller set than the service DEMI replaces.
  await t.test('fuzzy stays on even when the caller explicitly asks for it off', async () => {
    let sent = null;
    t.mock.method(aiSearch, 'searchProjects', async (opts) => {
      sent = opts;
      return { count: 0, items: [] };
    });

    const res = { json: () => res, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'caribou', fuzzy: 'false' }, header: () => null },
      res);

    assert.strictEqual(sent.fuzzy, true);
  });

  await t.test('the Cosmos branch nulls a missing trackProjectId too', async () => {
    // Cosmos stores the field, so this branch reads it instead of sniffing the id prefix; both
    // branches must agree.
    t.mock.method(projectsRepo, 'listPage', async () => [
        { id: 'eagle-6a59234357be6fca20a489dc', name: 'testtesttest', trackProjectId: null,
          eagleId: '6a59234357be6fca20a489dc', read: ['public'] },
        { id: '207', name: 'Nicomen Wind Energy', trackProjectId: 207,
          eagleId: '58851172aaecd9001b820335', read: ['public'] }
      ]);
    t.mock.method(projectsRepo, 'countVisible', async () => 2);

    let body = null;
    const res = { json: (b) => { body = b; return res; }, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project' }, header: () => null }, res);

    const rows = body[0].searchResults;
    assert.strictEqual(rows[0].trackProjectId, null, 'no Track counterpart, no Track id');
    assert.strictEqual(rows[1].trackProjectId, '207', 'and a real one still crosses as a String');
  });

  // PROVENANCE. An Eagle project with no Track counterpart is retained and flagged, never hidden —
  // what a caller may see is the `read[]` ACL's decision, not the row's source system.
  await t.test('the AI Search branch carries the ACL clause and NO provenance clause', async () => {
    let sent = null;
    t.mock.method(aiSearch, 'searchProjects', async (opts) => {
      sent = opts;
      return { count: 0, items: [] };
    });

    const res = { json: () => res, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'mine' }, header: () => null }, res);

    assert.match(sent.filter, /read\/any/, 'the ACL clause is what scopes this read');
    assert.ok(!/sourceSystem/.test(sent.filter),
      'provenance must not decide which projects a caller can see');
  });

  await t.test('an unscoped PRIVILEGED caller sends only the sealed exclusion', async () => {
    let sent = null;
    t.mock.method(aiSearch, 'searchProjects', async (opts) => {
      sent = opts;
      return { count: 0, items: [] };
    });

    const res = { json: () => res, status: () => res };
    const ask = (roles) => searchController.search({
      query: { dataset: 'Project', keywords: 'mine' },
      user: { realm_access: { roles } },
      header: () => null
    }, res);

    await ask(['sysadmin']);
    assert.strictEqual(sent.filter, "not read/any(r: r eq 'compliance')",
      'privilege lifts the role clause, never the sealed compartment');

    // Holding `compliance` changes nothing HERE: this route builds no compartment access, so a
    // sealed row is unfindable to its own holder — `/api/sealed` is the only door, and it audits.
    await ask(['sysadmin', 'compliance']);
    assert.strictEqual(sent.filter, "not read/any(r: r eq 'compliance')",
      'a compliance holder searching the index is excluded like everyone else');
  });

  await t.test('a keywordless SORT is not provenance-scoped either', async () => {
    // The shape eagle-public sends for the project list: `?dataset=Project&sortBy=-name`, no
    // keywords, which still goes to the index rather than Cosmos.
    let sent = null;
    t.mock.method(aiSearch, 'searchProjects', async (opts) => {
      sent = opts;
      return { count: 0, items: [] };
    });

    const res = { json: () => res, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', sortBy: '-name' }, header: () => null }, res);

    assert.ok(!/sourceSystem/.test(sent.filter));
    assert.strictEqual(sent.matchAll, true, 'and it is the keywordless index read, not Cosmos');
  });

  await t.test('a caller may still filter on sourceSystem themselves', async () => {
    // `sourceSystem` is filterable in the committed index schema, so `and[sourceSystem]=eagle`
    // composes with the ACL like any other caller term — the route adds nothing of its own.
    let sent = null;
    t.mock.method(aiSearch, 'searchProjects', async (opts) => {
      sent = opts;
      return { count: 0, items: [] };
    });

    const res = { json: () => res, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'test', 'and[sourceSystem]': 'eagle' },
        header: () => null },
      res);

    assert.match(sent.filter, /sourceSystem eq 'eagle'/, "the caller's own term is still built");
    assert.match(sent.filter, /read\/any/, 'and the ACL clause survives beside it');
  });

  await t.test('an Eagle-only row reports trackProjectId null, not its own id', async () => {
    // `id` on such a row is the literal `eagle-<ObjectId>`; returning it AS a trackProjectId
    // reported a value that is not a Track id and never will be.
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 1,
      items: [{
        id: 'eagle-6a59234357be6fca20a489dc',
        name: 'testtesttest',
        legacyEagleId: '6a59234357be6fca20a489dc',
        read: ['public']
      }]
    }));

    let body = null;
    const res = { json: (b) => { body = b; return res; }, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'test' }, header: () => null },
      res);

    assert.strictEqual(body[0].searchResults[0].trackProjectId, null);
    assert.strictEqual(body[0].searchResults[0].id, 'eagle-6a59234357be6fca20a489dc',
      'the DEMI id itself is unchanged — only the claim that it is a Track id is withdrawn');
  });

  await t.test('a DEMI-minted row reports trackProjectId null, not its UUID id', async () => {
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 1,
      items: [{ id: '0f8fad5b-d9cb-469f-a165-70867728950e', name: 'Brand New', read: ['public'] }]
    }));

    let body = null;
    const res = { json: (b) => { body = b; return res; }, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'brand' }, header: () => null }, res);

    assert.strictEqual(body[0].searchResults[0].trackProjectId, null);
  });

  await t.test('a Track row still reports its trackProjectId', async () => {
    // The other half: a fix that nulls everything would pass the test above and break the field.
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 1,
      items: [{ id: '207', name: 'Nicomen Wind Energy', legacyEagleId: '588511', read: ['public'] }]
    }));

    let body = null;
    const res = { json: (b) => { body = b; return res; }, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'nicomen' }, header: () => null }, res);

    assert.strictEqual(body[0].searchResults[0].trackProjectId, '207');
  });

  // The hit is redacted before the mapper runs (docs/rbac-architecture.md §2 item 9); an
  // unpublished row proves `isPublished` is derived from read[], not defaulted.
  await t.test('anonymous Project hit carries no read[]', async () => {
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 1,
      items: [{
        id: '207',
        name: 'Nicomen Wind Energy',
        read: ['sysadmin', 'staff'],
        isPublished: true,
        // Not an index field, so the redactor removes it: the catalog is an allowlist.
        complianceLead: 'A Person'
      }]
    }));

    let body = null;
    const res = { json: (b) => { body = b; return res; }, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'nicomen' }, header: () => null }, res);

    const [row] = body[0].searchResults;
    assert.strictEqual(row.read, undefined, 'the row ACL must not be published to callers');
    assert.strictEqual(row.complianceLead, undefined, 'an uncatalogued index field is dropped');
    assert.strictEqual(row.isPublished, false, 'derived from read[], not copied from the index');
  });

  // The index has no map type, so dials arrive as a JSON string parsed before redaction; a bad
  // row must not 500 the page.
  await t.test('a well-formed vis string dials the hit down', async () => {
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 1,
      items: [{
        id: '207',
        name: 'Nicomen Wind Energy',
        description: 'A wind farm.',
        read: ['public'],
        vis: '{"description": 2}'
      }]
    }));

    let body = null;
    const res = { json: (b) => { body = b; return res; }, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'nicomen' }, header: () => null }, res);

    const [row] = body[0].searchResults;
    assert.strictEqual(row.description, 'No project description provided.',
      'a level-2 dial must withhold the description from an anonymous caller');
    assert.strictEqual(row.name, 'Nicomen Wind Energy', 'an undialled field is untouched');
  });

  await t.test('a malformed vis string falls back to defaultVis', async () => {
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 1,
      items: [{
        id: '207',
        name: 'Nicomen Wind Energy',
        description: 'A wind farm.',
        read: ['public'],
        // Truncated JSON: the parse throws.
        vis: '{'
      }]
    }));

    let body = null;
    const res = { json: (b) => { body = b; return res; }, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'nicomen' }, header: () => null }, res);

    const [row] = body[0].searchResults;
    assert.strictEqual(row.description, 'A wind farm.',
      'no readable dial means defaultVis, which is 4 for description');
    assert.strictEqual(row.vis, undefined, 'the dial map itself is never published');
    assert.strictEqual(row.read, undefined, 'the row still went through the redactor');
  });

  // `markedField` falls back to the raw value, so `highlighted` can carry a withheld field's text,
  // and no dial can name `highlighted` itself.
  await t.test('a dial withholds the highlighted copy of the field too', async () => {
    let dials = '{}';
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 1,
      items: [{
        id: '207',
        name: 'Nicomen Wind Energy',
        description: 'A wind farm.',
        read: ['public'],
        vis: dials,
        // The block `searchProjects` really attaches: one key per highlighted field, carrying the
        // escaped raw value where nothing matched.
        highlighted: {
          name: 'Nicomen <mark>Wind</mark> Energy',
          displayName: '',
          description: 'A wind farm.'
        }
      }]
    }));

    const run = async () => {
      let body = null;
      const res = { json: (b) => { body = b; return res; }, status: () => res };
      await searchController.search(
        { query: { dataset: 'Project', keywords: 'nicomen' }, header: () => null }, res);
      return body[0].searchResults[0];
    };

    dials = '{"description": 2, "name": 2}';
    const dialled = await run();
    assert.strictEqual(dialled.highlighted.name, '',
      'the marked copy of a withheld name must not reach an anonymous caller');
    assert.strictEqual(dialled.highlighted.description, '',
      'the marked copy of a withheld description must not either');

    dials = '{"description": 2}';
    const partial = await run();
    assert.strictEqual(partial.highlighted.name, 'Nicomen <mark>Wind</mark> Energy',
      'an undialled highlight key is kept — the filter is not a blanket wipe');
    assert.strictEqual(partial.highlighted.description, '', 'the dialled one is still withheld');
  });

  // Dials use Cosmos names but apply to index hits whose columns the data source renames;
  // `description` is spelled the same in both, so it alone cannot catch a missing translation.
  await t.test('a dial on a renamed field withholds on the index branch too', async () => {
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 1,
      items: [{
        id: '207',
        name: 'Nicomen Wind Energy',
        description: 'A wind farm.',
        proponent: 'Secret Proponent Inc',
        status: 'Secret Status',
        read: ['public'],
        vis: '{"proponentName": 2, "projectState": 2, "description": 2}'
      }]
    }));

    let body = null;
    const res = { json: (b) => { body = b; return res; }, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'nicomen' }, header: () => null }, res);

    const [row] = body[0].searchResults;
    assert.strictEqual(row.proponent.name, 'Proponent Organization',
      'proponentName dials the index column `proponent`');
    assert.strictEqual(row.status, 'Active', 'projectState dials the index column `status`');
    assert.strictEqual(row.description, 'No project description provided.',
      'the same-named field stays withheld');
  });

  // The catalog gates query keys too. `read` is the only filterable field below level 4, so it is
  // the one key that proves the gate.
  await t.test('a filter on a hidden field is dropped, not applied', async () => {
    let sent = null;
    t.mock.method(aiSearch, 'searchProjects', async (opts) => {
      sent = opts;
      return { count: 0, items: [] };
    });

    let body = null;
    const res = { json: (b) => { body = b; return res; }, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'mine', 'and[read]': 'sysadmin' }, header: () => null },
      res);

    assert.deepStrictEqual(body[0].meta[0].dropped.filter, ['read']);
    assert.ok(!/sysadmin/.test(sent.filter),
      'a filter the caller cannot see must never reach the service');
    assert.strictEqual(sent.filter,
      "read/any(r: search.in(r, 'public', ',')) and not read/any(r: r eq 'compliance')",
      'and the ACL clause is still the only thing scoping the read');
  });

  await t.test('anonymous Document hit carries no read[]', async () => {
    t.mock.method(aiSearch, 'searchDocuments', async () => ({
      count: 1,
      items: [{
        id: 'doc1',
        displayName: 'Application',
        documentFileName: 'app.pdf',
        projectId: '207',
        read: ['sysadmin', 'staff'],
        isPublished: true,
        orcsClassification: '85100-20'
      }]
    }));
    t.mock.method(projectsRepo, 'listByIds', async () => [{ id: '207', name: 'Site C' }]);

    let body = null;
    const res = { json: (b) => { body = b; return res; }, status: () => res };
    await searchController.search(
      { query: { dataset: 'Document', keywords: 'application' }, header: () => null }, res);

    const [row] = body[0].searchResults;
    assert.strictEqual(row.read, undefined, 'the row ACL must not be published to callers');
    assert.strictEqual(row.orcsClassification, undefined, 'an uncatalogued index field is dropped');
    assert.strictEqual(row.isPublished, false, 'derived from read[], not copied from the index');
  });

  // The frontend searches on debounced keystrokes, so the last word is half-typed on nearly every
  // request. Nobody sends `prefix=true` — it has to be what a plain keyword search already does.
  await t.test('a keyword search asks for type-ahead without being told to', async () => {
    let projectOpts = null;
    let documentOpts = null;
    t.mock.method(aiSearch, 'searchProjects', async (opts) => {
      projectOpts = opts;
      return { count: 0, items: [] };
    });
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => {
      documentOpts = opts;
      return { count: 0, items: [] };
    });

    const res = { json: () => res, status: () => res };
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'kem' }, header: () => null }, res);
    await searchController.search(
      { query: { dataset: 'Document', keywords: 'kem' }, header: () => null }, res);

    assert.strictEqual(projectOpts.prefix, true);
    assert.strictEqual(documentOpts.prefix, true);
  });

  // The parity switch. An ACCEPTED parameter, so it must not trip the unknown-parameter 400 the
  // way any unrecognised key does.
  await t.test('prefix=false turns type-ahead off and is not a 400', async () => {
    let projectOpts = null;
    let status = null;
    t.mock.method(aiSearch, 'searchProjects', async (opts) => {
      projectOpts = opts;
      return { count: 0, items: [] };
    });

    const res = { json: () => res, status: (code) => { status = code; return res; } };
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'kem', prefix: 'false' }, header: () => null }, res);

    assert.strictEqual(status, null, 'an accepted parameter must not be refused');
    assert.strictEqual(projectOpts.prefix, false);
  });

  // Chunk search is a phrase somebody finished typing. buildQuery is shared, so this pins that
  // sharing it did not hand chunks a `*` too.
  await t.test('chunk search is not given the type-ahead flag', async () => {
    let sent = null;
    t.mock.method(aiSearch, 'searchChunks', async (opts) => {
      sent = opts;
      return { count: 0, items: [] };
    });

    const res = { json: () => res, status: () => res };
    await searchController.search(
      { query: { dataset: 'DocumentChunk', keywords: 'kem' }, header: () => null }, res);

    assert.notStrictEqual(sent.prefix, true, `chunk search must not prefix, got: ${sent.prefix}`);
  });

  await t.test('search projects queries AI Search when keywords are provided', async () => {
    let sent = null;
    t.mock.method(aiSearch, 'searchProjects', async (opts) => {
      sent = opts;
      return {
        count: 1,
        items: [{
          id: '12345',
          name: 'Ajax Mine',
          displayName: 'AJAX',
          description: 'Proposed open-pit copper mine.',
          proponent: 'KGHM Ajax',
          sector: 'Mining',
          status: 'Completed',
          region: 'Thompson-Okanagan',
          legacyEagleId: '588511',
          // Stored and returned as GeoJSON [lng, lat] — the frontend's order, unchanged.
          centroid: { type: 'Point', coordinates: [-120.37, 50.62] },
          read: ['public']
        }]
      };
    });

    const req = {
      query: { dataset: 'Project', keywords: 'Ajax', pageSize: '5' },
      header: () => null
    };
    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };

    await searchController.search(req, res);

    // Projects scope on their own id — scoping them on projectId would match nothing while
    // looking exactly like an empty corpus.
    assert.ok(sent.filter, 'an anonymous caller must be filtered');
    assert.ok(!/projectId/.test(sent.filter), 'projects are scoped on id, never projectId');

    const [hit] = jsonResponse[0].searchResults;
    assert.strictEqual(hit.name, 'Ajax Mine');
    assert.strictEqual(hit.sector, 'Mining');
    assert.strictEqual(hit.isPublished, true);
    assert.strictEqual(hit.legacyEagleId, '588511');
    // The lat/lng swap Typesense needed is gone: Cosmos stores [lng, lat] and so does the index.
    assert.deepStrictEqual(hit.centroid, [-120.37, 50.62]);
  });

  // Answering a keyword miss with the keywordless list returns unrelated projects and hides a
  // broken search behind a working-looking one.
  await t.test('a keyword search that matches nothing says so, and does not list the corpus',
    async () => {
      let listed = false;
      t.mock.method(aiSearch, 'searchProjects', async () => ({ count: 0, items: [] }));
      t.mock.method(projectsRepo, 'listPage', async () => {
        listed = true;
        return [];
      });

      const req = { query: { dataset: 'Project', keywords: 'zarquonflux' }, header: () => null };
      let jsonResponse;
      const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };

      await searchController.search(req, res);

      assert.deepStrictEqual(jsonResponse[0].searchResults, []);
      assert.strictEqual(listed, false, 'the unfiltered list must not answer a keyword query');
    });

  // A project with no centroid still has to render on a map rather than crash it.
  await t.test('a project without a centroid falls back to the middle of BC', async () => {
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 1,
      items: [{ id: '1', name: 'No Geo', read: ['public'] }]
    }));

    const req = { query: { dataset: 'Project', keywords: 'geo' }, header: () => null };
    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };

    await searchController.search(req, res);
    const [hit] = jsonResponse[0].searchResults;
    assert.deepStrictEqual(hit.centroid, [-125.0, 54.0]);
    assert.ok(hit.centroid[0] < 0, 'longitude must stay negative — BC is west of Greenwich');
  });

  // The second leg is not an optimisation. Measured against the live Typesense index, dropping
  // projectName from document search lost 77% of hits for "Ajax" and 66% for "pipeline".
  await t.test('document search passes a project filter so the name leg can run', async () => {
    let sent = null;
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => {
      sent = opts;
      return {
        count: 1,
        items: [{
          id: 'doc1',
          displayName: 'Application',
          documentFileName: 'app.pdf',
          type: 'Application',
          projectId: '207',
          read: ['public']
        }]
      };
    });
    t.mock.method(projectsRepo, 'listByIds', async (access) => {
      assert.strictEqual(access.tier, 'public', 'labels resolve under the CALLER, not systemAccess');
      return [{ id: '207', name: 'Site C' }];
    });

    const req = {
      query: { dataset: 'Document', keywords: 'Ajax', pageSize: '5' },
      header: () => null
    };
    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };

    await searchController.search(req, res);

    assert.ok(sent.filter, 'documents are filtered on their own ACL');
    assert.notStrictEqual(sent.projectFilter, undefined,
      'undefined would silently disable the project-name leg');

    const [hit] = jsonResponse[0].searchResults;
    // The index carries no projectName; the label is hydrated from the repository.
    assert.strictEqual(hit.projectName, 'Site C');
    assert.strictEqual(hit.documentType, 'Application');
  });

  // eagle-public resolves Date, Type and Milestone from List ids via `idToList()`; both mappers
  // must send the ids, not just labels, or the columns render '-'.
  await t.test('a document row carries the ids and the date the table renders', async () => {
    t.mock.method(aiSearch, 'searchDocuments', async () => ({
      count: 1,
      items: [{
        id: 'doc1',
        displayName: 'Application',
        documentFileName: 'app.pdf',
        type: 'Application',
        typeId: '5cf00c03a266b7e1877504da',
        milestoneId: '5cf00c03a266b7e1877504e9',
        projectPhaseId: '5d3f6c7eda7a38421829602f',
        documentAuthorTypeId: '5cf00c03a266b7e1877504dc',
        datePosted: '2020-03-11T00:00:00Z',
        projectId: '207',
        read: ['public']
      }]
    }));
    t.mock.method(projectsRepo, 'listByIds', async () => [{ id: '207', name: 'Site C' }]);

    const req = { query: { dataset: 'Document', keywords: 'Ajax' }, header: () => null };
    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };
    await searchController.search(req, res);

    const [hit] = jsonResponse[0].searchResults;
    assert.strictEqual(hit.type, '5cf00c03a266b7e1877504da', 'the ID, not the label beside it');
    assert.strictEqual(hit.milestone, '5cf00c03a266b7e1877504e9');
    assert.strictEqual(hit.projectPhase, '5d3f6c7eda7a38421829602f');
    assert.strictEqual(hit.documentAuthorType, '5cf00c03a266b7e1877504dc');
    assert.strictEqual(hit.datePosted, '2020-03-11T00:00:00Z');
    assert.strictEqual(hit.documentType, 'Application', 'the label stays, for DEMI\'s own frontend');
  });

  // Eagle's document rows carry both; dropping either mapping fails silently, the search still answers 200.
  await t.test('a document row carries isFeatured and documentSource', async () => {
    t.mock.method(aiSearch, 'searchDocuments', async () => ({
      count: 2,
      items: [
        {
          id: 'doc1', displayName: 'Featured', documentFileName: 'a.pdf',
          isFeatured: true, documentSource: 'PROJECT', projectId: '207', read: ['public']
        },
        // The row that pins the DEFAULTS: neither field is stored on every document, and both
        // have to be present in the response regardless, with the type eagle-search sends.
        { id: 'doc2', displayName: 'Plain', documentFileName: 'b.pdf', projectId: '207', read: ['public'] }
      ]
    }));
    t.mock.method(projectsRepo, 'listByIds', async () => [{ id: '207', name: 'Site C' }]);

    const req = { query: { dataset: 'Document', keywords: 'Ajax' }, header: () => null };
    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };
    await searchController.search(req, res);

    const [featured, plain] = jsonResponse[0].searchResults;
    assert.strictEqual(featured.isFeatured, true);
    assert.strictEqual(featured.documentSource, 'PROJECT');
    assert.strictEqual(plain.isFeatured, false, 'absent means false, not undefined');
    assert.strictEqual(plain.documentSource, '', 'absent means an empty string, not undefined');
  });

  // eagle-public estimates a bulk download's size from `internalSize` — Eagle's name for the byte
  // count the index stores as `fileSize`. Emitting the index name would size every job at zero.
  await t.test('a document row carries fileSize as internalSize', async () => {
    t.mock.method(aiSearch, 'searchDocuments', async () => ({
      count: 2,
      items: [
        { id: 'doc1', displayName: 'Sized', documentFileName: 'a.pdf',
          fileSize: 1048576, projectId: '207', read: ['public'] },
        // Not every document carries one; the key still ships, null like the other optionals.
        { id: 'doc2', displayName: 'Unsized', documentFileName: 'b.pdf', projectId: '207', read: ['public'] }
      ]
    }));
    t.mock.method(projectsRepo, 'listByIds', async () => [{ id: '207', name: 'Site C' }]);

    const req = { query: { dataset: 'Document', keywords: 'Ajax' }, header: () => null };
    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };
    await searchController.search(req, res);

    const [sized, unsized] = jsonResponse[0].searchResults;
    assert.strictEqual(sized.internalSize, 1048576);
    assert.strictEqual(unsized.internalSize, null);
  });

  await t.test('a bare document list is served by the index, not by Cosmos', async () => {
    // No keywords, no sort, and a `project`, which `hasCriteria` excludes on purpose. A Cosmos read
    // clamps at 1000 rows, so a deep page would come back empty.
    let sent = null;
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => {
      sent = opts;
      return {
        count: 2488,
        items: [{
          id: 'doc1',
          displayName: 'Test Doc',
          documentFileName: 'test_doc.pdf',
          type: 'Application',
          typeId: '5cf00c03a266b7e1877504da',
          milestoneId: '5cf00c03a266b7e1877504e9',
          projectPhaseId: '5d3f6c7eda7a38421829602f',
          documentAuthorTypeId: '5cf00c03a266b7e1877504dc',
          datePosted: '2020-03-11T00:00:00Z',
          projectId: '12345',
          read: ['public']
        }]
      };
    });

    // Both backends map the same fields, so only "which backend ran" catches a `keywords ||
    // criteria` gate sending this to Cosmos.
    t.mock.method(documentsRepo, 'listVisible', async () => {
      assert.fail('no document read may go to Cosmos — it cannot page past 1000 rows');
    });

    // The bare list labels its results too, exactly as a keyword search does.
    t.mock.method(projectsRepo, 'listByIds', async (access, ids) => {
      assert.deepStrictEqual(ids, ['12345']);
      return [{ id: '12345', name: 'Ajax Mine' }];
    });

    const req = {
      query: {
        dataset: 'Document', keywords: '', project: '12345',
        pageSize: '500', pageNum: '2'
      },
      header: () => null
    };

    let jsonResponse;
    const res = {
      json: (data) => {
        jsonResponse = data;
        return res;
      },
      status: () => res
    };

    await searchController.search(req, res);

    // `skip` is in the caller's own `pageSize`.
    assert.strictEqual(sent.skip, 1000, 'the third page of 500 starts at row 1000');
    assert.strictEqual(sent.top, 500);
    assert.strictEqual(sent.matchAll, true, 'no keywords means every row the filter admits');

    assert.ok(Array.isArray(jsonResponse));
    assert.strictEqual(jsonResponse[0].count, 2488, 'the real total, not the page length');
    assert.strictEqual(jsonResponse[0].searchResults.length, 1);
    const row = jsonResponse[0].searchResults[0];
    assert.strictEqual(row.displayName, 'Test Doc');
    assert.strictEqual(row.documentFileName, 'test_doc.pdf');
    assert.strictEqual(row.isPublished, true);
    assert.strictEqual(row.projectName, 'Ajax Mine');
    // The same five the keyword branch sends; eagle-public's Type / Milestone / Date columns
    // resolve them.
    assert.strictEqual(row.type, '5cf00c03a266b7e1877504da');
    assert.strictEqual(row.milestone, '5cf00c03a266b7e1877504e9');
    assert.strictEqual(row.projectPhase, '5d3f6c7eda7a38421829602f');
    assert.strictEqual(row.documentAuthorType, '5cf00c03a266b7e1877504dc');
    assert.strictEqual(row.datePosted, '2020-03-11T00:00:00Z');
  });

  await t.test('a bare document list above the page cap is refused, not truncated', async () => {
    // `runSearch` clamps `top` to MAX_PAGE_ROWS, so a bare list over the cap must be refused, not
    // answered with a short page under a large count.
    t.mock.method(aiSearch, 'searchDocuments', async () => {
      assert.fail('a page above the cap must be refused before any search runs');
    });

    let status = null;
    let body = null;
    const res = {
      status: (code) => { status = code; return res; },
      json: (data) => { body = data; return res; }
    };

    await searchController.search(
      { query: { dataset: 'Document', keywords: '', pageSize: '501' }, header: () => null }, res);

    assert.strictEqual(status, 400);
    assert.match(body.error, /pageSize above 500/);
  });

  await t.test('DocumentChunk search hydrates names and passes the ACL filter to the service',
    async () => {
      let sent = null;
      t.mock.method(aiSearch, 'searchChunks', async (opts) => {
        sent = opts;
        return {
          count: 1,
          items: [{
            chunkId: 'd1::p2::c0',
            documentId: 'd1',
            projectId: '207',
            pageNumber: 2,
            read: ['public'],
            snippet: 'the &lt;script&gt; <mark>river</mark> flows north'
          }]
        };
      });
      // The caller's own access, not a system one — a name must not out-rank the row it labels.
      t.mock.method(documentsRepo, 'listByIds', async (access) => {
        assert.strictEqual(access.tier, 'public');
        return [{
          id: 'd1', displayName: 'Application', documentFileName: 'app.pdf', type: 'Application',
          // Chip columns. The mapper builds its row field by field, so it must be shown to read them.
          milestone: 'Other', milestoneId: '5d0d212c7d50161b92a80eed',
          datePosted: '2018-07-31T06:40:37.626Z'
        }];
      });
      t.mock.method(projectsRepo, 'listByIds', async () => ([{ id: '207', name: 'Site C' }]));

      const req = {
        query: { dataset: 'DocumentChunk', keywords: 'river', pageSize: '50', fuzzy: 'true' },
        header: () => null
      };
      let jsonResponse;
      const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };

      await searchController.search(req, res);

      // An anonymous request without a filter is unrestricted and returns the whole corpus.
      assert.ok(sent.filter, 'an anonymous caller must be filtered');
      assert.ok(sent.filter.includes("'public'"));
      assert.strictEqual(sent.fuzzy, true);

      const [hit] = jsonResponse[0].searchResults;
      // `milestone` must be the label: the chunk card renders it raw with no `idToList`, so an
      // ObjectId would show on screen.
      assert.strictEqual(hit.milestone, 'Other', 'the chip renders this string directly');
      assert.strictEqual(hit.milestoneId, '5d0d212c7d50161b92a80eed');
      assert.strictEqual(hit.datePosted, '2018-07-31T06:40:37.626Z');
      // Grouped by document, so `_id` is the document id: eagle-public's content card builds its
      // download URL from it. The chunk id rides beside it.
      assert.strictEqual(hit._id, 'd1');
      assert.strictEqual(hit.chunkId, 'd1::p2::c0');
      assert.strictEqual(hit.matchCount, 1);
      assert.deepStrictEqual(hit.snippets, [hit.snippet], 'the card reads snippets[], DEMI reads snippet');
      assert.strictEqual(hit.projectName, 'Site C');
      assert.strictEqual(hit.documentName, 'Application');
      assert.strictEqual(hit.pageNumber, 2);
      // read[] is the caller's own ACL restated and is deliberately NOT emitted.
      assert.strictEqual(hit.read, undefined, 'the row ACL must not be published to callers');
      // content is not retrievable from the index, so the API never ships chunk text.
      assert.strictEqual(hit.content, '');
      assert.ok(hit.snippet.includes('<mark>river</mark>'));
      assert.ok(!hit.snippet.includes('<script>'), 'document text must not reach the DOM as markup');
    });

  // eagle-public's content card reads `snippets` and `matchCount`; three passages of one document
  // are one row with a count of 3.
  await t.test('chunk hits collapse to one row per document, with the match count', async () => {
    let sent = null;
    t.mock.method(aiSearch, 'searchChunks', async (opts) => {
      sent = opts;
      return {
        count: 42,
        items: [
          { chunkId: 'd1::p1', documentId: 'd1', projectId: '207', pageNumber: 1, read: ['public'], snippet: 'one' },
          { chunkId: 'd1::p2', documentId: 'd1', projectId: '207', pageNumber: 2, read: ['public'], snippet: 'two' },
          { chunkId: 'd1::p3', documentId: 'd1', projectId: '207', pageNumber: 3, read: ['public'], snippet: 'three' },
          { chunkId: 'd2::p1', documentId: 'd2', projectId: '207', pageNumber: 1, read: ['public'], snippet: 'four' }
        ]
      };
    });
    t.mock.method(documentsRepo, 'listByIds', async () => ([
      { id: 'd1', displayName: 'First' }, { id: 'd2', displayName: 'Second' }
    ]));
    t.mock.method(projectsRepo, 'listByIds', async () => ([{ id: '207', name: 'Site C' }]));

    const req = { query: { dataset: 'DocumentChunk', keywords: 'river', pageSize: '10' }, header: () => null };
    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };
    await searchController.search(req, res);

    const rows = jsonResponse[0].searchResults;
    assert.strictEqual(rows.length, 2, 'four passages, two documents');
    assert.deepStrictEqual(rows.map(r => r._id), ['d1', 'd2']);
    assert.strictEqual(rows[0].matchCount, 3);
    assert.deepStrictEqual(rows[0].snippets, ['one', 'two'], 'capped at MAX_SNIPPETS');
    // A page of documents costs a WINDOW of chunks, and the window is the paging unit.
    assert.strictEqual(sent.top, 100, 'pageSize 10 x FANOUT 10');
    assert.strictEqual(sent.skip, 0);
    // The total still counts passages; meta.countsPassages is what says so.
    assert.strictEqual(jsonResponse[0].count, 42);
    assert.strictEqual(jsonResponse[0].meta[0].countsPassages, true);
    assert.strictEqual(jsonResponse[0].meta[0].documentsOnPage, 2, 'documents, not passages');
  });

  // The total is net of withheld chunks, floored at surviving chunks, not rows: one row can carry
  // many matches.
  await t.test('a withheld chunk is subtracted from the total, floored at surviving chunks', async () => {
    t.mock.method(aiSearch, 'searchChunks', async () => ({
      count: 4,
      items: [
        { chunkId: 'd1::p1', documentId: 'd1', projectId: '207', pageNumber: 1, snippet: 'a' },
        { chunkId: 'd1::p2', documentId: 'd1', projectId: '207', pageNumber: 2, snippet: 'b' },
        { chunkId: 'd1::p3', documentId: 'd1', projectId: '207', pageNumber: 3, snippet: 'c' },
        { chunkId: 'hidden::p1', documentId: 'hidden', projectId: '999', pageNumber: 1, snippet: 'd' }
      ]
    }));
    // The parent of the fourth chunk is not readable, so listByIds does not return it.
    t.mock.method(documentsRepo, 'listByIds', async () => ([{ id: 'd1', displayName: 'First' }]));
    t.mock.method(projectsRepo, 'listByIds', async () => ([{ id: '207', name: 'Site C' }]));

    const req = { query: { dataset: 'DocumentChunk', keywords: 'river', pageSize: '10' }, header: () => null };
    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };
    await searchController.search(req, res);

    assert.strictEqual(jsonResponse[0].searchResults.length, 1, 'the withheld chunk is gone');
    assert.strictEqual(jsonResponse[0].count, 3,
      '4 matches minus 1 withheld — and floored at 3 surviving chunks, not at the 1 row');
  });

  // Above, rows and chunks both floor at 3; only a subtraction below the page tells them apart.
  await t.test('the floor is surviving chunks, not rows, when the subtraction goes low', async () => {
    t.mock.method(aiSearch, 'searchChunks', async () => ({
      count: 1,
      items: [
        { chunkId: 'd1::p1', documentId: 'd1', projectId: '207', pageNumber: 1, snippet: 'a' },
        { chunkId: 'd1::p2', documentId: 'd1', projectId: '207', pageNumber: 2, snippet: 'b' },
        { chunkId: 'd1::p3', documentId: 'd1', projectId: '207', pageNumber: 3, snippet: 'c' },
        { chunkId: 'hidden::p1', documentId: 'hidden', projectId: '999', pageNumber: 1, snippet: 'd' }
      ]
    }));
    t.mock.method(documentsRepo, 'listByIds', async () => ([{ id: 'd1', displayName: 'First' }]));
    t.mock.method(projectsRepo, 'listByIds', async () => ([{ id: '207', name: 'Site C' }]));

    const req = { query: { dataset: 'DocumentChunk', keywords: 'river', pageSize: '10' }, header: () => null };
    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };
    await searchController.search(req, res);

    assert.strictEqual(jsonResponse[0].count, 3,
      'three surviving chunks, not the one row that carries them');
  });

  // `skip` and `top` must share a unit, else pages silently overlap or gap and every page still
  // looks plausible.
  await t.test('chunk pages advance by a whole window, so ranges neither gap nor overlap', async () => {
    const seen = [];
    t.mock.method(aiSearch, 'searchChunks', async (opts) => {
      seen.push({ skip: opts.skip, top: opts.top });
      return { count: 300, items: [] };
    });

    for (const pageNum of ['0', '1', '2']) {
      const req = {
        query: { dataset: 'DocumentChunk', keywords: 'river', pageSize: '10', pageNum },
        header: () => null
      };
      await searchController.search(req, { json: () => ({}), status: () => ({ json: () => ({}) }) });
    }

    assert.deepStrictEqual(seen, [
      { skip: 0, top: 100 }, { skip: 100, top: 100 }, { skip: 200, top: 100 }
    ], 'each page starts exactly where the previous one ended');
  });

  // The window is capped at one service request; a larger one skips each window's tail and doubles
  // requests per keystroke on a Basic 1-SU service.
  await t.test('a large page never costs more than one service request', async () => {
    let sent = null;
    t.mock.method(aiSearch, 'searchChunks', async (opts) => { sent = opts; return { count: 0, items: [] }; });

    const req = {
      query: { dataset: 'DocumentChunk', keywords: 'river', pageSize: '100', pageNum: '1' },
      header: () => null
    };
    await searchController.search(req, { json: () => ({}), status: () => ({ json: () => ({}) }) });

    assert.strictEqual(sent.top, aiSearch.SERVICE_MAX_TOP, 'one request, not two');
    assert.strictEqual(sent.skip, aiSearch.SERVICE_MAX_TOP, 'and skip advances by the same amount');
    assert.ok(sent.top <= aiSearch.SERVICE_MAX_TOP,
      'above this, runSearch fills the page with a second request per keystroke');
  });

  // The search data plane is private, so this count is the only view of index size. It differs from
  // items.length on purpose, so a page-size passthrough fails.
  await t.test('DocumentChunk search returns the index-wide match count, not the page size',
    async () => {
      t.mock.method(aiSearch, 'searchChunks', async () => ({
        count: 995316,
        items: [{ chunkId: 'c1', documentId: 'd1', projectId: '207', pageNumber: 1, read: ['public'], snippet: 'x' }]
      }));
      t.mock.method(documentsRepo, 'listByIds', async () => ([{ id: 'd1', displayName: 'Doc' }]));
      t.mock.method(projectsRepo, 'listByIds', async () => ([{ id: '207', name: 'Site C' }]));

      const req = { query: { dataset: 'DocumentChunk', keywords: 'river' }, header: () => null };
      let jsonResponse;
      const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };

      await searchController.search(req, res);

      assert.strictEqual(jsonResponse[0].count, 995316);
      assert.strictEqual(jsonResponse[0].searchResults.length, 1);
    });

  // The fail-closed branch. OData has no `false` literal, so a caller scoped to nothing cannot be
  // expressed as a filter — the request must simply not be issued.
  await t.test('a caller scoped to nothing is answered empty without a request', async () => {
    let called = false;
    t.mock.method(aiSearch, 'searchChunks', async () => { called = true; return { items: [] }; });

    const req = {
      query: { dataset: 'DocumentChunk', keywords: 'river' },
      // A verified token scoped to zero projects.
      user: { realm_access: { roles: ['public'] }, projectScope: [] },
      header: () => null
    };
    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };

    await searchController.search(req, res);

    assert.deepStrictEqual(jsonResponse[0].searchResults, []);
    assert.strictEqual(called, false, 'no filter can express "nothing", so issue no request');
  });

  // A failed search is not an empty one: a 200 with `[]` would claim `searchResultsTotal: 0`.
  // Only the status code can say "could not look", so no result set ships.
  await t.test('a search backend failure is reported, not answered as an empty result', async () => {
    t.mock.method(aiSearch, 'searchChunks', async () => { throw new Error('HTTP 403 forbidden'); });

    const req = { query: { dataset: 'DocumentChunk', keywords: 'river' }, header: () => null };
    let jsonResponse;
    let statusCode = 200;
    const res = {
      json: (data) => { jsonResponse = data; return res; },
      status: (code) => { statusCode = code; return res; }
    };

    await searchController.search(req, res);

    assert.strictEqual(statusCode, 502);
    assert.ok(!Array.isArray(jsonResponse), 'a failure carries no searchResults array');
    assert.ok(jsonResponse.error, 'and says what went wrong');
  });

  await t.test('DocumentChunk search with no keywords never queries', async () => {
    let called = false;
    t.mock.method(aiSearch, 'searchChunks', async () => { called = true; return { items: [] }; });

    const req = { query: { dataset: 'DocumentChunk', keywords: '' }, header: () => null };
    let jsonResponse;
    const res = { json: (data) => { jsonResponse = data; return res; }, status: () => res };

    await searchController.search(req, res);

    assert.strictEqual(called, false);
    assert.deepStrictEqual(jsonResponse[0].searchResults, []);
  });

  await t.test('search returns 400 for unsupported dataset', async () => {
    const req = {
      query: { dataset: 'UnsupportedDataset' },
      header: () => null
    };

    let statusCode;
    let jsonResponse;
    const res = {
      status: (code) => {
        statusCode = code;
        return res;
      },
      json: (data) => {
        jsonResponse = data;
        return res;
      }
    };

    await searchController.search(req, res);

    assert.strictEqual(statusCode, 400);
    assert.ok(jsonResponse.error.includes('Invalid or unsupported dataset'));
  });

  // The name filter is the one `and[...]` value that carries typed text. Both refusals are answered
  // before any search request is issued, so a bad URL costs nothing and says what is wrong.
  const refusal = async (query) => {
    const out = { body: undefined, status: 200 };
    const res = {
      status: (code) => { out.status = code; return res; },
      json: (data) => { out.body = data; return res; }
    };
    await searchController.search({ query, header: () => null }, res);
    return out;
  };

  await t.test('and[nameContains] is refused on a dataset with no name cell', async () => {
    const out = await refusal({ dataset: 'DocumentChunk', 'and[nameContains]': 'sediment' });

    assert.strictEqual(out.status, 400);
    assert.ok(out.body.error.includes('dataset=Project and dataset=Document only'), out.body.error);
  });

  await t.test('and[nameContains] over the length cap is refused', async () => {
    const out = await refusal({ dataset: 'Project', 'and[nameContains]': 'a'.repeat(201) });

    assert.strictEqual(out.status, 400);
    assert.ok(out.body.error.includes('limited to 200 characters'), out.body.error);
  });

  // Controller and builder both cap at 200; status alone would pass if the builder stopped one
  // character short and served the whole corpus, so the filter is asserted too.
  await t.test('and[nameContains] at the cap is filtered, not refused', async () => {
    let sent = null;
    t.mock.method(aiSearch, 'searchProjects', async (opts) => {
      sent = opts;
      return { items: [], total: 0 };
    });
    const out = await refusal({ dataset: 'Project', 'and[nameContains]': 'a'.repeat(200) });

    assert.strictEqual(out.status, 200);
    assert.ok(sent.filter.includes(
      `search.ismatch('${'a'.repeat(200)}*', 'name,nameTokens', 'full', 'any')`),
      sent.filter);
  });
});

// Project and Document fall through to Cosmos instead of short-circuiting, so "no AI Search
// request" is only half the check; the answer must be empty too.
test('every dataset is fail-closed for a caller scoped to nothing', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const scopedToNothing = () => ({
    user: { realm_access: { roles: ['public'] }, projectScope: [] },
    header: () => null
  });

  await t.test('Project issues no AI Search request and lists nothing', async () => {
    let searched = false;
    t.mock.method(aiSearch, 'searchProjects', async () => { searched = true; return { items: [] }; });
    // The Cosmos fallback must be ACL-gated too — scoped-to-nothing is SQL `false` there.
    let seenAccess;
    t.mock.method(projectsRepo, 'listPage', async (access) => {
      seenAccess = access;
      return [];
    });

    let body;
    const res = { json: (d) => { body = d; return res; }, status: () => res };
    await searchController.search(
      { ...scopedToNothing(), query: { dataset: 'Project', keywords: 'river' } }, res);

    assert.strictEqual(searched, false, 'a null filter is UNRESTRICTED — issue no request');
    assert.deepStrictEqual(body[0].searchResults, []);
    if (seenAccess) assert.deepStrictEqual(seenAccess.projectScope, []);
  });

  await t.test('Document issues no AI Search request and lists nothing', async () => {
    let searched = false;
    t.mock.method(aiSearch, 'searchDocuments', async () => { searched = true; return { items: [] }; });
    t.mock.method(documentsRepo, 'listVisible', async () => ({ items: [], continuationToken: undefined }));

    let body;
    const res = { json: (d) => { body = d; return res; }, status: () => res };
    await searchController.search(
      { ...scopedToNothing(), query: { dataset: 'Document', keywords: 'river' } }, res);

    assert.strictEqual(searched, false, 'a null filter is UNRESTRICTED — issue no request');
    assert.deepStrictEqual(body[0].searchResults, []);
  });
});

// filterFor must read a privileged credential's project scope, not short-circuit on privilege;
// the filter sent is the evidence.
test('a scoped privileged caller searches only its own projects', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('the chunk filter carries the scope and drops the role clause', async () => {
    let sent;
    t.mock.method(aiSearch, 'searchChunks', async (opts) => { sent = opts; return { items: [], count: 0 }; });

    const res = { json: () => res, status: () => res };
    await searchController.search({
      query: { dataset: 'DocumentChunk', keywords: 'river' },
      user: { realm_access: { roles: ['demi-service-read'] }, projectScope: ['207'] },
      header: () => null
    }, res);

    assert.ok(sent, 'the request must still be issued — this caller can see something');
    assert.match(sent.filter, /search\.in\(projectId, '207'/, 'the scope survives privilege');
    assert.ok(!/read\/any\(r: search\.in/.test(sent.filter),
      'privilege lifts the ROLE clause, not the scope or the sealed exclusion');
  });
});

// A chunk carries a snapshot of its document's ACL from ingest, so a chunk whose parent the caller
// cannot read must be withheld even when its own `read` is stale.
test('restricted document text does not leak through Deep Search', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a chunk whose parent is not visible is withheld, snippet and all', async () => {
    // Two hits. The caller may see one parent; the other document has been restricted, but its
    // chunks still carry the stale `read: ['public']` they were ingested with.
    t.mock.method(aiSearch, 'searchChunks', async () => ({
      items: [
        { chunkId: 'ok::p0::c0', documentId: 'visible-doc', projectId: 'p1', pageNumber: 0,
          snippet: 'public text', read: ['public'] },
        { chunkId: 'leak::p3::c1', documentId: 'restricted-doc', projectId: 'p1', pageNumber: 3,
          snippet: 'SECRET-CANARY from a restricted document', read: ['public'] }
      ],
      count: 2
    }));
    // Only the visible document comes back — listByIds applies the ACL.
    t.mock.method(documentsRepo, 'listByIds', async () => [
      { id: 'visible-doc', displayName: 'Public Doc', type: 'PDF' }
    ]);
    t.mock.method(projectsRepo, 'listByIds', async () => [{ id: 'p1', name: 'Project One' }]);

    let body;
    const res = { json: (d) => { body = d; return res; }, status: () => res };
    await searchController.search({
      query: { dataset: 'DocumentChunk', keywords: 'canary' },
      header: () => null
    }, res);

    const results = body[0].searchResults;
    assert.strictEqual(results.length, 1, 'the chunk of an invisible document must be dropped');
    assert.strictEqual(results[0].documentId, 'visible-doc');

    // The real assertion: the text must not appear ANYWHERE in the payload.
    assert.ok(
      !JSON.stringify(body).includes('SECRET-CANARY'),
      'the withheld chunk\'s extracted text must not reach the caller in any field'
    );
    assert.strictEqual(body[0].count, 1, 'the count is reported net of what was withheld');
  });

  await t.test('the count is the index total MINUS what was withheld, not the page size', async () => {
    // The distinguishing case: a large corpus, one withheld hit on this page. Reporting the page
    // length here would tell the frontend the whole corpus holds 1 match and collapse its paging.
    t.mock.method(aiSearch, 'searchChunks', async () => ({
      items: [
        { chunkId: 'a::p0::c0', documentId: 'visible-doc', projectId: 'p1', snippet: 'text', read: ['public'] },
        { chunkId: 'b::p0::c0', documentId: 'restricted-doc', projectId: 'p1', snippet: 'nope', read: ['public'] }
      ],
      count: 500
    }));
    t.mock.method(documentsRepo, 'listByIds', async () => [{ id: 'visible-doc', displayName: 'Doc' }]);
    t.mock.method(projectsRepo, 'listByIds', async () => [{ id: 'p1', name: 'P' }]);

    let body;
    const res = { json: (d) => { body = d; return res; }, status: () => res };
    await searchController.search({
      query: { dataset: 'DocumentChunk', keywords: 'x' }, header: () => null
    }, res);

    assert.strictEqual(body[0].searchResults.length, 1);
    assert.strictEqual(body[0].count, 499);
  });

  await t.test('nothing is dropped when every parent is visible', async () => {
    t.mock.method(aiSearch, 'searchChunks', async () => ({
      items: [{ chunkId: 'a::p0::c0', documentId: 'd1', projectId: 'p1', snippet: 'text', read: ['public'] }],
      count: 42
    }));
    t.mock.method(documentsRepo, 'listByIds', async () => [{ id: 'd1', displayName: 'Doc' }]);
    t.mock.method(projectsRepo, 'listByIds', async () => [{ id: 'p1', name: 'P' }]);

    let body;
    const res = { json: (d) => { body = d; return res; }, status: () => res };
    await searchController.search({
      query: { dataset: 'DocumentChunk', keywords: 'x' }, header: () => null
    }, res);

    assert.strictEqual(body[0].searchResults.length, 1);
    assert.strictEqual(body[0].count, 42, 'the index-wide total survives when nothing is withheld');
  });
});

// eagle-public speaks eagle-api's search contract, so this endpoint matches it; a near miss
// renders an empty table under a 200.
test('the eagle-public response contract', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const capture = () => {
    const out = { body: undefined, status: 200 };
    const res = {
      json: (d) => { out.body = d; return res; },
      status: (code) => { out.status = code; return res; }
    };
    return { out, res };
  };

  // eagle-public dereferences meta[0] unguarded; without it /projects redirects home. The total is
  // the index-wide count, not the page length.
  await t.test('every answer carries meta[0].searchResultsTotal', async () => {
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 995316,
      items: [{ id: '207', name: 'Site C', read: ['public'] }]
    }));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'site c' }, header: () => null }, res);

    assert.strictEqual(out.body[0].meta[0].searchResultsTotal, 995316);
    assert.strictEqual(out.body[0].searchResults.length, 1, 'one row, and a corpus-wide total');
  });

  // /projects hits the empty branches when a search matches nothing; meta must survive there.
  await t.test('an empty answer still carries meta', async () => {
    t.mock.method(aiSearch, 'searchProjects', async () => ({ count: 0, items: [] }));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'zarquonflux' }, header: () => null }, res);

    assert.deepStrictEqual(out.body[0].searchResults, []);
    assert.strictEqual(out.body[0].meta[0].searchResultsTotal, 0);
  });

  // A chunk total counts PASSAGES, and several can come from one document. eagle-search flags it
  // the same way so a caller cannot read the number as a document count.
  await t.test('chunk meta says the total counts passages', async () => {
    t.mock.method(aiSearch, 'searchChunks', async () => ({
      count: 4210,
      items: [{ chunkId: 'd1::p2::c0', documentId: 'd1', projectId: '207', pageNumber: 2, read: ['public'] }]
    }));
    t.mock.method(documentsRepo, 'listByIds', async () => ([{ id: 'd1', displayName: 'Application' }]));
    t.mock.method(projectsRepo, 'listByIds', async () => ([{ id: '207', name: 'Site C', eagleId: '588511c4aaecd9001b826192' }]));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'DocumentChunk', keywords: 'river' }, header: () => null }, res);

    const [meta] = out.body[0].meta;
    assert.strictEqual(meta.searchResultsTotal, 4210);
    assert.strictEqual(meta.countsPassages, true);
    assert.strictEqual(meta.documentsOnPage, 1);
  });

  // A column the live index could not answer looks like an empty one; the search layer drops the
  // field to stay up, and `meta` tells the caller.
  await t.test('a degraded search says which field the index could not answer', async () => {
    t.mock.method(aiSearch, 'searchDocuments', async () => ({
      count: 3,
      meta: { degraded: { missing: ['fileSize'] } },
      items: [{ id: 'd1', displayName: 'Application', projectId: '207', read: ['public'] }]
    }));
    t.mock.method(projectsRepo, 'listByIds', async () => ([{ id: '207', name: 'Site C' }]));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'Document', keywords: 'river' }, header: () => null }, res);

    const [meta] = out.body[0].meta;
    assert.deepStrictEqual(meta.degraded, { missing: ['fileSize'] });
    assert.strictEqual(meta.searchResultsTotal, 3, 'and the page is still a measured page');
  });

  // The key is absent on a healthy search, not present and empty: a frontend that has to read
  // `meta.degraded.missing.length` learns to ignore it.
  await t.test('a search that answered in full carries no degraded key', async () => {
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 1, items: [{ id: '207', name: 'Site C', read: ['public'] }]
    }));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'site c' }, header: () => null }, res);

    assert.strictEqual(out.body[0].meta[0].degraded, undefined);
  });

  // A parameter nobody reads is the dangerous class: `page=2` for `pageNum=1` answers page one
  // with a 200, and nothing anywhere says so.
  await t.test('an unknown parameter is refused, not ignored', async () => {
    let searched = false;
    t.mock.method(aiSearch, 'searchProjects', async () => { searched = true; return { count: 0, items: [] }; });

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'site c', page: '2' }, header: () => null }, res);

    assert.strictEqual(out.status, 400);
    assert.match(out.body.error, /page/);
    assert.strictEqual(searched, false, 'a refused request must not reach the service');
  });

  // 0-BASED on the wire: eagle-public's currentPage is 1-based and api.ts:173 sends `pageNum - 1`.
  await t.test('pageNum is turned into a skip', async () => {
    let sent;
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => { sent = opts; return { count: 0, items: [] }; });

    const { res } = capture();
    await searchController.search({
      query: { dataset: 'Document', keywords: 'fish', pageNum: '2', pageSize: '10' },
      header: () => null
    }, res);

    assert.strictEqual(sent.skip, 20, 'page 3 of 10 starts at row 20');
  });

  // `ProjectService.getAll()` defaults its page to 0 and api.ts subtracts one, so -1 is reachable
  // from the live frontend. A negative skip is a 400 from the service.
  await t.test('a negative pageNum floors at the first page', async () => {
    let sent;
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => { sent = opts; return { count: 0, items: [] }; });

    const { res } = capture();
    await searchController.search({
      query: { dataset: 'Document', keywords: 'fish', pageNum: '-1', pageSize: '10' },
      header: () => null
    }, res);

    assert.strictEqual(sent.skip, 0);
  });

  await t.test('sortBy reaches the service as an orderby', async () => {
    let sent;
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => { sent = opts; return { count: 0, items: [] }; });

    const { res } = capture();
    await searchController.search({
      query: { dataset: 'Document', keywords: 'fish', sortBy: ['-displayName', ''] },
      header: () => null
    }, res);

    // `displayNameSort`, not `displayName`: SORT_KEYS maps the wire key onto the padded sort key
    // so "Item 2" pages before "Item 10" (src/helpers/natural-sort.js).
    assert.strictEqual(sent.orderby, 'displayNameSort desc, id asc');
  });

  // eagle-public holds Eagle ObjectIds; the indexes hold DEMI project ids. Comparing one with the
  // other matches nothing, which renders as an empty project tab rather than as an error.
  await t.test('an Eagle project id is translated before the filter is built', async () => {
    let sent;
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => { sent = opts; return { count: 0, items: [] }; });
    t.mock.method(projectsRepo, 'getByEagleId', async (access, eagleId) => {
      assert.ok(access, 'the lookup runs under the caller, not a system context');
      assert.strictEqual(eagleId, '588511c4aaecd9001b826192');
      return { id: '207', name: 'Site C' };
    });

    const { res } = capture();
    await searchController.search({
      query: { dataset: 'Document', keywords: 'fish', project: '588511c4aaecd9001b826192' },
      header: () => null
    }, res);

    assert.ok(sent.filter.includes("projectId eq '207'"), 'the DEMI id reaches OData');
    assert.ok(!sent.filter.includes('588511c4aaecd9001b826192'), 'the Eagle id must not');
    assert.ok(sent.filter.includes("read/any(r: search.in(r, 'public', ','))"), 'ACL clause intact');
  });

  // A notification _id can reach a Track project's `eagleId` via `epic_guid`, but its documents are
  // partitioned under the notification, so the project lookup must not win.
  await t.test('a project row carrying a notification id does not capture the filter', async () => {
    let sent;
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => { sent = opts; return { count: 0, items: [] }; });
    t.mock.method(projectsRepo, 'getByEagleId', async () =>
      ({ id: '353', eagleId: NOTIFICATION_EAGLE_ID, name: 'Shadow' }));
    t.mock.method(notificationsRepo, 'getById', async (access, id) => {
      assert.ok(access, 'the lookup runs under the caller, not a system context');
      assert.strictEqual(id, NOTIFICATION_EAGLE_ID);
      return { id: NOTIFICATION_EAGLE_ID, name: 'Bear Creek Quarry' };
    });

    const { res } = capture();
    await searchController.search({
      query: { dataset: 'Document', keywords: 'fish', 'and[project]': NOTIFICATION_EAGLE_ID },
      header: () => null
    }, res);

    assert.ok(sent.filter.includes(`projectId eq '${NOTIFICATION_EAGLE_ID}'`),
      `the notification id is the partition its documents live in: ${sent.filter}`);
    assert.ok(!sent.filter.includes("projectId eq '353'"), 'the shadowing project must not win');
  });

  // Dropping an unresolvable project filter would answer the whole corpus.
  await t.test('an unresolved project filter is QUERIED as a literal, never dropped', async () => {
    // A notification `_id` has no project row yet is its documents' partition, so the literal is
    // queried; an unmatched literal answers nothing on its own.
    let sent = null;
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => { sent = opts; return { count: 0, items: [] }; });
    t.mock.method(projectsRepo, 'getByEagleId', async () => null);

    const { out, res } = capture();
    await searchController.search({
      query: { dataset: 'Document', keywords: 'fish', project: '588511c4aaecd9001b826192' },
      header: () => null
    }, res);

    assert.deepStrictEqual(out.body[0].searchResults, []);
    assert.ok(sent, 'the request is now issued: an unresolved id may still name a real partition');
    // `sent.filter`, not `JSON.stringify(sent)`: the id can appear in a field that restricts nothing.
    assert.ok(sent.filter.includes("projectId eq '588511c4aaecd9001b826192'"),
      `the id must be in the FILTER, or the request widens to the corpus: ${sent.filter}`);
  });

  await t.test('an unresolved project filter on a dataset that cannot scope answers nothing', async () => {
    // `projects` has no `projectId`, so the same filter there would restrict nothing.
    let searched = false;
    t.mock.method(aiSearch, 'searchProjects', async () => { searched = true; return { count: 348, items: [] }; });
    t.mock.method(projectsRepo, 'getByEagleId', async () => null);

    const { out, res } = capture();
    await searchController.search({
      query: { dataset: 'Project', keywords: 'coal', project: '588511c4aaecd9001b826192' },
      header: () => null
    }, res);

    assert.strictEqual(out.body[0].count, 0);
    assert.strictEqual(searched, false, 'and nothing is queried for a scope that cannot be expressed');
  });

  // eagle-public's document row binds rowData.project.name and ._id without optional chaining, so a
  // string here throws on every render.
  await t.test('a document row carries the {_id, name} project pair, keyed on the Eagle id', async () => {
    t.mock.method(aiSearch, 'searchDocuments', async () => ({
      count: 1,
      items: [{ id: '58869abba4acd4014b81f55c', displayName: 'Application', projectId: '207', read: ['public'] }]
    }));
    t.mock.method(projectsRepo, 'listByIds', async () => ([
      { id: '207', name: 'Site C', eagleId: '588511c4aaecd9001b826192' }
    ]));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'Document', keywords: 'application' }, header: () => null }, res);

    const [row] = out.body[0].searchResults;
    assert.deepStrictEqual(row.project, { _id: '588511c4aaecd9001b826192', name: 'Site C' });
    assert.strictEqual(row.projectName, 'Site C', 'DEMI\'s own frontend still reads the flat name');
    assert.strictEqual(row.read, undefined, 'the row ACL is not published');
  });

  // An unreadable project still labels its documents; the link then holds an id eagle-api will not
  // resolve, kept visible rather than absent.
  await t.test('an unreadable parent project leaves the DEMI id in the pair', async () => {
    t.mock.method(aiSearch, 'searchDocuments', async () => ({
      count: 1,
      items: [{ id: 'doc1', displayName: 'Application', projectId: '207', read: ['public'] }]
    }));
    t.mock.method(projectsRepo, 'listByIds', async () => ([]));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'Document', keywords: 'application' }, header: () => null }, res);

    assert.deepStrictEqual(out.body[0].searchResults[0].project,
      { _id: '207', name: 'Associated Project' });
  });

  // eagle-public routes p/${_id}/project-details and then re-fetches that project FROM EAGLE-API
  // by the same id. A DEMI Track id here is a link that 404s.
  await t.test('a project row is keyed on the Eagle id, falling back to the DEMI id', async () => {
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 2,
      items: [
        { id: '207', name: 'Site C', legacyEagleId: '588511c4aaecd9001b826192', read: ['public'] },
        { id: '999', name: 'Track Only', read: ['public'] }
      ]
    }));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'site' }, header: () => null }, res);

    const [eagleBacked, trackOnly] = out.body[0].searchResults;
    assert.strictEqual(eagleBacked._id, '588511c4aaecd9001b826192');
    assert.strictEqual(eagleBacked.id, '207', 'the DEMI id stays available to DEMI\'s frontend');
    assert.strictEqual(trackOnly._id, '999', 'no Eagle counterpart: the DEMI id, never undefined');
    assert.strictEqual(eagleBacked.read, undefined, 'the row ACL is not published');
  });

  // The indexer SELECT renames `projectState` and `eagleId` (demi-projects-ds.json), so both branches
  // are compared field by field: hardcoded values would miss a change to one branch.
  await t.test('the same project reads the same on the Cosmos and AI Search branches', async () => {
    // The STORED shape, as merge/project.js writes it (`projectState` at :38, `eagleId` at :171).
    const stored = {
      id: '207',
      // A number in Cosmos; the index lacks the field and falls back to its string key, so both
      // branches coerce.
      trackProjectId: 207,
      name: 'Site C',
      sector: 'Energy-Electricity',
      region: 'Peace River',
      projectState: 'Completed',
      eagleId: '588511c4aaecd9001b826192',
      read: ['public'],
      isPublished: true,
      phaseIds: ['p1', 'p2'],
      activeWork: { trackWorkId: 2201, eaAct: '2018 Act', workType: 'Assessment', currentPhase: 'Process Planning' }
    };
    // The same row after the indexer's SELECT — the aliases applied, nothing else changed.
    const indexed = {
      id: stored.id,
      name: stored.name,
      sector: stored.sector,
      region: stored.region,
      status: stored.projectState,
      legacyEagleId: stored.eagleId,
      read: stored.read,
      phaseIds: stored.phaseIds,
      activeWorkId: stored.activeWork.trackWorkId,
      activeWorkAct: stored.activeWork.eaAct,
      activeWorkType: stored.activeWork.workType,
      activeWorkPhase: stored.activeWork.currentPhase
    };

    t.mock.method(projectsRepo, 'listPage', async () => [stored]);
    t.mock.method(projectsRepo, 'countVisible', async () => 1);
    t.mock.method(aiSearch, 'searchProjects', async () => ({ count: 1, items: [indexed] }));

    const fallback = capture();
    await searchController.search(
      { query: { dataset: 'Project', keywords: '', pageSize: '10' }, header: () => null },
      fallback.res);
    const [viaCosmos] = fallback.out.body[0].searchResults;

    const keyword = capture();
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'site c', pageSize: '10' }, header: () => null },
      keyword.res);
    const [viaIndex] = keyword.out.body[0].searchResults;

    // Fields derived from the payloads, not listed by hand, so a new disagreeing field is caught.
    const common = Object.keys(viaCosmos).filter(k => k in viaIndex);
    assert.ok(common.length >= 10, `expected both branches to emit ~12 fields, saw ${common.length}`);
    for (const field of common) {
      assert.deepStrictEqual(viaCosmos[field], viaIndex[field],
        `${field} disagrees between the Cosmos and AI Search branches`);
    }
    assert.ok(common.includes('trackProjectId'), 'trackProjectId must be in the comparison');
    assert.ok(common.includes('activeWork') && viaIndex.activeWork !== null, 'the populated activeWork is compared');
    // Pinned as well as compared: parity alone passes when both branches are wrong the same way.
    assert.strictEqual(viaCosmos.status, 'Completed', 'the real project state, not the default');
    assert.strictEqual(viaCosmos.legacyEagleId, '588511c4aaecd9001b826192');
    assert.strictEqual(viaCosmos._id, '588511c4aaecd9001b826192', 'keyed on the Eagle ObjectId');
    assert.strictEqual(viaCosmos.trackProjectId, '207', 'a String on both branches, not a Number');
  });

  await t.test('an empty stored region stays empty on both branches, never a placeholder', async () => {
    // eagle-api answers the stored '' and `/projects/:id` the stored value, so search must too.
    for (const [stored, expected] of [['', ''], [null, null], [undefined, null]]) {
      t.mock.restoreAll();
      const row = { id: '207', name: 'Site C', region: stored, read: ['public'], isPublished: true };
      t.mock.method(projectsRepo, 'listPage', async () => [row]);
      t.mock.method(projectsRepo, 'countVisible', async () => 1);
      t.mock.method(aiSearch, 'searchProjects', async () => ({ count: 1, items: [row] }));

      for (const keywords of ['', 'site c']) {
        const out = capture();
        await searchController.search(
          { query: { dataset: 'Project', keywords, pageSize: '10' }, header: () => null }, out.res);
        assert.strictEqual(out.out.body[0].searchResults[0].region, expected,
          `stored ${JSON.stringify(stored)}, keywords '${keywords}'`);
      }
    }
  });

  await t.test('an API-created project now reads the SAME state on both branches', async (t2) => {
    // The row comes from the real writer, not a literal, so a change in what createProject stores
    // shows up here.
    const projectController = require('../../src/controllers/nosql/project');
    let saved;
    t2.mock.method(projectsRepo, 'upsert', async (doc) => { saved = doc; return doc; });
    const noop = () => noop;
    await projectController.createProject(
      { body: { trackProjectId: 9001, name: 'Hand Made', status: 'Withdrawn',
        centroid: { coordinates: [0, 0] }, isPublished: true } },
      { json: noop, status: () => ({ json: noop }) });
    t2.mock.restoreAll();

    assert.strictEqual(saved.projectState, 'Withdrawn', 'stored under the name the sync uses');
    assert.ok(!('status' in saved), 'the wire name must not reach the container');

    // Cosmos branch: reads the stored row.
    t.mock.method(projectsRepo, 'listPage', async () => [saved]);
    t.mock.method(projectsRepo, 'countVisible', async () => 1);
    const c = capture();
    await searchController.search(
      { query: { dataset: 'Project', keywords: '', pageSize: '10' }, header: () => null }, c.res);
    assert.strictEqual(c.out.body[0].searchResults[0].status, 'Withdrawn',
      'a row written by createProject must not read back as the Active default');

    // Index branch: the stored row through the data source's `c.projectState AS status` alias.
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      count: 1,
      items: [{ id: saved.id, name: saved.name, status: saved.projectState, read: ['public'] }]
    }));
    const k = capture();
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'hand made', pageSize: '10' }, header: () => null }, k.res);

    assert.strictEqual(k.out.body[0].searchResults[0].status, 'Withdrawn',
      'the index now carries the real state — the writers agree, so the branches must too');
  });
});

// A status code cannot show the server answering something other than what was asked, so these
// assert on the request that went out or the total that came back.
test('the answer matches the request that was made', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const capture = () => {
    const out = { body: undefined, status: 200 };
    const res = {
      json: (d) => { out.body = d; return res; },
      status: (code) => { out.status = code; return res; }
    };
    return { out, res };
  };

  // The repositories hardcode their order, so a keywordless search with `sortBy` (every eagle-public
  // documents tab) must go to the index, and the fixed-order list read must not run.
  for (const [dataset, repo, list, service, sortBy, expected] of [
    ['Project', projectsRepo, 'listPage', 'searchProjects', '-name', 'name desc'],
    ['Document', documentsRepo, 'listVisible', 'searchDocuments', '-datePosted', 'datePosted desc']
  ]) {
    await t.test(`a sort on the keywordless ${dataset} list reaches the index, not the fixed order`,
      async () => {
        let listed = false;
        t.mock.method(repo, list, async () => { listed = true; return { items: [] }; });
        t.mock.method(repo, 'countVisible', async () => 0);
        let sent;
        t.mock.method(aiSearch, service, async (opts) => {
          sent = opts;
          return { count: 0, items: [] };
        });

        const { out, res } = capture();
        await searchController.search(
          { query: { dataset, keywords: '', sortBy, pageSize: '10' }, header: () => null }, res);

        assert.strictEqual(out.status, 200);
        assert.ok(sent, `${dataset}: a sorted search must reach the index`);
        assert.ok(sent.orderby.startsWith(expected),
          `${dataset}: expected an $orderby of ${expected}, got ${sent.orderby}`);
        assert.strictEqual(sent.matchAll, true, 'no keywords means match-all, not zero rows');
        assert.strictEqual(listed, false,
          `${dataset}: the fixed-order list read must not answer a sorted search`);
      });
  }

  // The Cosmos list read has fixed criteria, so a keywordless filter sent there would be dropped
  // and the whole corpus answered under a 200.
  await t.test('a keywordless filter is applied by the index, not dropped for the whole corpus',
    async () => {
      let listed = false;
      t.mock.method(documentsRepo, 'listVisible', async () => { listed = true; return { items: [] }; });
      t.mock.method(documentsRepo, 'countVisible', async () => 60578);
      let sent;
      t.mock.method(aiSearch, 'searchDocuments', async (opts) => {
        sent = opts;
        return { count: 2, items: [] };
      });

      const { out, res } = capture();
      await searchController.search({
        query: { dataset: 'Document', keywords: '', 'and[milestone]': '5cf00c03a266b7e1877504ca',
          pageSize: '10' },
        header: () => null
      }, res);

      assert.strictEqual(listed, false, 'the unfiltered list read must not answer a filtered search');
      // `milestoneId`, not `milestone`: eagle-public's four document facets send List ObjectIds and
      // the index carries the id column beside the label (ALIASES, eagle-query.js).
      assert.match(sent.filter, /milestoneId eq '5cf00c03a266b7e1877504ca'/);
      // DEFAULT_ORDER, not `search.score() desc`: `search: '*'` scores all rows equal, so `$skip`
      // paging would repeat and omit rows.
      assert.match(sent.orderby, /^displayNameSort asc/,
        `a keywordless page needs a stable order, got ${sent.orderby}`);
      assert.strictEqual(out.body[0].meta[0].searchResultsTotal, 2,
        'the total is the filtered one, never the corpus');
    });

  // A criteria search that matches nothing answers nothing; an `items.length === 0` fallback to the
  // list would answer the whole readable corpus.
  await t.test('a keywordless filter that matches nothing answers empty, never the corpus',
    async () => {
      let listed = false;
      t.mock.method(documentsRepo, 'listVisible', async () => { listed = true; return { items: [] }; });
      t.mock.method(documentsRepo, 'countVisible', async () => 60578);
      t.mock.method(aiSearch, 'searchDocuments', async () => ({ count: 0, items: [] }));

      const { out, res } = capture();
      await searchController.search({
        query: { dataset: 'Document', keywords: '', 'and[type]': 'nothing-matches-this',
          pageSize: '10' },
        header: () => null
      }, res);

      assert.strictEqual(out.status, 200);
      assert.strictEqual(listed, false, 'no fall-through to the unfiltered list');
      assert.deepStrictEqual(out.body[0].searchResults, []);
      assert.strictEqual(out.body[0].count, 0);
    });

  // `project` alone is not criteria (for the Project dataset's sake), but Document reads still go
  // to the index: the Cosmos read clamps at 1000 rows and empties later pages.
  await t.test('a project filter alone is served by the index, not the Cosmos read', async () => {
    t.mock.method(projectsRepo, 'getByEagleId', async () => ({ id: '207', name: 'Site C' }));
    t.mock.method(documentsRepo, 'listVisible', async () => {
      assert.fail('no document read may go to Cosmos — it cannot page past 1000 rows');
    });
    let sent = null;
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => {
      sent = opts;
      return { count: 4, items: [] };
    });

    const { out, res } = capture();
    await searchController.search({
      query: { dataset: 'Document', keywords: '', project: '588511c4aaecd9001b826192',
        pageSize: '500' },
      header: () => null
    }, res);

    // The Eagle ObjectId resolves to the DEMI id before it reaches the filter.
    assert.ok(sent, 'the index answered');
    assert.match(sent.filter, /207/, 'the resolved project id reaches the index filter');
    assert.strictEqual(out.body[0].meta[0].searchResultsTotal, 4);
  });

  // eagle-public sends `sortBy=&sortBy=` on every call, including the million-row projects map
  // read; treating it as a sort would move that read onto the index page cap.
  await t.test('eagle-public\'s empty double sortBy is not a sort', async () => {
    let listOpts;
    t.mock.method(projectsRepo, 'listPage', async (access, opts) => {
      listOpts = opts;
      return [];
    });
    t.mock.method(projectsRepo, 'countVisible', async () => 382);
    let searched = false;
    t.mock.method(aiSearch, 'searchProjects', async () => { searched = true; return { count: 0, items: [] }; });

    const { out, res } = capture();
    await searchController.search({
      query: { dataset: 'Project', keywords: '', sortBy: ['', ''], pageSize: '1000000' },
      header: () => null
    }, res);

    assert.strictEqual(out.status, 200, 'the projects map is not refused for a page ceiling');
    assert.strictEqual(searched, false, 'and it is not moved onto the index page ceiling either');
    // 5000, not 1000000: the route's own hard cap on `pageSize`, applied before either backend.
    // What matters here is that the Cosmos read is the one that got it.
    assert.strictEqual(listOpts.pageSize, 5000);
  });

  // A failed criteria search is neither empty nor the unfiltered list.
  await t.test('a keywordless filtered search that faults is a 502, never the unfiltered list',
    async () => {
      let listed = false;
      t.mock.method(documentsRepo, 'listVisible', async () => { listed = true; return { items: [] }; });
      t.mock.method(documentsRepo, 'countVisible', async () => 60578);
      t.mock.method(aiSearch, 'searchDocuments', async () => { throw new Error('index 400'); });

      const { out, res } = capture();
      await searchController.search({
        query: { dataset: 'Document', keywords: '', 'and[type]': 'x', pageSize: '10' },
        header: () => null
      }, res);

      assert.strictEqual(out.status, 502);
      assert.strictEqual(listed, false, 'a failed search must never be answered by the list read');
    });

  // `documentAuthor` is in neither the index nor the Cosmos predicate, so it is dropped and logged
  // while the rest of the filter still applies.
  await t.test('a key the index cannot express is still named in the log', async () => {
    t.mock.method(aiSearch, 'searchDocuments', async () => ({ count: 0, items: [] }));
    const warned = [];
    t.mock.method(logger, 'warn', (msg) => warned.push(String(msg)));

    const { res } = capture();
    await searchController.search({
      query: { dataset: 'Document', keywords: '', 'and[documentAuthor]': 'x', pageSize: '5' },
      header: () => null
    }, res);

    assert.ok(warned.some(m => /dropped filter/.test(m) && /documentAuthor/.test(m)),
      `an inexpressible key must be named, got: ${JSON.stringify(warned)}`);
  });

  // A resolved project id must reach both the rows and the total; the index computes `count` under
  // the filter it gets, so a lost project reports the corpus.
  await t.test('a project-scoped list is scoped, and so is its total', async () => {
    let sent = null;
    t.mock.method(projectsRepo, 'getByEagleId', async (access, eagleId) => {
      assert.strictEqual(eagleId, '588511c4aaecd9001b826192');
      return { id: '207', name: 'Site C' };
    });
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => {
      sent = opts;
      return { count: 4, items: [] };
    });

    const { out, res } = capture();
    await searchController.search({
      query: {
        dataset: 'Document',
        keywords: '',
        project: '588511c4aaecd9001b826192',
        pageNum: '0',
        pageSize: '10'
      },
      header: () => null
    }, res);

    assert.match(sent.filter, /projectId/, 'the scope is applied as a filter, not dropped');
    assert.match(sent.filter, /207/, 'and it is the resolved DEMI id, not the Eagle ObjectId');
    assert.strictEqual(out.body[0].meta[0].searchResultsTotal, 4);
  });

  // The client pages in units of `pageSize`, not `min(pageSize, 250)`; eagle-public's "Show All"
  // offers 500.
  await t.test('the offset is in the page size the caller asked for', async () => {
    let sent;
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => {
      sent = opts;
      return { count: 3000, items: [] };
    });

    const { res } = capture();
    await searchController.search({
      query: { dataset: 'Document', keywords: 'fish', pageNum: '2', pageSize: '500' },
      header: () => null
    }, res);

    assert.strictEqual(sent.skip, 1000, 'page 3 of 500 starts at row 1000, not row 500');
    assert.strictEqual(sent.top, 500, 'and asks for the page the caller asked for');
  });

  // Cosmos has no offset, so `readPage` reads `skip + pageSize` and drops `skip`; a lost skip looks
  // the same on the wire, so rows are compared page against page.
  const expectedIds = (prefix, from) => Array.from({ length: 10 }, (_, i) => `${prefix}-${from + i}`);

  await t.test('the keywordless project list serves page 2 from row 10, not row 0', async (tt) => {
    const rows = ids('proj', 40).map(row => ({ ...row, read: ['public'] }));
    pagedCosmos(tt, c => (c === projectsRepo.CONTAINER ? rows : []));
    tt.mock.method(projectsRepo, 'countVisible', async () => rows.length);

    const idsOnPage = async (pageNum) => {
      const { out, res } = capture();
      await searchController.search({
        query: { dataset: 'Project', keywords: '', pageNum: String(pageNum), pageSize: '10' },
        header: () => null
      }, res);
      return out.body[0].searchResults.map(r => r._id);
    };

    const first = await idsOnPage(0);
    const second = await idsOnPage(1);
    assert.deepStrictEqual(first, expectedIds('proj', 0));
    assert.deepStrictEqual(second, expectedIds('proj', 10), 'page 2 starts at row 10');
  });

  // A page bigger than the search layer will assemble is refused, not shortened under a large total.
  await t.test('a keyword page beyond the ceiling is refused, not silently shortened', async () => {
    let searched = false;
    t.mock.method(aiSearch, 'searchDocuments', async () => {
      searched = true;
      return { count: 0, items: [] };
    });

    const { out, res } = capture();
    await searchController.search({
      query: { dataset: 'Document', keywords: 'fish', pageSize: '501' },
      header: () => null
    }, res);

    assert.strictEqual(out.status, 400);
    assert.match(out.body.error, /pageSize/);
    assert.strictEqual(searched, false);
  });

  // DEMI's frontend asks for pageSize=500 with no pageNum; the total must still be counted, not
  // taken from the page length.
  await t.test('a page-sized list does not report its own length as the corpus', async () => {
    t.mock.method(projectsRepo, 'listPage', async () => [{ id: '207', name: 'Site C', read: ['public'] }]);
    t.mock.method(projectsRepo, 'countVisible', async () => 4210);

    const { out, res } = capture();
    await searchController.search({
      query: { dataset: 'Project', keywords: '', pageSize: '500' },
      header: () => null
    }, res);

    assert.strictEqual(out.body[0].searchResults.length, 1);
    assert.strictEqual(out.body[0].meta[0].searchResultsTotal, 4210,
      'the measured total, never the number of rows on the page');
  });

  // An absent count means not measured; the envelope must not publish the page length instead.
  await t.test('an unmeasured total is omitted, not filled in from the page', async () => {
    t.mock.method(aiSearch, 'searchProjects', async () => ({
      items: [{ id: '207', name: 'Site C', read: ['public'] }]
    }));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'Project', keywords: 'site c' }, header: () => null }, res);

    assert.strictEqual(out.body[0].searchResults.length, 1);
    assert.ok(Array.isArray(out.body[0].meta), 'meta itself must survive — project.service.ts:49');
    assert.strictEqual(out.body[0].meta[0].searchResultsTotal, undefined,
      'not 1, which is the page length wearing the corpus total\'s name');
  });

  // A failed search is not an empty one: 200 with `[]` would tell /projects the registry is empty.
  await t.test('a failed list is reported, not published as an empty registry', async () => {
    t.mock.method(projectsRepo, 'listPage', async () => {
      throw new Error('Cosmos DB request rate is large');
    });

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'Project', keywords: '', pageSize: '10' }, header: () => null }, res);

    assert.strictEqual(out.status, 502);
    assert.ok(!Array.isArray(out.body), 'no result set is published for a search that did not run');
  });

  // A 400 from the search service answers 502, never the keywordless corpus listing.
  await t.test('a keyword search that faults never answers with the unkeyworded list', async () => {
    let listed = false;
    t.mock.method(aiSearch, 'searchProjects', async () => {
      throw Object.assign(new Error('HTTP 400 invalid expression'), { status: 400 });
    });
    t.mock.method(projectsRepo, 'listPage', async () => {
      listed = true;
      return [{ id: '999', name: 'Some Other Project', read: ['public'] }];
    });

    const { out, res } = capture();
    await searchController.search({
      query: { dataset: 'Project', keywords: 'zarquonflux', 'and[centroid]': 'x' },
      header: () => null
    }, res);

    assert.strictEqual(listed, false, 'the corpus listing must not answer a keyword search');
    assert.strictEqual(out.status, 502);
  });

  // The 502 body names the failure class and a trace id, so schema drift is visible from the
  // browser without a Log Analytics query.
  await t.test('a 502 names the class of failure and the trace to open', async (tt) => {
    await tt.test('a missing index field is drift, and the field is named', async () => {
      t.mock.method(aiSearch, 'searchDocuments', async () => {
        throw Object.assign(new Error(
          "HTTP 400 {\"error\":{\"message\":\"Invalid expression: Could not find a property named " +
          "'fileSize' on type 'search.document'. Parameter name: $select\"}} [abc123]"), { status: 400 });
      });

      const { out, res } = capture();
      await searchController.search({
        id: 'req-42', query: { dataset: 'Document', keywords: 'mine' }, header: () => null
      }, res);

      assert.strictEqual(out.status, 502);
      assert.deepStrictEqual(out.body, {
        error: 'Document search is unavailable',
        code: 'SEARCH_SCHEMA_DRIFT',
        field: 'fileSize',
        traceId: 'req-42'
      });
    });

    // The upstream text carries the service endpoint, the index name and the caller's own ACL
    // clause. This route is reachable anonymously.
    await tt.test('anything else is an upstream failure, described by nothing but its code',
      async () => {
        t.mock.method(aiSearch, 'searchProjects', async () => {
          throw new Error("HTTP 403 Forbidden. demi-search-prod.search.windows.net rejected " +
            "filter read/any(r: r eq 'sysadmin')");
        });

        const { out, res } = capture();
        await searchController.search({
          id: 'req-43', query: { dataset: 'Project', keywords: 'mine' }, header: () => null
        }, res);

        assert.strictEqual(out.status, 502);
        assert.deepStrictEqual(out.body, {
          error: 'Project search is unavailable',
          code: 'SEARCH_UPSTREAM',
          traceId: 'req-43'
        });
      });
  });

  // `project._id` is the Eagle ObjectId eagle-public routes on; `projectId` is the DEMI id, the
  // Cosmos partition key. Neither is derived from the other.
  await t.test('a document row carries the DEMI project id as well as the Eagle one', async () => {
    t.mock.method(aiSearch, 'searchDocuments', async () => ({
      count: 1,
      items: [{ id: 'doc1', displayName: 'Application', projectId: '207', read: ['public'] }]
    }));
    t.mock.method(projectsRepo, 'listByIds', async () => ([
      { id: '207', name: 'Site C', eagleId: '588511c4aaecd9001b826192' }
    ]));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'Document', keywords: 'application' }, header: () => null }, res);

    const [row] = out.body[0].searchResults;
    assert.strictEqual(row.projectId, '207', 'the DEMI id, which is the partition key');
    assert.strictEqual(row.project._id, '588511c4aaecd9001b826192', 'the Eagle id, for the link');
  });

  await t.test('a chunk row carries the DEMI project id as well as the Eagle one', async () => {
    t.mock.method(aiSearch, 'searchChunks', async () => ({
      count: 1,
      items: [{ chunkId: 'c1', documentId: 'd1', projectId: '207', pageNumber: 1, read: ['public'] }]
    }));
    t.mock.method(documentsRepo, 'listByIds', async () => ([{ id: 'd1', displayName: 'Doc' }]));
    t.mock.method(projectsRepo, 'listByIds', async () => ([
      { id: '207', name: 'Site C', eagleId: '588511c4aaecd9001b826192' }
    ]));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'DocumentChunk', keywords: 'river' }, header: () => null }, res);

    const [row] = out.body[0].searchResults;
    assert.strictEqual(row.projectId, '207');
    assert.strictEqual(row.project._id, '588511c4aaecd9001b826192');
  });

  // The availability test checks only for a 200, so its URL, read from the param file, must need
  // AI Search; a Cosmos-served query stays green through an index outage.
  await t.test('the deployed prod availability probe fails when AI Search does', async () => {
    const params = fs.readFileSync(
      path.join(__dirname, '..', '..', 'azure', 'main.prod.bicepparam'), 'utf8');
    const match = /^param availabilityUrl = '([^']+)'$/m.exec(params);
    assert.ok(match, 'prod must set availabilityUrl');
    const query = Object.fromEntries(new URL(match[1]).searchParams);

    t.mock.method(aiSearch, 'searchDocuments', async () => {
      throw new Error('AI Search is down');
    });

    // Cosmos answers normally on purpose: a throwing stub would produce the 502 this asserts.
    let servedByCosmos = false;
    t.mock.method(projectsRepo, 'listPage', async () => {
      servedByCosmos = true;
      return [];
    });
    t.mock.method(projectsRepo, 'countVisible', async () => 0);
    t.mock.method(logger, 'error', () => {});

    const { out, res } = capture();
    await searchController.search({ query, header: () => null }, res);

    assert.strictEqual(servedByCosmos, false,
      'a query Cosmos can answer stays 200 through a total AI Search outage');
    assert.strictEqual(out.status, 502,
      'an AI Search outage must show up as a non-200 on the probe URL');
  });

  // Every repository row is redacted before a label is read off it. Defaults are 4/4, so only a
  // `vis` dial makes a skipped `redactAllForAccess` call visible.
  await t.test('a dialled-down project name never labels a document row', async () => {
    t.mock.method(aiSearch, 'searchDocuments', async () => ({
      count: 1,
      items: [{ id: 'doc1', displayName: 'Application', projectId: '207', read: ['public'] }]
    }));
    t.mock.method(projectsRepo, 'listByIds', async () => ([{
      id: '207',
      name: 'Site C',
      eagleId: '588511c4aaecd9001b826192',
      // Level 2 and below only; an anonymous caller is level 4.
      vis: { name: 2, eagleId: 2 },
      read: ['staff'],
      s3Key: 'x',
      _etag: 'e'
    }]));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'Document', keywords: 'application' }, header: () => null }, res);

    const [row] = out.body[0].searchResults;
    assert.strictEqual(row.projectName, 'Associated Project');
    assert.deepStrictEqual(row.project, { _id: '207', name: 'Associated Project' },
      'the withheld Eagle id leaves the DEMI id in the pair');
  });

  await t.test('a chunk row is built from redacted parent rows', async () => {
    t.mock.method(aiSearch, 'searchChunks', async () => ({
      count: 1,
      items: [{ chunkId: 'c1', documentId: 'd1', projectId: '207', pageNumber: 3, snippet: 'a river' }]
    }));
    t.mock.method(documentsRepo, 'listByIds', async () => ([{
      id: 'd1',
      displayName: 'First',
      documentFileName: 'first.pdf',
      vis: { displayName: 2, documentFileName: 2 },
      // `type` carries no dial, so it proves the redactor is not simply emptying the row.
      type: 'PDF Document',
      milestone: 'Other',
      milestoneId: 'm1',
      datePosted: '2020-01-01T00:00:00.000Z',
      read: ['staff'],
      s3Key: 'x',
      _etag: 'e'
    }]));
    t.mock.method(projectsRepo, 'listByIds', async () => ([{
      id: '207',
      name: 'Site C',
      eagleId: '588511c4aaecd9001b826192',
      vis: { name: 2, eagleId: 2 },
      read: ['staff'],
      _etag: 'e'
    }]));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'DocumentChunk', keywords: 'river' }, header: () => null }, res);

    assert.deepStrictEqual(out.body[0].searchResults, [{
      _id: 'd1',
      _schemaName: 'DocumentChunk',
      documentId: 'd1',
      chunkId: 'c1',
      projectId: '207',
      project: { _id: '207', name: 'Associated Project' },
      projectName: 'Associated Project',
      documentName: 'Untitled Document',
      documentType: 'PDF Document',
      milestone: 'Other',
      milestoneId: 'm1',
      datePosted: '2020-01-01T00:00:00.000Z',
      pageNumber: 3,
      // The hit carried no flag, which is what a chunk indexed before page provenance looks like.
      pageNumbered: false,
      content: '',
      snippet: 'a river',
      snippets: ['a river'],
      passages: [{ text: 'a river', pageNumber: null, pageNumbered: false }],
      matchCount: 1
    }], 'no s3Key, no read[], no _etag, no vis, and no withheld label');
  });

  // eagle-public renders "Page N" and a `#page=N` link off this flag alone; without it N is only a
  // passage index and the link opens the wrong page.
  await t.test('a page-numbered chunk says so on the row it returns', async () => {
    t.mock.method(aiSearch, 'searchChunks', async () => ({
      count: 1,
      items: [{
        chunkId: 'c1', documentId: 'd1', projectId: '207', pageNumber: 12,
        pageNumbered: true, snippet: 'a river'
      }]
    }));
    t.mock.method(documentsRepo, 'listByIds', async () => ([{ id: 'd1', displayName: 'First' }]));
    t.mock.method(projectsRepo, 'listByIds', async () => ([{ id: '207', name: 'Site C' }]));

    const { out, res } = capture();
    await searchController.search(
      { query: { dataset: 'DocumentChunk', keywords: 'river' }, header: () => null }, res);

    const [row] = out.body[0].searchResults;
    assert.strictEqual(row.pageNumber, 12);
    assert.strictEqual(row.pageNumbered, true);
    assert.deepStrictEqual(row.passages, [{ text: 'a river', pageNumber: 12, pageNumbered: true }],
      'and the passage carries the same page, which is what labels the snippet it sits beside');
  });

  await t.test('a summary citation is built from redacted parent rows', async () => {
    t.mock.method(aiSearch, 'searchChunks', async () => ({
      items: [{ chunkId: 'c1', documentId: 'd1', projectId: '207', pageNumber: 5 }]
    }));
    t.mock.method(chunksRepo, 'getById', async () => ({
      id: 'c1', documentId: 'd1', projectId: '207', pageNumber: 5, content: 'text of c1'
    }));
    t.mock.method(documentsRepo, 'listByIds', async () => ([{
      id: 'd1',
      displayName: 'First',
      documentFileName: 'first.pdf',
      vis: { displayName: 2, documentFileName: 2 },
      read: ['staff'],
      s3Key: 'x',
      _etag: 'e'
    }]));
    t.mock.method(projectsRepo, 'listByIds', async () => ([{
      id: '207',
      name: 'Site C',
      vis: { name: 2 },
      read: ['staff'],
      _etag: 'e'
    }]));
    t.mock.method(summarizer, 'summarize', async () => ({
      summary: 'a grounded answer',
      citations: [0],
      usage: null,
      estimatedCostCad: 0
    }));

    const { out, res } = capture();
    await searchController.summarize({ query: { keywords: 'caribou' }, header: () => null }, res);

    assert.deepStrictEqual(out.body.citations, [{
      n: 1,
      chunkId: 'c1',
      documentId: 'd1',
      projectId: '207',
      pageNumber: 5,
      documentName: 'Untitled Document',
      projectName: 'Associated Project'
    }]);
  });

  // `summarize` must read chunk metadata off the redacted row; `projectId` carries a dial hiding it
  // from this anonymous caller, so reading the raw `fetched` row leaks it.
  await t.test('an uncatalogued or classified chunk field never reaches a citation', async () => {
    t.mock.method(aiSearch, 'searchChunks', async () => ({
      items: [{ chunkId: 'c1', documentId: 'd1', projectId: '207', pageNumber: 9 }]
    }));
    t.mock.method(chunksRepo, 'getById', async () => ({
      id: 'c1',
      documentId: 'd1',
      pageNumber: 9,
      content: 'text of c1',
      // Classified below this caller's level: must not survive redaction.
      projectId: '207',
      vis: { projectId: 1 },
      // Not in the chunk catalog at all, and the ACL snapshot itself: neither belongs in a response.
      secretField: 'must not leak',
      read: ['staff']
    }));
    t.mock.method(documentsRepo, 'listByIds', async () => ([{
      id: 'd1',
      displayName: 'First',
      documentFileName: 'first.pdf',
      vis: { displayName: 2, documentFileName: 2 },
      read: ['staff'],
      _etag: 'e'
    }]));
    t.mock.method(projectsRepo, 'listByIds', async () => ([]));
    t.mock.method(summarizer, 'summarize', async () => ({
      summary: 'a grounded answer',
      citations: [0],
      usage: null,
      estimatedCostCad: 0
    }));

    const { out, res } = capture();
    await searchController.summarize({ query: { keywords: 'caribou' }, header: () => null }, res);

    assert.deepStrictEqual(out.body.citations, [{
      n: 1,
      chunkId: 'c1',
      documentId: 'd1',
      projectId: '',
      pageNumber: 9,
      documentName: 'Untitled Document',
      projectName: 'Associated Project'
    }], 'documentId/pageNumber reach the response; the dialled-down projectId, the uncatalogued ' +
      'key, and the vis/read fields must not');
  });
});
