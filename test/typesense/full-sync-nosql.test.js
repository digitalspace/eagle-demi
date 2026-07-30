'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  fullSync, pageAll, importBatch, diskPreflight, SYNC_ORDER, SOURCES
} = require('../../src/typesense/full-sync-nosql');
const { systemAccess, TIER } = require('../../src/helpers/access-sql');
const { readClause, visibilityFor } = require('../../src/helpers/access-sql');

/** A Typesense double recording everything the sync does to it. */
function fakeTypesense(opts = {}) {
  const state = {
    collections: new Map(opts.existing || []),   // name -> {num_documents}
    aliases: new Map(opts.aliases || []),        // alias -> collection_name
    imported: new Map(),                        // collection -> docs[]
    deleted: [],
    aliasSwaps: []
  };

  const api = {
    state,
    metrics: {
      retrieve: async () => opts.metrics ?? {
        system_disk_total_bytes: 100 * 1024 ** 3,
        system_disk_used_bytes: 10 * 1024 ** 3
      }
    },
    collections: (name) => {
      if (name === undefined) {
        return {
          create: async (schema) => {
            state.collections.set(schema.name, { num_documents: 0 });
            return schema;
          },
          retrieve: async () => [...state.collections.keys()].map(n => ({ name: n }))
        };
      }
      return {
        retrieve: async () => {
          if (!state.collections.has(name)) {
            const err = new Error('Not Found'); err.httpStatus = 404; throw err;
          }
          return state.collections.get(name);
        },
        delete: async () => {
          state.deleted.push(name);
          state.collections.delete(name);
        },
        documents: () => ({
          import: async (docs) => {
            if (!state.imported.has(name)) state.imported.set(name, []);
            state.imported.get(name).push(...docs);
            state.collections.set(name, { num_documents: state.imported.get(name).length });
            return docs.map(() => ({ success: true }));
          }
        })
      };
    },
    aliases: (alias) => {
      if (alias === undefined) {
        return {
          upsert: async (name, { collection_name }) => {
            state.aliases.set(name, collection_name);
            state.aliasSwaps.push([name, collection_name]);
          }
        };
      }
      return {
        retrieve: async () => {
          if (!state.aliases.has(alias)) {
            const err = new Error('Not Found'); err.httpStatus = 404; throw err;
          }
          return { collection_name: state.aliases.get(alias) };
        }
      };
    }
  };
  return api;
}

/** A repository double that pages via continuation tokens, like the real one. */
function fakeRepo(items, pageSize = 2) {
  return {
    calls: [],
    async listVisible(access, opts = {}) {
      this.calls.push({ access, opts });
      const size = opts.pageSize || pageSize;
      const start = opts.continuationToken ? Number(opts.continuationToken) : 0;
      const slice = items.slice(start, start + size);
      const next = start + size;
      return {
        items: slice,
        continuationToken: next < items.length ? String(next) : undefined
      };
    }
  };
}

const PROJECT = {
  id: '207', name: 'Nicomen Wind', region: 'Thompson-Okanagan',
  centroid: { coordinates: [-121.4, 50.2] }, read: ['public', 'staff'], isPublished: true
};

test('systemAccess — the sync reads everything, through the normal predicate', async (t) => {
  await t.test('resolves to the privileged tier, not a bypass', () => {
    const access = systemAccess();
    assert.strictEqual(access.tier, TIER.PRIVILEGED);
    assert.strictEqual(access.projectScope, null);
  });

  await t.test('emits `true` through readClause rather than skipping it', () => {
    // A separate "skip the predicate" path is the shape that previously disabled access control
    // here, and it would not be covered by the SQL-asserting tests.
    assert.deepStrictEqual(readClause(systemAccess().roles), { clause: 'true', params: [] });
    assert.strictEqual(visibilityFor(systemAccess(), 'projectId').clause, 'true');
  });

  await t.test('takes no arguments — it can never be derived from a request', () => {
    assert.strictEqual(systemAccess.length, 0);
  });
});

test('pageAll — continuation tokens, nothing accumulated', async (t) => {
  await t.test('yields every page and stops when the token clears', async () => {
    const repo = fakeRepo([1, 2, 3, 4, 5]);
    const pages = [];
    for await (const page of pageAll(repo, systemAccess(), 2)) pages.push(page);

    assert.deepStrictEqual(pages, [[1, 2], [3, 4], [5]]);
    assert.strictEqual(repo.calls.length, 3);
  });

  await t.test('passes the continuation token forward, never an offset', () => {
    // Cosmos has no efficient offset — page N via skip/take costs as much as pages 1..N combined.
    const repo = fakeRepo([1, 2, 3]);
    return (async () => {
      for await (const _ of pageAll(repo, systemAccess(), 2)) { /* drain */ }
      assert.strictEqual(repo.calls[0].opts.continuationToken, undefined);
      assert.strictEqual(repo.calls[1].opts.continuationToken, '2');
      assert.ok(!('skip' in repo.calls[1].opts) && !('offset' in repo.calls[1].opts));
    })();
  });

  await t.test('an empty repository yields no pages', async () => {
    const pages = [];
    for await (const page of pageAll(fakeRepo([]), systemAccess(), 2)) pages.push(page);
    assert.deepStrictEqual(pages, []);
  });
});

test('importBatch', async (t) => {
  await t.test('reports the number actually indexed, not the number sent', async () => {
    const ts = fakeTypesense();
    await ts.collections().create({ name: 'c' });
    assert.strictEqual(await importBatch(ts, 'c', [{ id: '1' }, { id: '2' }]), 2);
  });

  await t.test('partial failures reduce the count rather than being ignored', async () => {
    // The count feeds the 80% swap guard. Counting failures as successes would let a mostly
    // failed import swap the alias.
    const ts = fakeTypesense();
    ts.collections = (name) => ({
      documents: () => ({
        import: async (docs) => docs.map((d, i) => i === 0
          ? { success: false, error: 'bad field' }
          : { success: true })
      })
    });
    assert.strictEqual(await importBatch(ts, 'c', [{ id: '1' }, { id: '2' }]), 1);
  });

  await t.test('an empty batch is a no-op', async () => {
    assert.strictEqual(await importBatch(fakeTypesense(), 'c', []), 0);
  });

  await t.test('throws after exhausting retries', async () => {
    let attempts = 0;
    const ts = {
      collections: () => ({
        documents: () => ({ import: async () => { attempts++; throw new Error('down'); } })
      })
    };
    await assert.rejects(() => importBatch(ts, 'c', [{ id: '1' }], 1), /down/);
    assert.strictEqual(attempts, 1);
  });
});

test('diskPreflight', async (t) => {
  await t.test('passes with ample free space', async () => {
    await diskPreflight(fakeTypesense());
  });

  await t.test('aborts when free space is below the threshold', async () => {
    // A swap holds the old and new collections at once, so peak is roughly twice the data.
    const ts = fakeTypesense({
      metrics: {
        system_disk_total_bytes: 100 * 1024 ** 3,
        system_disk_used_bytes: 99 * 1024 ** 3
      }
    });
    await assert.rejects(() => diskPreflight(ts), /Pre-flight disk check failed/);
  });

  await t.test('missing metrics warn but do not abort', async () => {
    // Older Typesense builds do not expose system_disk_*; refusing to sync over that would be
    // worse than proceeding.
    const ts = { metrics: { retrieve: async () => { throw new Error('404'); } } };
    await diskPreflight(ts);
  });

  await t.test('unusable metrics warn but do not abort', async () => {
    await diskPreflight(fakeTypesense({ metrics: { system_disk_total_bytes: 0 } }));
  });
});

test('fullSync', async (t) => {
  const repos = () => ({
    projects: fakeRepo([PROJECT], 1000),
    documents: fakeRepo([
      { id: 'd1', projectId: '207', displayName: 'Doc 1', read: ['public'], isPublished: true },
      { id: 'd2', projectId: '207', displayName: 'Doc 2', read: ['staff'], isPublished: false }
    ], 500),
    records: fakeRepo([
      { id: 'r1', projectId: '207', dataset: 'Order', recordName: 'Order 1', read: ['public'] }
    ], 500)
  });

  await t.test('indexes projects FIRST — children denormalise from them', async () => {
    const ts = fakeTypesense();
    const results = await fullSync({ typesense: ts, repos: repos() });

    const order = results.filter(r => !r.skipped).map(r => r.schemaName);
    assert.strictEqual(order[0], 'Project');
    assert.deepStrictEqual(SYNC_ORDER[0], 'Project');
  });

  await t.test('swaps each alias to the new timestamped collection', async () => {
    const ts = fakeTypesense();
    await fullSync({ typesense: ts, repos: repos() });

    for (const alias of ['projects', 'documents', 'records']) {
      const target = ts.state.aliases.get(alias);
      assert.ok(target && target.startsWith(alias + '_'),
        `${alias} not pointed at a timestamped collection`);
    }
  });

  await t.test('drops the previously live collection after the swap', async () => {
    const ts = fakeTypesense({
      existing: [['projects_old', { num_documents: 1 }]],
      aliases: [['projects', 'projects_old']]
    });
    await fullSync({ typesense: ts, repos: repos() });
    assert.ok(ts.state.deleted.includes('projects_old'));
  });

  await t.test('the document ACL is constrained by its project in the indexed output', async () => {
    const ts = fakeTypesense();
    await fullSync({ typesense: ts, repos: repos() });

    const collection = ts.state.aliases.get('documents');
    const docs = ts.state.imported.get(collection);
    const d2 = docs.find(d => d.id === 'd2');
    assert.deepStrictEqual(d2.allowed_roles, ['staff'], 'unpublished doc stays staff-only');
    assert.ok(!d2.allowed_roles.includes('public'));
  });

  await t.test('DocumentChunk is reported as skipped, not silently omitted', async () => {
    // The old code responded to a missing chunk source with a three-way collection probe. Saying
    // "skipped, and why" is how that class of workaround stays deleted.
    const ts = fakeTypesense();
    const results = await fullSync({ typesense: ts, repos: repos() });

    const chunk = results.find(r => r.schemaName === 'DocumentChunk');
    assert.ok(chunk.skipped);
    assert.strictEqual(chunk.imported, 0);
    assert.ok(!ts.state.aliases.has('document_chunks'), 'no empty alias created');
    assert.match(SOURCES.DocumentChunk.reason, /extraction has never run/);
  });

  await t.test('an EMPTY project lookup aborts the whole sync', async () => {
    // The Mongo version answered an empty result by querying a different collection, then a
    // different database. Both turned "the data is missing" into "index something else".
    const ts = fakeTypesense();
    const empty = { ...repos(), projects: fakeRepo([], 1000) };
    await assert.rejects(
      () => fullSync({ typesense: ts, repos: empty }),
      /Project lookup is empty — refusing to sync/
    );
    assert.strictEqual(ts.state.aliasSwaps.length, 0, 'nothing was swapped');
  });

  await t.test('refuses the swap when the new collection is under 80% of the live one', async () => {
    // Catches a partial read: swapping would replace good data with an incomplete index and search
    // would silently start missing results.
    const ts = fakeTypesense({
      existing: [['documents_old', { num_documents: 1000 }]],
      aliases: [['documents', 'documents_old']]
    });
    await assert.rejects(
      () => fullSync({ typesense: ts, repos: repos() }),
      /Refusing to swap the alias — under 80% of the previous size/
    );
    assert.strictEqual(ts.state.aliases.get('documents'), 'documents_old',
      'the live alias still points at the good collection');
  });

  await t.test('the incomplete collection is cleaned up when the swap is refused', async () => {
    const ts = fakeTypesense({
      existing: [['documents_old', { num_documents: 1000 }]],
      aliases: [['documents', 'documents_old']]
    });
    await fullSync({ typesense: ts, repos: repos() }).catch(() => {});
    const leftover = [...ts.state.collections.keys()].filter(n => n.startsWith('documents_') &&
      n !== 'documents_old');
    assert.deepStrictEqual(leftover, [], 'a rejected collection must not linger in memory');
  });

  await t.test('purges orphan collections from previous failed syncs', async () => {
    const ts = fakeTypesense({
      existing: [
        ['projects_old', { num_documents: 1 }],
        ['projects_19990101000000', { num_documents: 0 }]
      ],
      aliases: [['projects', 'projects_old']]
    });
    await fullSync({ typesense: ts, repos: repos() });
    assert.ok(ts.state.deleted.includes('projects_19990101000000'));
  });

  await t.test('every repository read uses the privileged system context', async () => {
    const r = repos();
    await fullSync({ typesense: fakeTypesense(), repos: r });

    for (const [name, repo] of Object.entries(r)) {
      assert.ok(repo.calls.length > 0, `${name} was never read`);
      for (const call of repo.calls) {
        assert.strictEqual(call.access.tier, TIER.PRIVILEGED,
          `${name} read with a non-privileged context would silently index a subset`);
      }
    }
  });
});
