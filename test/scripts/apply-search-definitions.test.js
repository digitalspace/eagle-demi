'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const script = require('../../src/scripts/apply-search-definitions');

test('apply-search-definitions', async (t) => {
  await t.test('loads every index and indexer definition, indexes sorted', () => {
    const indexes = script.load(script.INDEX_DIR).map(d => d.body.name);
    const indexers = script.load(script.INDEXER_DIR).map(d => d.body.name);
    assert.deepStrictEqual(indexes,
      ['activities', 'chunks', 'documents', 'project-notifications', 'projects']);
    assert.deepStrictEqual(indexers, ['activities-indexer', 'chunks-indexer',
      'documents-indexer', 'project-notifications-indexer', 'projects-indexer']);
  });

  await t.test('every indexer targets an index that is being applied alongside it', () => {
    // An indexer fails to create if its target index is missing, so a definition set that
    // references an index nobody ships is a run that dies half-applied.
    const indexNames = new Set(script.load(script.INDEX_DIR).map(d => d.body.name));
    for (const { body } of script.load(script.INDEXER_DIR)) {
      assert.ok(
        indexNames.has(body.targetIndexName),
        `${body.name} targets "${body.targetIndexName}", which no index definition declares`
      );
    }
  });

  await t.test('every indexer names a data source, and none is shipped as a definition', () => {
    // The script refuses to create data sources: connectionString comes back redacted on export,
    // so a definition file could only ever restore a broken one.
    const fs = require('fs');
    const dsDir = path.join(script.INDEX_DIR, '..', 'datasources');
    const onDisk = fs.readdirSync(dsDir).filter(f => f.endsWith('.json'));
    assert.ok(onDisk.length > 0, 'data source definitions should still be committed for reference');
    for (const { body } of script.load(script.INDEXER_DIR)) {
      assert.ok(body.dataSourceName, `${body.name} has no dataSourceName`);
    }
  });

  await t.test('--live is opt-in and unknown flags are refused', () => {
    assert.strictEqual(script.parseArgs([]).live, false);
    assert.strictEqual(script.parseArgs(['--live']).live, true);
    assert.strictEqual(script.parseArgs(['--only', 'chunks']).only, 'chunks');
    assert.throws(() => script.parseArgs(['--only']), /needs a value/);
    // `--only "$IDX"` with IDX unset passes value() and would otherwise apply everything.
    assert.throws(() => script.parseArgs(['--only', '']), /empty value/);
    assert.throws(() => script.parseArgs(['--only', '   ']), /empty value/);
    assert.throws(() => script.parseArgs(['--oops']), /unknown flag/);
  });

  // Drive run() with a stubbed transport: the files alone cannot prove the guard still runs.
  const stub = (t2, handler) => {
    const calls = [];
    const original = global.fetch;
    // Mock the token too: a real getToken() succeeds off a local az login but fails in CI after ~15s.
    const aiSearch = require('../../src/search/ai-search');
    t2.mock.method(aiSearch, 'getToken', async () => 'test-token');
    global.fetch = async (url, init) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      return handler ? handler(url, init) : { status: 404, text: async () => '' };
    };
    t2.after(() => { global.fetch = original; });
    return calls;
  };
  const ENDPOINT = 'https://svc.search.windows.net';
  // GET: data sources exist, indexes and indexers do not yet (the state a first run meets).
  // PUT: created. A stub that 404s a PUT makes run() throw before it can be observed.
  const ok = (url, init) => ({
    status: init.method === 'PUT' ? 201 : (/\/datasources\//.test(url) ? 200 : 404),
    text: async () => ''
  });

  await t.test('a dry run writes nothing at all', async (tt) => {
    const calls = stub(tt, ok);
    await script.run({ endpoint: ENDPOINT, live: false, only: '', liveNames: ['demi-chunks'] });
    assert.strictEqual(calls.filter(c => c.method === 'PUT').length, 0, 'a dry run must issue no PUT');
    assert.ok(calls.length > 0, 'and it must still probe, or it proved nothing');
  });

  await t.test('--live writes indexes before indexers, and never a data source', async (tt) => {
    const calls = stub(tt, ok);
    await script.run({ endpoint: ENDPOINT, live: true, only: '', liveNames: ['demi-chunks'] });
    const puts = calls.filter(c => c.method === 'PUT').map(c => c.url.split('?')[0].replace(ENDPOINT, ''));
    assert.deepStrictEqual(puts, [
      '/indexes/activities', '/indexes/chunks', '/indexes/documents',
      '/indexes/project-notifications', '/indexes/projects',
      '/indexers/activities-indexer', '/indexers/chunks-indexer', '/indexers/documents-indexer',
      '/indexers/project-notifications-indexer', '/indexers/projects-indexer'
    ], 'every index must be written before any indexer');
    assert.strictEqual(
      calls.filter(c => c.method === 'PUT' && /\/datasources\//.test(c.url)).length, 0,
      'a data source must never be written — connectionString is redacted on export'
    );
  });

  // A field added to an index and the committed data source reports green, but the live SELECT
  // keeps the new field null.
  await t.test('a live data source whose query differs from the committed copy is called out', async (tt) => {
    const lines = [];
    const log = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    tt.after(() => { console.log = log; });

    stub(tt, (url, init) => {
      const ds = /\/datasources\/([^?]+)/.exec(url)?.[1];
      if (ds) {
        // Only the documents data source is stale, so the tally must be 1, not one per data source.
        const body = ds === 'demi-documents-ds'
          ? { name: ds, container: { name: 'documents', query: 'SELECT c.id, c.displayName FROM c' } }
          : script.readCommittedDataSource(ds);
        return { status: 200, text: async () => JSON.stringify(body) };
      }
      return { status: init.method === 'PUT' ? 201 : 404, text: async () => '' };
    });

    await script.run({ endpoint: ENDPOINT, live: false, only: '', liveNames: [] });
    const out = lines.join('\n');
    assert.match(out, /data source demi-documents-ds DIFFERS/);
    assert.match(out, /stays null/);
    assert.match(out, /WARNING: 1 data source\(s\) differ/);
  });

  await t.test('an unchanged data source raises nothing', async (tt) => {
    const lines = [];
    const log = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    tt.after(() => { console.log = log; });

    const committed = script.readCommittedDataSource('demi-documents-ds');
    stub(tt, (url, init) => {
      if (/\/datasources\//.test(url)) {
        return { status: 200, text: async () => JSON.stringify(committed) };
      }
      return { status: init.method === 'PUT' ? 201 : 404, text: async () => '' };
    });

    await script.run({ endpoint: ENDPOINT, live: false, only: 'documents', liveNames: [] });
    assert.ok(!lines.join('\n').includes('DIFFERS'), 'a matching query must not warn');
  });

  /** The committed `projects` index with `n` fields lopped off the end — a plausible "live" copy. */
  const projectsMinus = (n) => {
    const body = script.load(script.INDEX_DIR).find(d => d.body.name === 'projects').body;
    return { ...body, fields: body.fields.slice(0, body.fields.length - n) };
  };

  /**
   * Serve `live` for GET /indexes/projects, `ok` for everything else. The `@odata.*` pair is what a
   * real GET returns and no committed file carries, so the fixture keeps it.
   */
  const servingProjects = (live) => (url, init) =>
    (init.method === 'GET' && /\/indexes\/projects\?/.test(url))
      ? {
        status: 200,
        text: async () => JSON.stringify({
          '@odata.context': `${ENDPOINT}/$metadata#indexes/$entity`,
          '@odata.etag': '"0x8DF007286A35D0A"',
          ...live
        })
      }
      : ok(url, init);

  // Adding a field to a live index is supported in place (azure/search/README.md "Adding a field").
  await t.test('run() writes a live index when the change only ADDS fields', async (tt) => {
    const calls = stub(tt, servingProjects(projectsMinus(7)));
    await script.run({ endpoint: ENDPOINT, live: true, only: 'projects', liveNames: ['projects'] });
    assert.strictEqual(
      calls.filter(c => c.method === 'PUT' && /\/indexes\/projects\?/.test(c.url)).length, 1,
      'an additive widening of the serving index must be applied');
  });

  // A drop, retype or flipped flag is a rebuild; here `region` is redefined as a collection.
  await t.test('run() still refuses a live index when a field is redefined', async (tt) => {
    const live = projectsMinus(7);
    live.fields = live.fields.map(f => f.name === 'region' ? { ...f, type: 'Collection(Edm.String)' } : f);
    const calls = stub(tt, servingProjects(live));

    await assert.rejects(
      () => script.run({ endpoint: ENDPOINT, live: true, only: 'projects', liveNames: ['projects'] }),
      /refusing to PUT index "projects".*NOT additive.*field "region" is redefined/s
    );
    assert.strictEqual(calls.filter(c => c.method === 'PUT').length, 0, 'and it must refuse BEFORE writing anything');
  });

  await t.test('run() still refuses a live index when a field would be dropped', async (tt) => {
    const live = projectsMinus(7);
    live.fields = [...live.fields, { name: 'popularity', type: 'Edm.Int32', filterable: true }];
    stub(tt, servingProjects(live));

    await assert.rejects(
      () => script.run({ endpoint: ENDPOINT, live: true, only: 'projects', liveNames: ['projects'] }),
      /field "popularity" exists live and is missing from the committed copy/
    );
  });

  // Field count is not the question. This live copy has the same fields as the committed one and a
  // different BM25 `b`, which reorders every result the app already serves.
  await t.test('run() refuses a live index whose ranking would change, though no field moves', async (tt) => {
    const live = projectsMinus(0);
    live.similarity = { ...live.similarity, b: 0.2 };
    stub(tt, servingProjects(live));

    await assert.rejects(
      () => script.run({ endpoint: ENDPOINT, live: true, only: 'projects', liveNames: ['projects'] }),
      /an index-level property outside `fields` changed/
    );
  });

  // A serving index that cannot be read back must stop the run, not fall through to a PUT.
  await t.test('run() refuses when the serving index cannot be read back', async (tt) => {
    const calls = stub(tt, (url, init) =>
      (init.method === 'GET' && /\/indexes\/projects\?/.test(url))
        ? { status: 500, text: async () => 'upstream exploded' }
        : ok(url, init));

    await assert.rejects(
      () => script.run({ endpoint: ENDPOINT, live: true, only: 'projects', liveNames: ['projects'] }),
      /Refusing to PUT over a schema this cannot see/
    );
    assert.strictEqual(calls.filter(c => c.method === 'PUT').length, 0);
  });

  // A fresh service: the app points at the names but nothing exists yet, so creating is additive.
  await t.test('run() creates a serving-named index that is absent (greenfield service)', async (tt) => {
    const calls = stub(tt, (url, init) =>
      (init.method === 'GET' && /\/indexes\/projects\?/.test(url))
        ? { status: 404, text: async () => '{"error":{"message":"No index with the name"}}' }
        : ok(url, init));
    await script.run({ endpoint: ENDPOINT, live: true, only: 'projects', liveNames: ['projects'] });
    assert.strictEqual(calls.filter(c => c.method === 'PUT' && /\/indexes\/projects\?/.test(c.url)).length, 1);
  });

  const KEYWORD_SWITCHES = ['SEARCH_INDEX_ACTIVITIES', 'SEARCH_INDEX_PROJECT_NOTIFICATIONS'];
  const configWith = (env) => {
    const aiSearch = require('../../src/search/ai-search');
    const saved = Object.fromEntries(KEYWORD_SWITCHES.map(key => [key, process.env[key]]));
    try {
      for (const key of KEYWORD_SWITCHES) {
        if (env[key] === undefined) delete process.env[key];
        else process.env[key] = env[key];
      }
      return aiSearch.config();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
  const SWITCHED_ON = {
    SEARCH_INDEX_ACTIVITIES: 'activities', SEARCH_INDEX_PROJECT_NOTIFICATIONS: 'project-notifications'
  };
  /** Serve a live `name` index holding one field the committed copy lacks, so a PUT would drop it. */
  const servingDroppable = (tt, name) => {
    const committed = script.load(script.INDEX_DIR).find(d => d.body.name === name).body;
    const live = { ...committed, fields: [...committed.fields, { name: 'legacyOnly', type: 'Edm.String' }] };
    const target = new RegExp(`/indexes/${name}\\?`);
    return stub(tt, (url, init) =>
      (init.method === 'GET' && target.test(url))
        ? { status: 200, text: async () => JSON.stringify(live) }
        : ok(url, init));
  };
  for (const name of ['activities', 'project-notifications']) {
    await t.test(`run() refuses a non-additive PUT of ${name} with its switch set`, async (tt) => {
      const calls = servingDroppable(tt, name);
      const liveNames = script.servingNames(configWith(SWITCHED_ON));
      await assert.rejects(
        () => script.run({ endpoint: ENDPOINT, live: true, only: name, liveNames, log: () => {} }),
        new RegExp(`refusing to PUT index "${name}".*NOT additive.*field "legacyOnly"`, 's')
      );
      assert.strictEqual(calls.filter(c => c.method === 'PUT').length, 0, 'and it must refuse BEFORE writing anything');
    });

    // An empty switch means Cosmos answers, so the index is not serving: this is its rebuild window.
    await t.test(`run() writes a non-additive ${name} with its switch unset`, async (tt) => {
      const calls = servingDroppable(tt, name);
      const liveNames = script.servingNames(configWith({}));
      await script.run({ endpoint: ENDPOINT, live: true, only: name, liveNames, log: () => {} });
      assert.strictEqual(
        calls.filter(c => c.method === 'PUT' && new RegExp(`/indexes/${name}\\?`).test(c.url)).length, 1);
    });
  }

  await t.test('a DRY RUN is never refused, even when the names are the live ones', async (tt) => {
    // A dry run must work in every state and say which indexes are serving.
    // The live names exist on the service (a 404 would be a fresh service, which is not "serving").
    const calls = stub(tt, (url, init) =>
      (init.method === 'GET' && /\/indexes\/[a-z]+\?/.test(url))
        ? { status: 200, text: async () => JSON.stringify({ fields: [] }) }
        : ok(url, init));
    const lines = [];
    const realLog = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
      await script.run({ endpoint: ENDPOINT, live: false, only: '', liveNames: ['chunks', 'projects', 'documents'] });
    } finally {
      console.log = realLog;
    }
    assert.strictEqual(calls.filter(c => c.method === 'PUT').length, 0, 'still writes nothing');
    assert.ok(calls.length > 0, 'and it still probes, so it reported something');
    // AND IT SAYS WHICH ARE SERVING. Without this the test asserted nothing the previous dry-run
    // test did not already cover, and blanking the marker left the suite green.
    for (const name of ['chunks', 'projects', 'documents']) {
      assert.ok(
        lines.some(l => l.includes(name) && l.includes('SERVING TRAFFIC')),
        `the dry run must mark "${name}" as serving; output was:\n${lines.join('\n')}`
      );
    }
  });

  await t.test('a missing data source stops the run rather than creating one', async (tt) => {
    stub(tt, () => ({ status: 404, text: async () => '' }));
    await assert.rejects(
      () => script.run({ endpoint: ENDPOINT, live: false, only: '', liveNames: ['demi-chunks'] }),
      /does not exist/
    );
  });

  await t.test('--only accepts either vocabulary and refuses a value that matches nothing', () => {
    assert.deepStrictEqual(script.select('chunks').indexers.map(d => d.body.name), ['chunks-indexer']);
    assert.deepStrictEqual(script.select('chunks-indexer').indexes.map(d => d.body.name), ['chunks']);
    assert.throws(() => script.select('typo'), /matches no definition/);
  });

  await t.test('ai-search still exports the token helper this script destructures', () => {
    // Removing the export leaves the suite green and the script dies at its first request with
    // "getToken is not a function", because destructuring a missing property does not throw.
    assert.strictEqual(typeof require('../../src/search/ai-search').getToken, 'function');
  });

  await t.test('a 403 names the right cause — network and RBAC are told apart by the body', () => {
    // Both faults arrive as 403; only the body separates them. The network body is the verbatim
    // shape the service returns off the VNet.
    const networkBody = JSON.stringify({ error: { code: '', message:
      "Request is denied as the source is not allowed by applicable rules. The service is set 'publicNetworkAccess: Disabled'." } });
    assert.throws(
      () => script.assertNotForbidden(403, networkBody, 'index chunks'),
      /NETWORK RULES/,
      'a network-rule 403 must not be reported as a missing role'
    );
    assert.throws(
      () => script.assertNotForbidden(403, JSON.stringify({ error: { message: 'Authorization failed.' } }), 'index chunks'),
      /Search Service Contributor/,
      'an authorization 403 must name the role to grant'
    );
    // Anything that is not a 403 passes straight through — this guard must not swallow a 404.
    assert.doesNotThrow(() => script.assertNotForbidden(404, '', 'index chunks'));
    assert.doesNotThrow(() => script.assertNotForbidden(200, '', 'index chunks'));
  });

  await t.test('missingFields: a committed field absent from live is reported, an identical pair is clean', () => {
    const committed = { fields: [{ name: 'id' }, { name: 'vis' }] };
    const live = { fields: [{ name: 'id' }] };
    assert.deepStrictEqual(script.missingFields(live, committed), ['vis']);
    assert.deepStrictEqual(script.missingFields(committed, committed), []);
  });

  await t.test('--check reports drift for a missing field and stays clean when nothing is missing', async (tt) => {
    const lines = [];
    const log = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    tt.after(() => { console.log = log; });

    // `projects` live is short one field (the outage class); `chunks` and `documents` match exactly.
    stub(tt, (url, init) => {
      const m = /\/indexes\/([^?]+)\?/.exec(url);
      if (init.method === 'GET' && m) {
        const body = script.load(script.INDEX_DIR).find(d => d.body.name === m[1]).body;
        const fields = m[1] === 'projects' ? body.fields.slice(1) : body.fields;
        return { status: 200, text: async () => JSON.stringify({ ...body, fields }) };
      }
      return ok(url, init);
    });

    const drifted = await script.runCheck({ endpoint: ENDPOINT, only: '' });
    assert.strictEqual(drifted, 1, 'exactly one of the three indexes was made to drift');
    const out = lines.join('\n');
    assert.match(out, /^drift projects: missing fields \S/m);
    assert.match(out, /^ok chunks$/m);
    assert.match(out, /^ok documents$/m);
  });

  await t.test('--check treats an absent live index as every committed field missing', async (tt) => {
    const lines = [];
    const log = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    tt.after(() => { console.log = log; });

    stub(tt, () => ({ status: 404, text: async () => '' }));
    const drifted = await script.runCheck({ endpoint: ENDPOINT, only: 'projects' });
    assert.strictEqual(drifted, 1);
    assert.match(lines.join('\n'), /^drift projects: missing fields /m);
  });

  await t.test('--check issues no PUT, ever', async (tt) => {
    const calls = stub(tt, (url, init) =>
      (init.method === 'GET' && /\/indexes\//.test(url))
        ? { status: 200, text: async () => JSON.stringify(script.load(script.INDEX_DIR)[0].body) }
        : ok(url, init));
    await script.runCheck({ endpoint: ENDPOINT, only: '' });
    assert.strictEqual(calls.filter(c => c.method === 'PUT').length, 0, '--check must never write');
  });

  await t.test('--check and --live refuse to run together', () => {
    assert.throws(() => script.parseArgs(['--check', '--live']), /mutually exclusive/);
    assert.throws(() => script.parseArgs(['--live', '--check']), /mutually exclusive/);
    assert.strictEqual(script.parseArgs(['--check']).check, true);
  });

  await t.test('after the cutover the definitions ARE the live indexes, and the guard is what protects them', () => {
    // Committed and served names coincide by design; never rename a definition to split them.
    // The keyword indexes have no code default, so this asks with their switch on.
    const cfg = configWith(SWITCHED_ON);
    const live = new Set([cfg.index, cfg.projectsIndex, cfg.documentsIndex,
      cfg.activitiesIndex, cfg.notificationsIndex].filter(Boolean));
    const names = script.load(script.INDEX_DIR).map(d => d.body.name);
    assert.ok(
      names.every(n => live.has(n)),
      `expected the committed definitions ${names.join(', ')} to be exactly what the app serves ` +
      `(${[...live].join(', ')}) after the cutover`
    );
  });
});
