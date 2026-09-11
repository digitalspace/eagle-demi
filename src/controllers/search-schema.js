'use strict';

/**
 * Does the LIVE search index still carry everything this app asks it for?
 *
 * The gap this closes is committed-vs-live. Two tests already hold the code against the committed
 * `azure/search/indexes/*.json` (`test/search/ai-search.test.js`), and both passed through the
 * 2026-09-08 outage: neither deploy workflow APPLIES an index definition, so a release can widen
 * the JSON and the select together and still meet a narrower live index. AI Search answers that
 * with `Could not find a property named 'fileSize'` on EVERY document query, which the search
 * controller turns into a 502 — the whole Document tab, for as long as nobody notices.
 *
 * So the probe asks the service itself, with the selects and the orders the app emits, and returns
 * a status rather than data. It needs no role the app does not already hold (see
 * `probeIndexSchema`), which is what lets the prod deploy job run it before it swaps the code.
 *
 * NOT CACHED. It is a gate and a diagnosis, both of which want the answer as it is now, and the
 * whole call is three empty pages against a `top: 0` query.
 */

const aiSearch = require('../search/ai-search');
const eagleQuery = require('../search/eagle-query');
const { systemAccess } = require('../helpers/access-sql');
const { logger } = require('../utils/logger');

/**
 * Schema name -> the dataset whose queries run against it, and the committed definition.
 *
 * Schema names, not live index names: the live names come from `aiSearch.config()` app settings and
 * can be repointed one setting at a time, while these are what the repo, the response body and the
 * request override all speak. Same split `eagle-query.DATASET_INDEX` makes.
 */
const INDEXES = [
  {
    schema: 'chunks',
    dataset: 'DocumentChunk',
    definition: require('../../azure/search/indexes/chunks.json'),
    select: () => aiSearch.CHUNK_SELECT,
    liveName: cfg => cfg.index
  },
  {
    schema: 'projects',
    dataset: 'Project',
    definition: require('../../azure/search/indexes/projects.json'),
    select: () => aiSearch.PROJECT_SELECT,
    liveName: cfg => cfg.projectsIndex
  },
  {
    schema: 'documents',
    dataset: 'Document',
    definition: require('../../azure/search/indexes/documents.json'),
    select: () => aiSearch.DOCUMENT_SELECT,
    liveName: cfg => cfg.documentsIndex
  },
  // The two keyword indexes. Their live name is EMPTY when the dataset's kill switch is set, and
  // `probeFor` drops those: an app serving that dataset from Cosmos has nothing to be drifted from.
  {
    schema: 'activities',
    dataset: 'RecentActivity',
    definition: require('../../azure/search/indexes/activities.json'),
    select: () => aiSearch.KEYWORD_INDEXES.activities.select,
    liveName: cfg => cfg.activitiesIndex
  },
  {
    schema: 'project-notifications',
    dataset: 'ProjectNotification',
    definition: require('../../azure/search/indexes/project-notifications.json'),
    select: () => aiSearch.KEYWORD_INDEXES.notifications.select,
    liveName: cfg => cfg.notificationsIndex
  }
];

/** Azure's ceiling on `$orderby` clauses. The widest index has 14, so this batches rather than binds. */
const ORDERBY_CLAUSES_PER_PROBE = 32;

/**
 * What a POSTED override may ask for, and it is a bound rather than a preference.
 *
 * THE ROUTE IS ANONYMOUS AND NOTHING IN FRONT OF IT COUNTS REQUESTS (see the route comment and
 * `azure/modules/apim.bicep`), so an override's length is a request multiplier at a shared 1-SU
 * search service: an `orderby` array is batched 32 at a time into one live call each, across three
 * indexes. Unbounded, a single 1 MB body measured 6,254 sequential calls and the 10 MB body limit
 * puts ~65,000 within reach of one curl.
 *
 * The numbers are sized off the committed definitions, which are what CI posts: the widest index
 * declares 23 fields and 14 sortable ones, and the longest field name is well under 64 characters.
 * A body over these is not a probe this endpoint has any reason to run.
 */
const MAX_OVERRIDE_ENTRIES = 64;
const MAX_ENTRY_CHARS = 64;
/** `field` or `field asc|desc` — an index field name, which is all a probe can ask about. */
const ENTRY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*( (asc|desc))?$/;
/** Five indexes × (one select probe + at most three `orderby` batches). */
const MAX_PROBES_PER_REQUEST = 20;

/**
 * One message for every bound, because the caller is CI or a curl and the answer is the same:
 * post the committed definition, or a select and an order the app could actually emit. Naming
 * which bound was hit would only describe the limits to someone probing for them.
 */
function outOfBounds() {
  const err = new Error('schema override out of bounds');
  err.status = 400;
  return err;
}

/**
 * A caller-supplied list of field names, checked before it can become upstream calls.
 *
 * A string is split the way `probeIndexSchema` would join it, so `select: 'a,b'` and
 * `select: ['a','b']` are bounded identically rather than the string form slipping past.
 *
 * @throws {Error} status 400 when the list is too long, or any entry is not a bare field name
 */
function boundedList(value) {
  const entries = Array.isArray(value) ? value : String(value).split(',');
  if (entries.length > MAX_OVERRIDE_ENTRIES) throw outOfBounds();
  return entries.map(entry => {
    if (typeof entry !== 'string' && typeof entry !== 'number') throw outOfBounds();
    const text = String(entry).trim();
    if (text.length > MAX_ENTRY_CHARS || !ENTRY_PATTERN.test(text)) throw outOfBounds();
    return text;
  });
}

/**
 * Every index field an `$orderby` from this app can name, asked of `buildOrderBy` rather than
 * restated here.
 *
 * The emittable set is not a list anyone maintains: it is whatever survives `SORT_KEYS`, the filter
 * `ALIASES`, the `sortable` flag and the TYPE gate that rejects `centroid` while the index calls it
 * sortable. Feeding every committed field name back through the real builder yields exactly that
 * set — a second copy of those rules here is the drift this endpoint exists to catch, one level up.
 *
 * Direction is irrelevant to the question (`asc` and `desc` fail identically on a field the index
 * does not have), so the field NAMES are collected and reissued as one order, and the two
 * caller-less forms are included because both ship on real requests: the default order on a
 * keywordless page, and `search.score() desc, id asc` on a keyword one.
 */
function orderbyFieldsFor({ dataset, definition }) {
  const access = systemAccess();
  const fields = new Set();

  const collect = orderby => {
    for (const clause of String(orderby || '').split(',')) {
      const name = clause.trim().split(/\s+/)[0];
      // `search.score()` is an expression over the query, not a field: nothing in it can drift.
      if (name && !name.includes('(')) fields.add(name);
    }
  };

  collect(eagleQuery.buildOrderBy(undefined, dataset, false, access).orderby);
  collect(eagleQuery.buildOrderBy(undefined, dataset, true, access).orderby);
  for (const field of definition.fields) {
    collect(eagleQuery.buildOrderBy(field.name, dataset, false, access).orderby);
  }

  return [...fields];
}

/** `field` -> `field asc`; an entry that already carries a direction is passed through. */
function orderbyClause(entry) {
  const text = String(entry).trim();
  return /\s/.test(text) ? text : `${text} asc`;
}

/**
 * The selects and orders a request body overrides, so CI can probe the INCOMING tag's schema
 * through the CURRENTLY deployed app — the only order in which the gate can block a bad release.
 *
 * Two accepted shapes per index. `{select, orderby}` states the query directly. A committed index
 * definition (`{fields: [{name}]}`) is accepted as-is so the workflow can post the file it already
 * has: every field it declares must exist live, which is the committed-vs-live question. Its
 * `sortable` flags are deliberately not turned into an order — that would restate the type gate
 * `orderbyFieldsFor` borrows from `buildOrderBy`, and get `centroid` wrong the same way.
 *
 * @throws {Error} with `status: 400` on a body naming an index this app does not query
 */
function overridesFrom(body) {
  const out = {};
  const indexes = body && body.indexes;
  if (!indexes || typeof indexes !== 'object' || Array.isArray(indexes)) return out;

  const known = INDEXES.map(entry => entry.schema);
  if (Object.keys(indexes).length > known.length) throw outOfBounds();
  for (const [name, value] of Object.entries(indexes)) {
    if (!known.includes(name)) {
      const err = new Error(`indexes must name one of: ${known.join(', ')}`);
      err.status = 400;
      throw err;
    }
    if (!value || typeof value !== 'object') continue;

    if (Array.isArray(value.fields)) {
      out[name] = {
        // A non-retrievable field cannot be selected at all — asking is its own 400, and one that
        // says nothing about drift.
        select: boundedList(
          value.fields.filter(f => f && f.name && f.retrievable !== false).map(f => f.name)
        ),
        orderby: []
      };
      continue;
    }

    const override = {};
    if (Array.isArray(value.select) || typeof value.select === 'string') {
      override.select = boundedList(value.select);
    }
    // Bounded BEFORE the direction is added, so `orderbyClause`'s output is not what the pattern
    // has to describe: what a caller may send is a field name, optionally with its direction.
    if (Array.isArray(value.orderby)) override.orderby = boundedList(value.orderby).map(orderbyClause);
    out[name] = override;
  }
  return out;
}

/**
 * One index: the select first, then the orders.
 *
 * Separate probes rather than one combined request, because the answer names a field and not which
 * clause carried it: a select fault reported against an order sends an operator to `SORT_KEYS`
 * instead of to the select. The select is also the one that took prod down.
 */
async function probeIndex({ liveName, select, orderby }) {
  const fail = result => {
    logger.warn(
      `[search-schema] ${liveName} is missing ${result.missing.join(', ')} — the live index cannot ` +
      'answer what this app asks it for, so every query against it is a 400'
    );
    return { ok: false, missing: result.missing };
  };

  try {
    const selectProbe = await aiSearch.probeIndexSchema({ indexName: liveName, select });
    if (!selectProbe.ok) return fail(selectProbe);

    for (let i = 0; i < orderby.length; i += ORDERBY_CLAUSES_PER_PROBE) {
      const batch = orderby.slice(i, i + ORDERBY_CLAUSES_PER_PROBE);
      const orderProbe = await aiSearch.probeIndexSchema({ indexName: liveName, orderby: batch });
      if (!orderProbe.ok) return fail(orderProbe);
    }

    return { ok: true };
  } catch (err) {
    // Anything that is not a missing property: a 403 on the data-plane role, a wrong index name, a
    // timeout. NOT reported as drift, and the upstream text stays in the log — this route is
    // anonymous, and a search error message carries the service endpoint and the index name.
    logger.error(`[search-schema] probe of ${liveName} failed: ${err.message}`);
    return { ok: false, missing: [], error: 'probe failed' };
  }
}

/**
 * GET (or POST, to override the selects) /health/search-schema.
 *
 * 200 `{ok: true, indexes: {...}}` when every live index can answer; 503 otherwise, so a CI step
 * can gate on the status alone and an operator can read the field out of the body.
 */
exports.searchSchema = async (req, res) => {
  const cfg = aiSearch.config();
  if (!cfg.configured) {
    // Not "no drift". An app with no SEARCH_ENDPOINT has probed nothing, and a green gate here
    // would sign off a deploy whose search cannot run at all.
    return res.status(503).json({ ok: false, error: 'Search is not configured.' });
  }

  // Everything the request will cost, settled BEFORE the first upstream call: the bounds in
  // `overridesFrom` cap each list, and the budget here caps the whole request. A body that would
  // buy more probes than the committed definitions need is refused rather than half-run.
  let plan;
  try {
    const overrides = overridesFrom(req.body);
    plan = INDEXES
      // An index the app is not serving from — the kill switch empties the app setting — cannot be
      // drifted from, and probing '' is a 404 reported as a failed probe.
      .filter(entry => entry.liveName(cfg) !== '')
      .map(entry => {
        const override = overrides[entry.schema];
        return {
          schema: entry.schema,
          liveName: entry.liveName(cfg),
          select: (override && override.select) || entry.select(),
          orderby: (override && override.orderby) || orderbyFieldsFor(entry).map(orderbyClause)
        };
      });
    const probes = plan.reduce(
      (total, index) => total + 1 + Math.ceil(index.orderby.length / ORDERBY_CLAUSES_PER_PROBE), 0
    );
    if (probes > MAX_PROBES_PER_REQUEST) throw outOfBounds();
  } catch (err) {
    if (!err.status) throw err;
    return res.status(err.status).json({ ok: false, error: err.message });
  }

  const indexes = {};
  let ok = true;
  for (const index of plan) {
    const result = await probeIndex(index);
    indexes[index.schema] = result;
    if (!result.ok) ok = false;
  }

  return res.status(ok ? 200 : 503).json({ ok, indexes });
};
