'use strict';

/**
 * Does the live search index still carry every field this app selects, searches and sorts on?
 * Deploys never apply index JSON, so live can lag the repo. Not cached: it is a deploy gate.
 */

const aiSearch = require('../search/ai-search');
const eagleQuery = require('../search/eagle-query');
const { systemAccess } = require('../helpers/access-sql');
const { logger } = require('../utils/logger');

/**
 * Schema name -> dataset and committed definition. Schema names, not live ones: live names come
 * from app settings and can be repointed one at a time.
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
    // A field the live index holds but cannot search passes the select probe and still makes every
    // project keyword query a 400.
    searchFields: () => aiSearch.PROJECT_SEARCH_FIELDS,
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
 * Bounds on a POSTED override. The route is anonymous and unthrottled, so each entry multiplies
 * calls to a shared 1-SU service; sized off the committed definitions, which are what CI posts.
 */
const MAX_OVERRIDE_ENTRIES = 64;
const MAX_ENTRY_CHARS = 64;
/** `field` or `field asc|desc` — an index field name, which is all a probe can ask about. */
const ENTRY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*( (asc|desc))?$/;
/** Five indexes × (one select probe + one searchFields probe + at most two `orderby` batches). */
const MAX_PROBES_PER_REQUEST = 20;

// One message for every bound: naming the bound hit would only map the limits for a prober.
function outOfBounds() {
  const err = new Error('schema override out of bounds');
  err.status = 400;
  return err;
}

/**
 * A caller-supplied field list, checked before it can become upstream calls. A string is split
 * first, so `'a,b'` and `['a','b']` are bounded the same.
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
 * Every field an app `$orderby` can name, found by running each committed field through
 * `buildOrderBy` so its sort rules are not copied here.
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
 * Body overrides, so CI can probe the incoming tag's schema through the deployed app. Accepts
 * `{select, orderby, searchFields}` or a committed index definition (`{fields: [{name}]}`).
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
      const searchable = value.fields.filter(f => f && f.name && f.searchable === true);
      if (searchable.length > 0) out[name].searchFields = boundedList(searchable.map(f => f.name));
      continue;
    }

    const override = {};
    if (Array.isArray(value.select) || typeof value.select === 'string') {
      override.select = boundedList(value.select);
    }
    // Bounded BEFORE the direction is added, so `orderbyClause`'s output is not what the pattern
    // has to describe: what a caller may send is a field name, optionally with its direction.
    if (Array.isArray(value.orderby)) override.orderby = boundedList(value.orderby).map(orderbyClause);
    // Empty, as a list or a string, means no override: `searchFields: ''` would check nothing.
    const { searchFields } = value;
    if ((Array.isArray(searchFields) || typeof searchFields === 'string') && searchFields.length > 0) {
      override.searchFields = boundedList(searchFields);
      // ENTRY_PATTERN admits a direction for `orderby`; on a field list it is not a field name.
      if (override.searchFields.some(entry => /\s/.test(entry))) throw outOfBounds();
    }
    out[name] = override;
  }
  return out;
}

/**
 * One index: select, then search fields, then orders, as separate probes, because the service
 * names the field but not the clause that carried it.
 */
async function probeIndex({ liveName, select, searchFields, orderby }) {
  const fail = result => {
    logger.warn(
      `[search-schema] ${liveName} is missing or cannot search ${result.missing.join(', ')} — the ` +
      'live index cannot answer what this app asks it for, so every query against it is a 400'
    );
    return { ok: false, missing: result.missing };
  };

  try {
    const selectProbe = await aiSearch.probeIndexSchema({ indexName: liveName, select });
    if (!selectProbe.ok) return fail(selectProbe);

    if (searchFields) {
      const searchProbe = await aiSearch.probeIndexSchema({ indexName: liveName, searchFields });
      if (!searchProbe.ok) return fail(searchProbe);
    }

    for (let i = 0; i < orderby.length; i += ORDERBY_CLAUSES_PER_PROBE) {
      const batch = orderby.slice(i, i + ORDERBY_CLAUSES_PER_PROBE);
      const orderProbe = await aiSearch.probeIndexSchema({ indexName: liveName, orderby: batch });
      if (!orderProbe.ok) return fail(orderProbe);
    }

    return { ok: true };
  } catch (err) {
    // Not drift (403, wrong name, timeout). Upstream text stays in the log: this route is anonymous
    // and the message names the service endpoint and index.
    logger.error(`[search-schema] probe of ${liveName} failed: ${err.message}`);
    return { ok: false, missing: [], error: 'probe failed' };
  }
}

/**
 * GET (or POST, to override the selects) /health/search-schema. 200 `{ok: true, indexes}` when
 * every live index can answer, else 503, so CI can gate on the status alone.
 */
exports.searchSchema = async (req, res) => {
  const cfg = aiSearch.config();
  if (!cfg.configured) {
    // Not "no drift". An app with no SEARCH_ENDPOINT has probed nothing, and a green gate here
    // would sign off a deploy whose search cannot run at all.
    return res.status(503).json({ ok: false, error: 'Search is not configured.' });
  }

  // The whole request's cost is settled before the first upstream call; over budget is refused.
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
          searchFields: (override && override.searchFields) ||
            (entry.searchFields && entry.searchFields()),
          orderby: (override && override.orderby) || orderbyFieldsFor(entry).map(orderbyClause)
        };
      });
    const probes = plan.reduce(
      (total, index) => total + 1 + (index.searchFields ? 1 : 0) +
        Math.ceil(index.orderby.length / ORDERBY_CLAUSES_PER_PROBE), 0
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

/** Committed, never caller-supplied, which is why these filters go upstream as written. */
const DATA_CHECKS = require('../../azure/search/data-checks.json');

/** One check. A missing or unserved index is `missing`, never a count of zero, which would pass. */
async function runDataCheck(check, liveNames) {
  const row = { index: check.index, field: check.field };
  const liveName = liveNames.get(check.index);
  if (!liveName) {
    logger.warn(
      `[search-data] ${check.index} is not an index this app is serving, so the committed check on ` +
      `${check.field} could not run`
    );
    return { ...row, ok: false, error: 'missing' };
  }

  try {
    const count = await aiSearch.countMatching(liveName, check.filter);
    // `null` is "answered without a count", not zero, and must not pass.
    const ok = Number.isFinite(count) && count <= check.max;
    if (!ok) {
      logger.warn(
        `[search-data] ${liveName}.${check.field}: ${count} rows match \`${check.filter}\`, ` +
        `over the committed maximum of ${check.max}` + (check.note ? ` — ${check.note}` : '')
      );
    }
    return { ...row, count, max: check.max, ok };
  } catch (err) {
    if (aiSearch.isMissingIndex(err, liveName)) {
      logger.warn(`[search-data] ${liveName} is not deployed, so ${check.field} could not be checked`);
      return { ...row, ok: false, error: 'missing' };
    }
    // Upstream text stays in the log: it names the endpoint and index, and this route is anonymous.
    logger.error(`[search-data] check of ${liveName}.${check.field} failed: ${err.message}`);
    return { ...row, ok: false, error: 'check failed' };
  }
}

/**
 * GET /health/search-data: live rows with empty fields, which the schema probe cannot see. 200
 * within every committed maximum, else 503. See `docs/runbook-search-outage.md`.
 */
exports.searchData = async (req, res) => {
  const cfg = aiSearch.config();
  if (!cfg.configured) {
    return res.status(503).json({ ok: false, error: 'Search is not configured.' });
  }

  const liveNames = new Map(INDEXES.map(entry => [entry.schema, entry.liveName(cfg)]));

  const checks = [];
  let ok = true;
  for (const check of DATA_CHECKS) {
    const result = await runDataCheck(check, liveNames);
    checks.push(result);
    if (!result.ok) ok = false;
  }

  return res.status(ok ? 200 : 503).json({ ok, checks });
};
