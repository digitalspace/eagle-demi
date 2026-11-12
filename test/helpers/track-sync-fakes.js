'use strict';

// In-memory projects and links repositories with Cosmos's etag rules, and the Track project the
// project sync tests share.

const { trackApiToExtract } = require('../../src/seed/sources');
const { mergeTrackProject } = require('../../src/merge/project');
const { readForLevel } = require('../../src/helpers/access-sql');

const NOW = '2026-09-02T00:00:00.000Z';
const worksRepository = () => require('../../src/repositories/works');

/** One row of `GET /api/v1/projects`, fields as Track test returns them. */
const API_PROJECT = {
  id: 207,
  name: 'Nicomen Wind Energy',
  description: 'Proponent proposes to construct 35 - 2.0 MW wind turbines.',
  epic_guid: '58851172aaecd9001b820335',
  latitude: '50.2',
  longitude: '-121.4',
  address: 'Lytton',
  abbreviation: 'NICWIN',
  is_active: true,
  is_project_closed: true,
  project_state: { name: 'Closed' },
  project_state_id: 6,
  type: { name: 'Energy - Electricity' },
  sub_type: { name: 'Power Plants' },
  proponent: { name: 'Premier Renewable Energy' },
  ea_certificate: 'Withdrawn',
  eac_expires: null,
  eac_signed: null,
  region_env: 'Thompson-Okanagan',
  region_flnro: 'Thompson / Okanagan',
  created_at: '2019-11-04T20:23:41.664000'
};

const FLAT = trackApiToExtract(API_PROJECT);

/**
 * A stored record as the merge writes it, then widened to level 4 and classified — i.e. what the
 * ladder and the sysadmin own, which no re-merge may touch.
 */
function storedProject(overrides = {}) {
  return {
    ...mergeTrackProject(FLAT, null, { now: '2026-08-01T00:00:00.000Z' }),
    read: readForLevel(4),
    isPublished: true,
    // Already minted from the name: a row without one, or on a pre-slug random code, is the
    // migration case, tested on its own below.
    shortCode: 'nicomen-wind-energy',
    shortCodeSource: 'name',
    vis: { eacExpires: 3 },
    regionalDistrict: 'Thompson-Nicola',
    ...overrides
  };
}

const conflict = () => Object.assign(new Error('Conflict'), { code: 409 });
const preconditionFailed = () => Object.assign(new Error('Precondition failed'), { code: 412 });

// The links repository, in memory: a second create of a code is a 409, a write on a stale
// revision is a 412. `seed` records are already there.
function fakeLinks(seed = []) {
  let revision = 0;
  const stamp = (record) => ({ ...record, _etag: `"l${++revision}"` });
  const created = [];
  const byId = new Map(seed.map(record => [record.id, stamp(record)]));
  const guard = (id, etag) => {
    if (etag && byId.get(id)._etag !== etag) throw preconditionFailed();
  };
  return {
    created, byId,
    create: async (record) => {
      if (byId.has(record.id)) throw conflict();
      const saved = stamp(record);
      created.push(saved);
      byId.set(record.id, saved);
      return saved;
    },
    getById: async (id) => byId.get(id) || null,
    repoint: async (id, url, { etag } = {}) => {
      if (!byId.has(id)) return null;
      guard(id, etag);
      const saved = stamp({ ...byId.get(id), url });
      byId.set(id, saved);
      return saved;
    },
    remove: async (id, { etag } = {}) => {
      if (!byId.has(id)) return false;
      guard(id, etag);
      return byId.delete(id);
    }
  };
}

// The projects repository, in memory, with Cosmos's etag rule (stale revision = 412). `midRun`
// lands another writer's change after the list read; `deleteById` throws, as nothing is deleted.
function fakeProjects(rows = [], { midRun } = {}) {
  let revision = 0;
  const stamp = (row) => ({ ...structuredClone(row), _etag: `"${++revision}"` });
  const items = structuredClone(rows);
  const writes = [];
  const patches = [];
  const find = (id) => items.find(p => String(p.id) === String(id)) || null;
  const store = (row) => {
    const saved = stamp(row);
    const at = items.findIndex(p => String(p.id) === String(row.id));
    if (at >= 0) items[at] = saved; else items.push(saved);
    return structuredClone(saved);
  };
  const guard = (id, etag) => {
    const current = find(id);
    if (current && current._etag !== etag) {
      throw Object.assign(new Error('Precondition failed'), { code: 412 });
    }
  };
  return {
    items, writes, patches, store,
    listVisible: async () => {
      const snapshot = structuredClone(items);
      if (midRun) midRun(store, find);
      return { items: snapshot };
    },
    getById: async (_access, id) => structuredClone(find(id)),
    readForWrite: async (id) => structuredClone(find(id)),
    // The Track row beside its `eagle-<id>` twin wins, as in the repository.
    readForWriteByEagleId: async (eagleId) => structuredClone(
      items.find(p => p.eagleId === eagleId && !String(p.id).startsWith('eagle-')) ||
      items.find(p => p.eagleId === eagleId) || null),
    upsert: async (row, { etag, create } = {}) => {
      if (create && find(row.id)) throw conflict();
      guard(row.id, etag);
      writes.push(row);
      return store(row);
    },
    patchShortLink: async (id, { shortCode, shortCodeSource, legacyShortCodes }, etag) => {
      guard(id, etag);
      patches.push({ id, shortCode, shortCodeSource, legacyShortCodes });
      return store({ ...find(id), shortCode, shortCodeSource, legacyShortCodes });
    },
    listShortCodeOwners: async (code) => items
      .filter(p => p.shortCode === code || (p.legacyShortCodes || []).includes(code))
      .map(p => String(p.id)),
    deleteById: async () => { throw new Error('the project sync must never delete'); }
  };
}

/** The Eagle-only row the merge writes when Track has no counterpart yet. */
function eagleOnlyProject(overrides = {}) {
  return {
    id: `eagle-${API_PROJECT.epic_guid}`,
    trackProjectId: null,
    eagleId: API_PROJECT.epic_guid,
    sourceSystem: 'eagle',
    name: 'Nicomen Wind Energy',
    read: readForLevel(4),
    isPublished: true,
    vis: { eacExpires: 3 },
    regionalDistrict: 'Thompson-Nicola',
    sources: { track: null, eagle: { _id: API_PROJECT.epic_guid, name: 'Nicomen Wind Energy' } },
    ...overrides
  };
}

/** The works repository, in memory, with the same etag rule; `calls` names every method used. */
function fakeWorks(rows = []) {
  let revision = 0;
  const docs = new Map(rows.map(doc => [doc.id, { ...structuredClone(doc), _etag: `"w${++revision}"` }]));
  const calls = [];
  const saved = [];
  const save = async (doc, { etag } = {}) => {
    calls.push('save');
    const current = docs.get(doc.id);
    if (current ? current._etag !== etag : etag) throw preconditionFailed();
    saved.push(structuredClone(doc));
    docs.set(doc.id, { ...structuredClone(doc), _etag: `"w${++revision}"` });
    return { status: 'written' };
  };
  return {
    docs, calls, saved,
    listByProject: async (projectId, { includeDeleted = false, owner } = {}) => {
      calls.push('listByProject');
      return [...docs.values()].filter(doc => doc.projectId === projectId && (includeDeleted || doc.deleted !== true) &&
        (owner === undefined || worksRepository().ownerOf(doc) === owner)).map(doc => structuredClone(doc));
    },
    get: async (_projectId, id) => { calls.push('get'); return structuredClone(docs.get(id) || null); },
    save,
    tombstone: ({ id, projectId, pushStamps }, opts) => save({ id, projectId, deleted: true, pushStamps }, opts)
  };
}

/** Swaps the works repository's methods for {fake}'s for this test. */
function useWorks(t, fake) {
  const works = worksRepository();
  for (const name of ['listByProject', 'get', 'save', 'tombstone']) t.mock.method(works, name, fake[name]);
  return fake;
}

module.exports = {
  NOW, API_PROJECT, FLAT, storedProject, eagleOnlyProject, conflict, preconditionFailed, fakeLinks, fakeProjects,
  fakeWorks, useWorks
};
