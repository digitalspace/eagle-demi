'use strict';

/**
 * The native list contract, parsed once for every `GET /<kind>` list: offset `page` (1-based) and
 * `pageSize`, one allow-listed `sort`, `count=true`, `ids=`, `q=` and the kind's declared filters.
 * Anything else, and any repeated control parameter, is a 400 rather than silently ignored.
 * Filter and `q` clauses also honour each record's own dial on the field, so `count=true` cannot
 * reveal a value that record hides.
 */

const cosmos = require('../db/cosmos-nosql');
const { pageSizeFor, MAX_PAGE_DEPTH } = require('./access-sql');
const {
  eq, inList, isDefinedAndNotNull, assertFilterable, selectWhere, selectFor, countWhere, readPage
} = require('../repositories/_sql');
const { levelOf } = require('../vis/level');
const { spellingsOf } = require('./spellings');
const { redactForAccess } = require('../vis/redact');

/** Most ids one `ids=` read may name, and most values one repeated filter may take. */
const MAX_IDS = 100;

/** Longest text one `spec.contains` parameter may carry, in characters, after trimming. */
const MAX_CONTAINS = 200;

/**
 * Deepest row an offset page may reach for a caller with no credential. A public table has no
 * reason to page past this, and each deep page costs every row before it (see `readPage`).
 */
const ANON_MAX_PAGE_DEPTH = 2000;

const CONTROL_PARAMS = Object.freeze(['page', 'pageSize', 'count', 'sort', 'q', 'ids']);

// Spec field names are interpolated into SQL as `c.<path>`; only plain dotted identifiers pass.
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

const EAGLE_ID = /^[0-9a-f]{24}$/i;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const RANGE_OPS = Object.freeze(['ge', 'le']);

/** Throws at route load, not per request, on a kind spec that names a field SQL cannot take. */
function assertKindSpec(spec) {
  if (!spec || typeof spec.entity !== 'string') throw new Error('[native] kind spec needs an entity');
  const fields = [...(spec.sortKeys || []), ...(spec.filters || []), ...(spec.qFields || [])];
  for (const field of fields) {
    if (!FIELD_PATH.test(field)) throw new Error(`[native] ${spec.entity}: bad field name ${field}`);
    if (CONTROL_PARAMS.includes(field)) throw new Error(`[native] ${spec.entity}: ${field} is a control parameter`);
  }
  for (const field of spec.multiValueFilters || []) {
    if (!(spec.filters || []).includes(field)) {
      throw new Error(`[native] ${spec.entity}: multi-value filter ${field} is not a declared filter`);
    }
  }
  for (const field of Object.keys(spec.valueAliases || {})) {
    if (!(spec.filters || []).includes(field)) {
      throw new Error(`[native] ${spec.entity}: value aliases for ${field}, which is not a declared filter`);
    }
  }
  for (const [name, { field, op }] of Object.entries(spec.ranges || {})) {
    if (!FIELD_PATH.test(name) || !FIELD_PATH.test(field)) throw new Error(`[native] ${spec.entity}: bad range ${name}`);
    if (!RANGE_OPS.includes(op)) throw new Error(`[native] ${spec.entity}: range ${name} needs op ge or le`);
    if (CONTROL_PARAMS.includes(name) || (spec.filters || []).includes(name) || (spec.aliases || {})[name]) {
      throw new Error(`[native] ${spec.entity}: range ${name} clashes with a parameter of that name`);
    }
  }
  for (const [name, field] of Object.entries(spec.aliases || {})) {
    if (!(spec.filters || []).includes(field)) {
      throw new Error(`[native] ${spec.entity}: alias ${name} names ${field}, which is not a declared filter`);
    }
    if (CONTROL_PARAMS.includes(name) || (spec.filters || []).includes(name)) {
      throw new Error(`[native] ${spec.entity}: alias ${name} clashes with a parameter of that name`);
    }
  }
  const taken = [
    ...CONTROL_PARAMS, ...(spec.filters || []), ...Object.keys(spec.aliases || {}), ...Object.keys(spec.ranges || {})
  ];
  for (const kind of ['contains', 'presence']) {
    for (const [name, field] of Object.entries(spec[kind] || {})) {
      if (!FIELD_PATH.test(name) || !FIELD_PATH.test(field)) throw new Error(`[native] ${spec.entity}: bad ${kind} ${name}`);
      if (taken.includes(name)) throw new Error(`[native] ${spec.entity}: ${kind} ${name} clashes with a parameter of that name`);
      taken.push(name);
    }
  }
}

/**
 * Query name -> row field for each of `spec`'s filters. A filter `spec.aliases` renames (e.g.
 * `{ project: 'projectId' }`) answers to that name only, so each filter has one spelling on the wire.
 */
function filterNames(spec) {
  const aliases = spec.aliases || {};
  const renamed = Object.values(aliases);
  return new Map([
    ...(spec.filters || []).filter(field => !renamed.includes(field)).map(field => [field, field]),
    ...Object.entries(aliases)
  ]);
}

// Catalog entries and per-record dials are keyed by the top-level field: `eacDecision._id` is `eacDecision`.
const topField = field => field.split('.')[0];

/** `assertFilterable` as a value: the refusal message, or null when the caller may see the field. */
function refusal(entity, field, access) {
  try {
    assertFilterable(entity, topField(field), access);
    return null;
  } catch (err) {
    return err.message;
  }
}

/**
 * The instant one edge of a day range stands for: `ge` from the day's first millisecond, `le` to
 * its last, so a document posted at 09:00 on the end day is in. UTC, as the frontends send it.
 */
function rangeBound(op, day) {
  return `${day}T${op === 'ge' ? '00:00:00.000' : '23:59:59.999'}Z`;
}

/** A real `YYYY-MM-DD` calendar day: `2026-02-30` passes the shape and fails the round trip. */
function isDay(value) {
  if (!DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Parse and validate `query` for `spec`. Answers `{ error }` (a 400) or the parsed query:
 * `{ pageNum, pageSize, count, sort: {field, desc}|null, ids, q, filters: {field: [values]},
 * ranges: [{name, field, op, value}], contains: {field: text}, presence: {field: bool} }`.
 * `filters`, `contains` and `presence` are keyed by row field, whatever name the query used, so
 * `nativeCriteria` renders them from `parsed` alone. `spec.ranges` is query name ->
 * `{ field, op: 'ge'|'le' }`, one day each, for a bound with no row field of its own
 * (`datePostedStart` -> `datePosted ge`). `spec.contains` is query name -> field, a case-blind
 * substring; `spec.presence` is query name -> field, `true` when it holds a value other than null or ''.
 */
function parseNativeQuery(spec, query, access) {
  const names = filterNames(spec);
  const multi = spec.multiValueFilters || [];

  for (const [key, value] of Object.entries(query || {})) {
    if (!CONTROL_PARAMS.includes(key) && !names.has(key) && !(spec.ranges || {})[key] &&
        !(spec.contains || {})[key] && !(spec.presence || {})[key]) {
      return { error: `unknown parameter: ${key}` };
    }
    if (Array.isArray(value) && !multi.includes(names.get(key))) return { error: `parameter given more than once: ${key}` };
  }
  const q = query || {};

  let pageNum = 0;
  if (q.page !== undefined) {
    const page = Number(q.page);
    if (!/^\d+$/.test(q.page) || !(page >= 1)) return { error: 'page must be a whole number from 1' };
    pageNum = page - 1;
  }

  const { pageSize, error } = pageSizeFor(access, q.pageSize);
  if (error) return { error };

  const anonymous = !access || !access.authenticated;
  const depth = anonymous ? ANON_MAX_PAGE_DEPTH : MAX_PAGE_DEPTH;
  if ((pageNum + 1) * pageSize > depth) {
    return { error: `page * pageSize must stay within ${depth} rows` +
      (anonymous ? ' for a request with no credential' : '') };
  }

  if (q.count !== undefined && q.count !== 'true') return { error: 'count takes only true' };

  let sort = null;
  if (q.sort !== undefined) {
    const desc = q.sort.startsWith('-');
    const field = q.sort.replace(/^[-+]/, '');
    if (!(spec.sortKeys || []).includes(field)) return { error: `cannot sort on: ${q.sort}` };
    const refused = refusal(spec.entity, field, access);
    if (refused) return { error: refused };
    sort = { field, desc };
  }

  let ids = null;
  if (q.ids !== undefined) {
    ids = [...new Set(q.ids.split(',').map(id => id.trim()).filter(Boolean))];
    if (ids.length === 0) return { error: 'ids needs at least one id' };
    if (ids.length > MAX_IDS) return { error: `ids takes at most ${MAX_IDS} ids` };
  }

  const keyword = q.q !== undefined && q.q.trim() ? q.q.trim() : null;
  if (keyword) {
    if (!(spec.qFields || []).length) return { error: 'q is not supported on this list' };
    for (const field of spec.qFields) {
      const refused = refusal(spec.entity, field, access);
      if (refused) return { error: refused };
    }
  }

  const filterValues = {};
  for (const [name, field] of names) {
    if (q[name] === undefined) continue;
    const refused = refusal(spec.entity, field, access);
    if (refused) return { error: refused };
    const values = [...new Set([].concat(q[name]))];
    if (values.length > MAX_IDS) return { error: `${name} takes at most ${MAX_IDS} values` };
    // Capped on what the caller sent; a stored second spelling is ours to match, not theirs to count.
    const pairs = (spec.valueAliases || {})[field];
    filterValues[field] = pairs ? [...new Set(values.flatMap(v => spellingsOf(pairs, v)))] : values;
  }

  const ranges = [];
  for (const [name, { field, op }] of Object.entries(spec.ranges || {})) {
    if (q[name] === undefined) continue;
    if (!isDay(q[name])) return { error: `${name} takes one day as YYYY-MM-DD` };
    const refused = refusal(spec.entity, field, access);
    if (refused) return { error: refused };
    ranges.push({ name, field, op, value: q[name] });
  }

  // An empty text is ignored, as an empty `q=` is.
  const contains = {};
  for (const [name, field] of Object.entries(spec.contains || {})) {
    const text = q[name] === undefined ? '' : q[name].trim();
    if (!text) continue;
    if ([...text].length > MAX_CONTAINS) return { error: `${name} takes at most ${MAX_CONTAINS} characters` };
    const refused = refusal(spec.entity, field, access);
    if (refused) return { error: refused };
    contains[field] = text;
  }

  const presence = {};
  for (const [name, field] of Object.entries(spec.presence || {})) {
    if (q[name] === undefined) continue;
    if (q[name] !== 'true' && q[name] !== 'false') return { error: `${name} takes only true or false` };
    const refused = refusal(spec.entity, field, access);
    if (refused) return { error: refused };
    presence[field] = q[name] === 'true';
  }

  return {
    pageNum, pageSize, count: q.count === 'true', sort, ids, q: keyword, filters: filterValues, ranges, contains, presence
  };
}

/**
 * Whether `field` holds a value: defined, not null and not ''. The mirror writes null for a missing
 * value and older rows carry '', so both are "absent"; `present: false` is the exact complement.
 */
function presenceClause(field, present) {
  const filled = isDefinedAndNotNull(field);
  const clause = `(${filled.clause} AND c.${field} != '')`;
  return { clause: present ? clause : `(NOT ${clause})`, params: [] };
}

/** The record's own dial on `field` may hide it below the caller's level; such a record never matches. */
function dialAllows(field, level) {
  const dial = `c.vis[${JSON.stringify(topField(field))}]`;
  return `(NOT IS_DEFINED(${dial}) OR ${dial} >= ${level})`;
}

/**
 * Cosmos criteria and ORDER BY for a parsed query, for `selectWhere`/`countWhere`. The caller's
 * visibility predicate is added by those, not here.
 */
function nativeCriteria(spec, parsed, access) {
  const level = levelOf(access);
  const criteria = [];

  if (parsed.ids) criteria.push(inList('id', parsed.ids, '@nid'));

  Object.entries(parsed.filters).forEach(([field, values], i) => {
    const match = values.length === 1 ? eq(field, values[0], `@nf${i}`) : inList(field, values, `@nf${i}_`);
    criteria.push({ clause: `(${dialAllows(field, level)} AND ${match.clause})`, params: match.params });
  });

  (parsed.ranges || []).forEach(({ field, op, value }, i) => {
    const bound = { name: `@nr${i}`, value: rangeBound(op, value) };
    criteria.push({ clause: `(${dialAllows(field, level)} AND c.${field} ${op === 'ge' ? '>=' : '<='} ${bound.name})`, params: [bound] });
  });

  Object.entries(parsed.contains || {}).forEach(([field, text], i) => {
    const bound = { name: `@nc${i}`, value: text };
    criteria.push({ clause: `(${dialAllows(field, level)} AND CONTAINS(c.${field}, ${bound.name}, true))`, params: [bound] });
  });

  Object.entries(parsed.presence || {}).forEach(([field, present]) => {
    const has = presenceClause(field, present);
    criteria.push({ clause: `(${dialAllows(field, level)} AND ${has.clause})`, params: has.params });
  });

  if (parsed.q) {
    const any = spec.qFields.map(field => `(${dialAllows(field, level)} AND CONTAINS(c.${field}, @nq, true))`);
    criteria.push({ clause: `(${any.join(' OR ')})`, params: [{ name: '@nq', value: parsed.q }] });
  }

  const orderBy = parsed.sort ? `c.${parsed.sort.field} ${parsed.sort.desc ? 'DESC' : 'ASC'}` : undefined;
  return { criteria, orderBy };
}

/** A 24-hex Eagle id, which a by-id read also accepts. */
function isEagleId(id) {
  return EAGLE_ID.test(String(id || ''));
}

/**
 * The repository a native kind needs, over one Cosmos container: `list` and `count` share one
 * predicate, `getById` is the same predicate narrowed to one id (cross-partition, so it needs no
 * partition key from the caller, and drains pages through `queryFirst`: one page can come back
 * empty while the row exists).
 *
 * @param {object} opts
 * @param {string} opts.container
 * @param {string} opts.entity          catalog entity, for the `selectFor` projection
 * @param {string} opts.partitionField  'id' or 'projectId'
 * @param {string} opts.defaultOrder    e.g. 'c.id ASC', used when the caller names no sort
 */
function cosmosKind({ container, entity, partitionField, defaultOrder }) {
  const spec = (access, criteria, orderBy) => selectWhere({
    access, partitionField, criteria, select: selectFor(entity, access, partitionField), orderBy
  });
  return {
    async list(access, { criteria, orderBy, pageNum, pageSize }) {
      return readPage(container, spec(access, criteria, orderBy || defaultOrder), { pageNum, pageSize });
    },
    async count(access, { criteria }) {
      const { items } = await cosmos.query(container, countWhere({ access, partitionField, criteria }), {});
      return items[0] || 0;
    },
    async getById(access, id) {
      return cosmos.queryFirst(container, spec(access, [eq('id', String(id), '@id')]), {});
    }
  };
}

/**
 * `parentJoin` for a kind whose rows carry `projectId`: adds `projectName` and `projectEagleId` from
 * the parent as this caller may see it. Runs on rows already redacted; a parent the caller cannot
 * read adds nothing.
 */
async function projectParentJoin(access, rows) {
  const projects = require('../repositories/projects');
  const ids = [...new Set(rows.map(row => row && row.projectId).filter(Boolean).map(String))];
  if (ids.length === 0) return rows;

  const parents = new Map((await projects.listRowsByIds(access, ids))
    .map(row => [String(row.id), redactForAccess('projects', row, access)]));
  return rows.map((row) => {
    const parent = row && parents.get(String(row.projectId));
    if (!parent) return row;
    return {
      ...row,
      ...(parent.name !== undefined ? { projectName: parent.name } : {}),
      ...(parent.eagleId !== undefined ? { projectEagleId: parent.eagleId } : {})
    };
  });
}

module.exports = {
  MAX_IDS,
  MAX_CONTAINS,
  ANON_MAX_PAGE_DEPTH,
  CONTROL_PARAMS,
  assertKindSpec,
  parseNativeQuery,
  nativeCriteria,
  presenceClause,
  dialAllows,
  rangeBound,
  isEagleId,
  cosmosKind,
  projectParentJoin
};
