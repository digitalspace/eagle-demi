'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

// First, before anything loads the logger: its uncaughtException handler turns a failed require
// into a passing file.
const controller = require('../../../src/controllers/nosql/comment-export');
const cosmos = require('../../../src/db/cosmos-nosql');
const commentPeriods = require('../../../src/repositories/comment-periods');
const projects = require('../../../src/repositories/projects');

const STAFF = { realm_access: { roles: ['staff'] } };

const PERIOD = {
  id: 'p1', projectId: '207', instructions: 'Site C public comment period', read: ['public', 'staff']
};
const PROJECT = { id: '207', name: 'Site C', read: ['public', 'staff'] };

const PUBLIC_ACL = ['public', 'staff', 'sysadmin'];

function comment(overrides) {
  return {
    id: 'c1', periodId: 'p1', projectId: '207', commentId: 1,
    dateAdded: '2026-03-02T18:00:00.000Z', datePosted: '2026-03-04T18:00:00.000Z',
    author: 'Pat Doe', isAnonymous: false, location: 'Fort St. John', comment: 'Plain text',
    documents: [], eaoStatus: 'Published', rejectedReason: null, rejectedNotes: null,
    eaoNotes: 'Reviewed', submittedCAC: false, read: PUBLIC_ACL, isPublished: true,
    ...overrides
  };
}

const DOCUMENTS = [
  { id: 'd-public', projectId: '207', read: ['public', 'staff'] },
  { id: 'd-sysadmin', projectId: '207', read: ['sysadmin'] }
];

/** Values of the parameters whose names start with `prefix`. */
function paramValues(spec, prefix) {
  return spec.parameters.filter(p => p.name.startsWith(prefix)).map(p => p.value);
}

/**
 * Cosmos stand-in that honours the role arm of `readClause` as Cosmos would: when the query carries
 * it, only rows whose `read[]` meets a bound role come back; without it, every row does.
 */
function fakeCosmos(t, commentRows) {
  t.mock.method(cosmos, 'query', async (container, spec) => {
    const roles = paramValues(spec, '@role');
    const roleArm = spec.query.includes('r IN c.read WHERE r IN (');
    const readable = row => !roleArm || row.read.some(r => roles.includes(r));
    if (container === 'comments') return { items: commentRows.filter(readable) };
    if (container === 'documents') {
      const ids = paramValues(spec, '@did');
      return { items: DOCUMENTS.filter(d => ids.includes(d.id)).filter(readable) };
    }
    throw new Error(`unexpected container ${container}`);
  });
  t.mock.method(commentPeriods, 'getById', async () => structuredClone(PERIOD));
  t.mock.method(projects, 'getById', async () => structuredClone(PROJECT));
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    json(data) { this.body = data; return this; },
    send(body) { this.body = body; return this; }
  };
}

/** RFC 4180 parse of the whole body: rows of fields. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; } else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; } else field += ch;
  }
  return rows;
}

/** The export as `{columns, records}`, each record keyed by column. */
async function exportAs(user, headers = {}) {
  const res = mockRes();
  await controller.exportComments({ params: { periodId: 'p1' }, query: {}, headers, user }, res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  const [columns, ...rows] = parseCsv(res.body);
  return {
    res,
    columns,
    records: rows.map(fields => Object.fromEntries(columns.map((c, i) => [c, fields[i]])))
  };
}

test('comment export', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a staff caller gets the staff columns', async () => {
    fakeCosmos(t, [comment()]);
    const { columns, records, res } = await exportAs(STAFF);

    assert.deepStrictEqual(columns, controller.STAFF_COLUMNS);
    assert.deepStrictEqual(columns, [
      'Comment_No', 'Submitted', 'Author', 'Location', 'Comment', 'Attachments', 'Published',
      'Status', 'Rejected_Reason', 'Rejected_Notes', 'EAO_Notes', 'Project', 'PCP_Title',
      'Export_Date', 'CACMember'
    ]);
    assert.strictEqual(records[0].Author, 'Pat Doe');
    assert.strictEqual(records[0].EAO_Notes, 'Reviewed');
    assert.strictEqual(records[0].Published, '2026-03-04');
    assert.strictEqual(records[0].Project, 'Site C');
    assert.strictEqual(records[0].PCP_Title, 'Site C public comment period');
    assert.strictEqual(res.headers['content-type'], 'text/csv; charset=utf-8');
  });

  await t.test('an anonymous caller gets the proponent columns with Author blank', async () => {
    fakeCosmos(t, [comment()]);
    const { columns, records } = await exportAs(undefined);

    assert.deepStrictEqual(columns, [
      'Comment_No', 'Submitted', 'Author', 'Location', 'Comment', 'Attachments', 'Published',
      'Pillar', 'Project', 'PCP_Title', 'Export_Date', 'CACMember'
    ]);
    assert.strictEqual(records[0].Author, '', 'attributed, but never in a proponent export');
    assert.strictEqual(records[0].Published, '', 'datePosted is a level-2 field');
    assert.strictEqual(records[0].Comment, 'Plain text');
  });

  await t.test('an anonymous comment has a blank Author in the staff export', async () => {
    fakeCosmos(t, [comment({ isAnonymous: true })]);
    const { records } = await exportAs(STAFF);

    assert.strictEqual(records[0].Author, '');
  });

  await t.test('quotes, commas and line breaks are escaped', async () => {
    fakeCosmos(t, [comment({ comment: 'He said "no", then\nleft' })]);
    const { res, records } = await exportAs(STAFF);

    assert.ok(res.body.includes('"He said ""no"", then\nleft"'), res.body);
    assert.strictEqual(records[0].Comment, 'He said "no", then\nleft');
  });

  await t.test('a comment the caller cannot read never appears', async () => {
    fakeCosmos(t, [
      comment({ id: 'c1', commentId: 1 }),
      comment({ id: 'c2', commentId: 2, comment: 'sysadmin only', read: ['sysadmin'] })
    ]);
    const { res, records } = await exportAs(STAFF);

    assert.deepStrictEqual(records.map(r => r.Comment_No), ['1']);
    assert.ok(!res.body.includes('sysadmin only'));
  });

  await t.test('an unpublished comment stays out of a proponent export', async () => {
    // Readable by an IDIR caller (level 3) but not public, so only the proponent filter drops it.
    fakeCosmos(t, [comment({ commentId: 3, isPublished: false, read: ['idir', 'staff'] })]);
    const idir = { identity_provider: 'idir' };
    const { records } = await exportAs(idir);

    assert.strictEqual(records.length, 0);
  });

  await t.test('attachments link only documents the caller can read', async () => {
    fakeCosmos(t, [comment({ documents: ['d-public', 'd-sysadmin'] })]);
    const { records } = await exportAs(STAFF, { host: 'demi.example' });

    assert.deepStrictEqual(JSON.parse(records[0].Attachments),
      ['https://demi.example/documents/d-public/download']);
  });

  await t.test('free text that starts like a formula is made inert', async () => {
    fakeCosmos(t, [comment({ comment: '=HYPERLINK("http://x")' })]);
    const { records } = await exportAs(STAFF);

    assert.strictEqual(records[0].Comment, '\'=HYPERLINK("http://x")');
  });

  await t.test('a period the caller cannot read is a 404', async () => {
    fakeCosmos(t, []);
    t.mock.method(commentPeriods, 'getById', async () => null);
    const res = mockRes();
    await controller.exportComments({ params: { periodId: 'p1' }, query: {}, headers: {} }, res);

    assert.strictEqual(res.statusCode, 404);
  });
});
