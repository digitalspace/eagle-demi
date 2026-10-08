'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { run, parseCsv, MIN_GAP_MS } = require('../../src/scripts/parity-eagle');
const { PARITY_MAP, classify } = require('../../src/scripts/parity-map');
const { unknownParams } = require('../../src/search/eagle-query');

const EAGLE = 'https://eagle.test/api';
const DEMI = 'https://demi.test/api';
const TOKEN = 'tok-3f9a-not-a-real-credential';

const A = '5c9a0b1e2f3d4a5b6c7d8e9f';
const B = '5c9a0b1e2f3d4a5b6c7d8ea0';

const searchBody = (rows, total = rows.length) => [{ meta: [{ searchResultsTotal: total }], searchResults: rows }];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A stubbed fetch on a fake clock. `answer(host, url)` returns the Response; every call is kept with
 * the fake time it was made at, so spacing is asserted without waiting.
 */
function harness(answer, { env = {}, files = {} } = {}) {
  let now = 0;
  const calls = [];
  const out = [];
  const written = [];
  const deps = {
    now: () => now,
    sleep: async (ms) => { now += ms; },
    fetch: async (url, init) => {
      const u = new URL(url);
      calls.push({ host: u.host, url: u, method: init.method, headers: init.headers, at: now });
      return answer(u.host, u);
    },
    env,
    log: (msg) => out.push(msg),
    error: (msg) => out.push(msg),
    readFile: (file) => files[file],
    writeFile: (file, text) => written.push(text)
  };
  return { deps, calls, out, written };
}

/** Same rows on both sides of `/search`, except what `eagle`/`demi` override. */
const searchSides = ({ eagle, demi }) => (host) => json(searchBody(host === 'eagle.test' ? eagle : demi));

const project = (id, extra = {}) => ({ _id: id, name: 'Mine', type: 'Mines', sector: 'Coal', region: 'Peace', location: 'Hudson Hope', ...extra });

test('a row only Eagle has, with no known cause, is unexplained and exits 1', async () => {
  const h = harness(searchSides({ eagle: [project(A), project(B)], demi: [project(A)] }));
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'search-Project-public'], h.deps);
  assert.strictEqual(code, 1);
  assert.match(h.out[0], /search-Project-public identity=anonymous match=1 missingInDemi=1 extraInDemi=0 fieldDiff=0 unexplained=1/);
});

test('a field value that differs with no known cause exits 1', async () => {
  const h = harness(searchSides({ eagle: [project(A)], demi: [project(A, { sector: 'Metals' })] }));
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'search-Project-public'], h.deps);
  assert.strictEqual(code, 1);
  assert.match(h.out[0], /match=0 missingInDemi=0 extraInDemi=0 fieldDiff=1 unexplained=1/);
});

// Eagle and DEMI both keep a no-ladder row from staff, so a staff gap there is real drift.
test('a staff row with no ladder token missing in DEMI is unexplained', async () => {
  const h = harness(searchSides({
    eagle: [project(A), project(B, { read: ['sysadmin'] })],
    demi: [project(A)]
  }), { env: { PARITY_TOKEN: TOKEN } });
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, '--identity', 'staff', '--token-env', 'PARITY_TOKEN',
    '--only', 'search-Project'], h.deps);
  assert.strictEqual(code, 1);
  assert.match(h.out[0], /missingInDemi=1 .*unexplained=1/);
});

const staffProjectRun = async (demiExtra) => {
  const h = harness(searchSides({
    eagle: [project(A, { CELead: 'Casey Federal', directoryStructure: [{ id: 1 }] })],
    demi: [project(A, { CELead: 'Casey Federal', directoryStructure: [{ id: 1 }], ...demiExtra })]
  }), { env: { PARITY_TOKEN: TOKEN } });
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, '--identity', 'staff', '--token-env', 'PARITY_TOKEN',
    '--only', 'search-Project'], h.deps);
  return { code, line: h.out[0] };
};

test('a promoted staff field missing from DEMI is unexplained, not excused as L3', async () => {
  const { code, line } = await staffProjectRun({ CELead: null });
  assert.strictEqual(code, 1);
  assert.match(line, /fieldDiff=1 unexplained=1/);
});

test('a staff field DEMI does not promote yet is counted under L3 and exits 0', async () => {
  const { code, line } = await staffProjectRun({ directoryStructure: null });
  assert.strictEqual(code, 0);
  assert.match(line, /fieldDiff=1 unexplained=0 known=L3-staff-field-not-promoted:1/);
});

test('an id listed under a class in --known-ids is counted under that class and exits 0', async () => {
  const h = harness(searchSides({ eagle: [project(A), project(B)], demi: [project(A)] }),
    { files: { 'known.json': JSON.stringify({ 'L2-never-mirrored': [B] }) } });
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'search-Project-public',
    '--known-ids', 'known.json'], h.deps);
  assert.strictEqual(code, 0);
  assert.match(h.out[0], /unexplained=0 known=L2-never-mirrored:1/);
});

test('a pending read is reported as skipped and makes no request', async () => {
  const h = harness(() => assert.fail('no request expected'));
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'topic-vc'], h.deps);
  assert.strictEqual(code, 0);
  assert.match(h.out[0], /topic-vc identity=anonymous skipped \(pending\)/);
  assert.strictEqual(h.calls.length, 0);
});

test('requests to each API are GET only and at least MIN_GAP_MS apart', async () => {
  // 250 rows: three pages a side.
  const rows = Array.from({ length: 250 }, (_, i) => project(i.toString(16).padStart(24, '0')));
  const h = harness((host, url) => {
    const page = Number(url.searchParams.get('pageNum'));
    return json(searchBody(rows.slice(page * 100, page * 100 + 100), rows.length));
  });
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'search-Project-public'], h.deps);
  assert.strictEqual(code, 0);
  assert.deepStrictEqual([...new Set(h.calls.map(c => c.method))], ['GET']);
  const gaps = ['eagle.test', 'demi.test'].flatMap(host => {
    const at = h.calls.filter(c => c.host === host).map(c => c.at);
    return at.slice(1).map((t, i) => t - at[i]);
  });
  assert.strictEqual(gaps.length, 4);
  assert.ok(gaps.every(g => g >= MIN_GAP_MS), `gaps ${gaps}`);
});

test('a 5xx is retried once, then the read fails and exits 1', async () => {
  const h = harness((host) => (host === 'eagle.test' ? json({}, 503) : json(searchBody([]))));
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'search-Project-public'], h.deps);
  assert.strictEqual(code, 1);
  assert.strictEqual(h.calls.filter(c => c.host === 'eagle.test').length, 2);
  assert.match(h.out[0], /error: HTTP 503/);
});

test('a map entry on the public download route is refused before any request', async () => {
  const h = harness(() => assert.fail('no request expected'));
  const map = [{ read: 'dl', identities: ['anonymous'], dataset: 'Document',
    eagle: { path: '/public/document/:document/download', shape: 'array' },
    demi: { path: '/documents/:document', shape: 'object' } }];
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, '--id', `document=${A}`], { ...h.deps, map });
  assert.strictEqual(code, 1);
  assert.match(h.out[0], /public download route is never called/);
});

test('the token is sent to both APIs and never appears in output or the report', async () => {
  const h = harness((host, url) => (url.searchParams.get('dataset') === 'List'
    ? json({}, 500)
    : json(searchBody([project(A)]))), { env: { PARITY_TOKEN: TOKEN } });
  await run(['--eagle', EAGLE, '--demi', DEMI, '--identity', 'staff', '--token-env', 'PARITY_TOKEN',
    '--report', 'out.json'], h.deps);
  assert.deepStrictEqual([...new Set(h.calls.map(c => c.headers.authorization))], [`Bearer ${TOKEN}`]);
  assert.ok(h.out.some(line => /error: HTTP 500/.test(line)), 'an error line was printed');
  assert.ok(!h.out.join('\n').includes(TOKEN));
  assert.strictEqual(h.written.length, 1);
  assert.ok(!h.written[0].includes(TOKEN));
});

test('a token passed as an argument is refused without being echoed', async () => {
  const h = harness(() => assert.fail('no request expected'));
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, TOKEN], h.deps);
  assert.strictEqual(code, 1);
  assert.ok(!h.out.join('\n').includes(TOKEN));
});

/**
 * Downloads: Eagle streams `eagleBytes`; DEMI redirects to a presigned store URL serving
 * `storeBytes`. Every other request gets the one row A, so the Document reads pair it.
 */
const downloads = ({ eagleBytes = 'pdf-bytes', storeBytes = 'pdf-bytes' } = {}) => (host, url) => {
  if (host === 'store.test') return new Response(storeBytes);
  if (url.pathname.endsWith('/download')) {
    return host === 'eagle.test'
      ? new Response(eagleBytes)
      : new Response(null, { status: 302, headers: { location: 'https://store.test/zdspnb/a.pdf?sig=s' } });
  }
  const rows = [{ _id: A, documentFileName: 'a.pdf' }];
  return json(url.pathname.endsWith('/search') ? searchBody(rows) : rows);
};
const staff = ['--eagle', EAGLE, '--demi', DEMI, '--identity', 'staff', '--token-env', 'PARITY_TOKEN'];
const downloadLine = h => h.out.find(line => /document-download identity/.test(line));

test('a download with the same bytes on both sides matches, and the store gets no token', async () => {
  const h = harness(downloads(), { env: { PARITY_TOKEN: TOKEN } });
  const code = await run([...staff, '--download-sample', '1'], h.deps);
  assert.strictEqual(code, 0);
  assert.match(downloadLine(h), /document-download identity=staff match=1 .*fieldDiff=0 unexplained=0/);
  const store = h.calls.filter(c => c.host === 'store.test');
  assert.strictEqual(store.length, 1);
  assert.strictEqual(store[0].headers.authorization, undefined);
});

test('a download whose bytes differ is unexplained and exits 1', async () => {
  const h = harness(downloads({ storeBytes: 'pdf-bytez' }), { env: { PARITY_TOKEN: TOKEN } });
  const code = await run([...staff, '--download-sample', '1'], h.deps);
  assert.strictEqual(code, 1);
  assert.match(downloadLine(h), /match=0 .*fieldDiff=1 unexplained=1/);
});

test('an --id document no read paired is never downloaded', async () => {
  const h = harness(downloads(), { env: { PARITY_TOKEN: TOKEN } });
  await run([...staff, '--id', `document=${B}`, '--download-sample', '5'], h.deps);
  const downloaded = h.calls.filter(c => c.url.pathname.endsWith('/download')).map(c => c.url.pathname);
  assert.deepStrictEqual(downloaded, [`/api/document/${A}/download`, `/api/documents/${A}/download`]);
});

test('with --only document-download no read pairs a document, so nothing is downloaded', async () => {
  const h = harness(downloads(), { env: { PARITY_TOKEN: TOKEN } });
  const code = await run([...staff, '--only', 'document-download', '--id', `document=${A}`, '--download-sample', '1'], h.deps);
  assert.strictEqual(code, 0);
  assert.strictEqual(h.calls.length, 0);
  assert.match(h.out[0], /document-download identity=staff skipped: no document paired on both sides/);
});

test('with no --download-sample nothing is downloaded', async () => {
  const h = harness(downloads(), { env: { PARITY_TOKEN: TOKEN } });
  await run(staff, h.deps);
  assert.strictEqual(h.calls.filter(c => /download/i.test(c.url.pathname)).length, 0);
  assert.ok(h.out.some(line => /document-download identity=staff skipped: off/.test(line)));
});

test('a sampled run downloads through the protected route only, never the public one', async () => {
  const h = harness(downloads(), { env: { PARITY_TOKEN: TOKEN } });
  const code = await run([...staff, '--download-sample', '2'], h.deps);
  assert.strictEqual(code, 0);
  const paths = h.calls.filter(c => c.host === 'eagle.test').map(c => c.url.pathname);
  assert.ok(paths.includes(`/api/document/${A}/download`), 'the protected route was sampled');
  assert.deepStrictEqual(paths.filter(p => /\/public\/.*download/i.test(p)), []);
});

test('every DEMI search request in the map uses only parameters DEMI knows', () => {
  const offenders = PARITY_MAP
    .filter(e => !e.skip && e.demi.path === '/search')
    .map(e => [e.read, unknownParams({ ...e.demi.query, pageNum: '0', pageSize: '100' })])
    .filter(([, unknown]) => unknown.length);
  assert.deepStrictEqual(offenders, []);
});

test('--max-pages reads that many pages per side and reports the read as truncated, not as missing rows', async () => {
  const ids = Array.from({ length: 250 }, (_, i) => i.toString(16).padStart(24, '0'));
  // DEMI orders differently, so its first page shares no row with Eagle's.
  const pageOf = (order, url) => {
    const pageNum = Number(url.searchParams.get('pageNum'));
    return json(searchBody(order.slice(pageNum * 100, pageNum * 100 + 100).map(id => project(id)), order.length));
  };
  const h = harness((host, url) => pageOf(host === 'eagle.test' ? ids : [...ids].reverse(), url));
  await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'search-Project-public', '--max-pages', '1'], h.deps);
  assert.strictEqual(h.calls.length, 2);
  assert.match(h.out[0], /missingInDemi=0 extraInDemi=0 .* truncated$/);
});

test('a quoted CSV field keeps its comma', () => {
  assert.deepStrictEqual(parseCsv('a,b\r\n"x, y",z\r\n'), [['a', 'b'], ['x, y', 'z']]);
});

test('a quoted CSV field keeps its line break', () => {
  assert.deepStrictEqual(parseCsv('a,b\n"line 1\nline 2",z'), [['a', 'b'], ['line 1\nline 2', 'z']]);
});

test('a doubled quote inside a quoted CSV field reads as one quote', () => {
  assert.deepStrictEqual(parseCsv('a\n"say ""hi"""\n'), [['a'], ['say "hi"']]);
});

const COMMENT_COLUMNS = ['Comment_No', 'Author', 'Comment', 'Attachments', 'Export_Date'];
const csvText = (columns, rows) => [columns, ...rows]
  .map(cells => cells.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
  .join('\r\n') + '\r\n';
const exportRow = (no, extra = {}) => {
  const row = { Comment_No: no, Author: 'Anonymous', Comment: 'Too loud,\nat night', Attachments: '[]',
    Export_Date: '2026-10-06', ...extra };
  return COMMENT_COLUMNS.map(c => row[c]);
};
const csvSides = (eagleRows, demiRows, columns = COMMENT_COLUMNS) => (host) =>
  new Response(csvText(columns, host === 'eagle.test' ? eagleRows : demiRows));
const exportRun = async (answer) => {
  const h = harness(answer, { env: { PARITY_TOKEN: TOKEN } });
  const code = await run([...staff, '--only', 'comment-export', '--id', `period=${A}`], h.deps);
  return { code, line: h.out[0] };
};

test('a comment export row that differs between the CSVs is unexplained and exits 1', async () => {
  const { code, line } = await exportRun(csvSides([exportRow(1), exportRow(2)],
    [exportRow(1), exportRow(2, { Comment: 'Edited' })]));
  assert.strictEqual(code, 1);
  assert.match(line, /comment-export identity=staff match=1 missingInDemi=0 extraInDemi=0 fieldDiff=1 unexplained=1/);
});

test('comment export CSVs that differ only in Export_Date match and exit 0', async () => {
  const { code, line } = await exportRun(csvSides([exportRow(1, { Export_Date: '2026-10-05' })], [exportRow(1)]));
  assert.strictEqual(code, 0);
  assert.match(line, /match=1 missingInDemi=0 extraInDemi=0 fieldDiff=0 unexplained=0/);
});

test('a comment number only DEMI exports is unexplained, not excused as demi-only', async () => {
  const { code, line } = await exportRun(csvSides([exportRow(1)], [exportRow(1), exportRow(2)]));
  assert.strictEqual(code, 1);
  assert.match(line, /extraInDemi=1 fieldDiff=0 unexplained=1/);
});

test('a column only one export has is a header difference and exits 1', async () => {
  const { code, line } = await exportRun((host) => (host === 'eagle.test'
    ? new Response(csvText([...COMMENT_COLUMNS, 'Pillar'], [[...exportRow(1), '']]))
    : new Response(csvText(COMMENT_COLUMNS, [exportRow(1)]))));
  assert.strictEqual(code, 1);
  assert.match(line, /match=1 .*fieldDiff=1 unexplained=1/);
});

test('attachment links to the same documents on each API are counted as a known difference', async () => {
  const { code, line } = await exportRun(csvSides(
    [exportRow(1, { Attachments: JSON.stringify([`https://eagle.test/api/document/${B}/fetch`]) })],
    [exportRow(1, { Attachments: JSON.stringify([`https://demi.test/api/documents/${B}/download`]) })]));
  assert.strictEqual(code, 0);
  assert.match(line, /fieldDiff=1 unexplained=0 known=export-attachment-route:1/);
});

test('attachment links to different documents are unexplained and exit 1', async () => {
  const { code, line } = await exportRun(csvSides(
    [exportRow(1, { Attachments: JSON.stringify([`https://eagle.test/api/document/${A}/fetch`]) })],
    [exportRow(1, { Attachments: JSON.stringify([`https://demi.test/api/documents/${B}/download`]) })]));
  assert.strictEqual(code, 1);
  assert.match(line, /match=0 missingInDemi=0 extraInDemi=0 fieldDiff=1 unexplained=1/);
});

test('the same columns in a different order are a header difference and exit 1', async () => {
  const reordered = ['Comment_No', 'Comment', 'Author', 'Attachments', 'Export_Date'];
  const cells = exportRow(1);
  const { code, line } = await exportRun((host) => new Response(host === 'eagle.test'
    ? csvText(COMMENT_COLUMNS, [cells])
    : csvText(reordered, [reordered.map(c => cells[COMMENT_COLUMNS.indexOf(c)])])));
  assert.strictEqual(code, 1);
  assert.match(line, /match=1 missingInDemi=0 extraInDemi=0 fieldDiff=1 unexplained=1/);
});

const BCGW_COLUMNS = ['Project name', 'URL to Epic Project', 'Project GUID'];
// Both report writers wrap the Project GUID cell in literal quotes.
const bcgwRow = (id, host = 'projects.eao.gov.bc.ca', linkId = id) =>
  ['Mine', `https://${host}/p/${linkId}/project-details`, `"${id}"`];
const bcgwRun = async (eagleRows, demiRows, { args = [], files } = {}) => {
  const h = harness(csvSides(eagleRows, demiRows, BCGW_COLUMNS), { files });
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'report-bcgw', ...args], h.deps);
  return { code, line: h.out[0] };
};

test('a BCGW project link that differs only by host is counted as a known difference', async () => {
  const { code, line } = await bcgwRun([bcgwRow(A)], [bcgwRow(A, 'eagle-test.example')]);
  assert.strictEqual(code, 0);
  assert.match(line,
    /report-bcgw identity=anonymous match=0 missingInDemi=0 extraInDemi=0 fieldDiff=1 unexplained=0 known=bcgw-link-host:1/);
});

test('a BCGW project link that points at a different project is unexplained and exits 1', async () => {
  const { code, line } = await bcgwRun([bcgwRow(A)], [bcgwRow(A, 'eagle-test.example', B)]);
  assert.strictEqual(code, 1);
  assert.match(line, /match=0 missingInDemi=0 extraInDemi=0 fieldDiff=1 unexplained=1/);
});

test('a quoted BCGW Project GUID is matched against bare Eagle ids in --known-ids', async () => {
  const { code, line } = await bcgwRun([bcgwRow(A), bcgwRow(B)], [bcgwRow(A)], {
    args: ['--known-ids', 'known.json'],
    files: { 'known.json': JSON.stringify({ 'L2-never-mirrored': [B] }) }
  });
  assert.strictEqual(code, 0);
  assert.match(line, /match=1 missingInDemi=1 extraInDemi=0 fieldDiff=0 unexplained=0 known=L2-never-mirrored:1/);
});

test('a BCGW row only DEMI has, keyed by a quoted Eagle id, is unexplained, not excused as demi-only', async () => {
  const { code, line } = await bcgwRun([bcgwRow(A)], [bcgwRow(A), bcgwRow(B)]);
  assert.strictEqual(code, 1);
  assert.match(line, /match=1 missingInDemi=0 extraInDemi=1 fieldDiff=0 unexplained=1/);
});

const [INSPECTION, ELEMENT, GROUP] = ['1'.repeat(24), '2'.repeat(24), '3'.repeat(24)];

test('--id inspection, element and group fill the paths and queries of both APIs', async () => {
  const h = harness(() => json([]), { env: { PARITY_TOKEN: TOKEN } });
  await run([...staff, '--id', `inspection=${INSPECTION}`, '--id', `element=${ELEMENT}`, '--only', 'inspection-item'], h.deps);
  await run([...staff, '--id', `group=${GROUP}`, '--id', `project=${A}`, '--only', 'group-members'], h.deps);
  const urls = h.calls.map(c => `${c.host}${c.url.pathname}${c.url.search}`);
  assert.deepStrictEqual(urls, [
    `eagle.test/api/search?dataset=Item&_id=${ELEMENT}&_schemaName=InspectionElement`,
    `demi.test/api/inspection-items?inspection=${INSPECTION}&element=${ELEMENT}`,
    `eagle.test/api/project/${A}/group/${GROUP}/members`,
    // DEMI's `project` query is a Track id partition key; an Eagle id there answers 404.
    `demi.test/api/groups/${GROUP}`
  ]);
});

/** Eagle's member read answers User rows in a count facet; DEMI's group read the Group itself. */
const groupRun = async (users, members) => {
  const h = harness((host) => (host === 'eagle.test'
    ? json([{ total_items: users.length, results: users.map(id => ({ _id: id, displayName: 'Casey' })) }])
    : json({ id: GROUP, eagleId: GROUP, name: 'Team', members })), { env: { PARITY_TOKEN: TOKEN } });
  const code = await run([...staff, '--id', `project=${A}`, '--id', `group=${GROUP}`, '--only', 'group-members'], h.deps);
  return { code, line: h.out[0] };
};

test('group members pair Eagle User rows with the DEMI group member ids', async () => {
  const { code, line } = await groupRun([A, B], [B, A]);
  assert.strictEqual(code, 0);
  assert.match(line, /group-members identity=staff match=2 missingInDemi=0 extraInDemi=0 fieldDiff=0 unexplained=0/);
});

test('a member Eagle lists and the DEMI group lacks is unexplained and exits 1', async () => {
  const { code, line } = await groupRun([A, B], [A]);
  assert.strictEqual(code, 1);
  assert.match(line, /match=1 missingInDemi=1 extraInDemi=0 .*unexplained=1/);
});

const eagleCall = (h, path) => h.calls.find(c => c.host === 'eagle.test' && c.url.pathname === `/api${path}`);
/** Eagle answers `byPath[path]` (a plain array) and DEMI `demiBody`. */
const restSides = (byPath, demiBody) => (host, url) => (host === 'eagle.test'
  ? json(byPath[url.pathname.replace(/^\/api/, '')] || [])
  : json(demiBody));

test('each Eagle REST read asks for its own compared fields, pipe-joined, per identity', async () => {
  const anon = harness(restSides({ [`/public/project/${A}`]: [project(A)] }, project(A)));
  await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'project-public', '--id', `project=${A}`], anon.deps);
  assert.strictEqual(eagleCall(anon, `/public/project/${A}`).url.searchParams.get('fields'),
    'name|sector|region|type|location|review180Start|review45Start|reviewSuspensions|reviewExtensions');
  assert.ok(!anon.calls.some(c => c.host === 'demi.test' && c.url.searchParams.has('fields')), 'DEMI gets no fields');

  const staffRun = harness(restSides({ [`/project/${A}`]: [project(A)] }, project(A)), { env: { PARITY_TOKEN: TOKEN } });
  await run([...staff, '--only', 'project', '--id', `project=${A}`], staffRun.deps);
  const staffFields = eagleCall(staffRun, `/project/${A}`).url.searchParams.get('fields').split('|');
  assert.ok(staffFields.includes('CELead') && staffFields.includes('directoryStructure'));
  assert.ok(!staffFields.includes('review180Start'));

  const period = harness(restSides({ [`/public/commentperiod/${B}`]: [] }, searchBody([])));
  await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'commentperiod-public', '--id', `period=${B}`], period.deps);
  assert.strictEqual(eagleCall(period, `/public/commentperiod/${B}`).url.searchParams.get('fields'),
    'dateStarted|dateCompleted|instructions|project');
});

test('every Eagle project, document, comment period, organization and comment REST read sends fields', () => {
  const unfielded = PARITY_MAP
    .filter(e => !e.skip && !e.download && !e.format &&
      /^\/(public\/)?(project|document|commentperiod|organization|comment)(\/:[a-z]+)?$/.test(e.eagle.path))
    .filter(e => !e.eagle.fields)
    .map(e => e.read);
  assert.deepStrictEqual(unfielded, []);
});

/** Eagle's count facet. */
const facet = (rows, total = rows.length) => [{ total_items: total, results: rows, read: ['public'] }];

test('an empty Eagle pin or comment facet with no results array is an empty read', async () => {
  const empty = () => json([{ total_items: 0 }]);
  const pins = harness((host) => (host === 'eagle.test' ? empty() : json({ id: 'p1', eagleId: A, pins: [] })));
  assert.strictEqual(await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'pins-public', '--id', `project=${A}`],
    pins.deps), 0);
  assert.match(pins.out[0], /pins-public identity=anonymous match=0 missingInDemi=0 extraInDemi=0 fieldDiff=0 unexplained=0/);

  const comments = harness((host) => (host === 'eagle.test' ? empty() : json(searchBody([]))));
  assert.strictEqual(await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'comment-list-public', '--id', `period=${A}`],
    comments.deps), 0);
  assert.match(comments.out[0], /comment-list-public identity=anonymous match=0 missingInDemi=0 extraInDemi=0 .*unexplained=0/);
});

test('Eagle pins in a count facet pair with the DEMI project pins', async () => {
  const pin = id => ({ _id: id, name: 'Nation', province: 'BC' });
  const h = harness((host) => (host === 'eagle.test'
    ? json(facet([pin(A), pin(B)]))
    : json({ id: 'p1', eagleId: A, pins: [pin(B), pin(A)] })));
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'pins-public', '--id', `project=${A}`], h.deps);
  assert.strictEqual(code, 0);
  assert.match(h.out[0], /pins-public identity=anonymous match=2 missingInDemi=0 extraInDemi=0 .*unexplained=0/);
});

test('a comment list in count facets is read page by page to its total', async () => {
  const ids = Array.from({ length: 250 }, (_, i) => i.toString(16).padStart(24, '0'));
  const comment = id => ({ _id: id, commentId: 1, comment: 'ok', dateAdded: '2026-10-01T00:00:00.000Z',
    location: 'BC', isAnonymous: true });
  const h = harness((host, url) => {
    const page = Number(url.searchParams.get('pageNum'));
    const rows = ids.slice(page * 100, page * 100 + 100).map(comment);
    return json(host === 'eagle.test' ? facet(rows, ids.length) : searchBody(rows, ids.length));
  });
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'comment-list-public', '--id', `period=${A}`], h.deps);
  assert.strictEqual(code, 0);
  assert.match(h.out[0], /match=250 missingInDemi=0 extraInDemi=0 fieldDiff=0 unexplained=0/);
  assert.strictEqual(h.calls.filter(c => c.host === 'eagle.test').length, 3);
});

test("recent activity compares Eagle's top 4 with DEMI's RecentActivity top page of 4", async () => {
  const activity = { _id: A, headline: 'News', dateAdded: '2026-10-01T00:00:00.000Z' };
  const h = harness((host) => json(host === 'eagle.test' ? [activity] : searchBody([activity])));
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'recent-activity-top'], h.deps);
  assert.strictEqual(code, 0);
  const demiQuery = Object.fromEntries(h.calls.find(c => c.host === 'demi.test').url.searchParams);
  assert.deepStrictEqual(demiQuery, { dataset: 'RecentActivity', top: 'true', pageSize: '4' });
});

test('values equal but for surrounding spaces, or an empty list against none, match', async () => {
  const h = harness(searchSides({
    eagle: [project(A, { name: 'Mine ', reviewSuspensions: [] })],
    demi: [project(A, { name: ' Mine' })]
  }));
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'search-Project-public'], h.deps);
  assert.strictEqual(code, 0);
  assert.match(h.out[0], /match=1 missingInDemi=0 extraInDemi=0 fieldDiff=0 unexplained=0/);
});

test('an empty or blank string against null matches, but differing trimmed text still differs', async () => {
  const same = harness(searchSides({
    eagle: [project(A, { region: '', location: '   ' })],
    demi: [project(A, { region: null, location: null })]
  }));
  assert.strictEqual(await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'search-Project-public'], same.deps), 0);
  assert.match(same.out[0], /match=1 missingInDemi=0 extraInDemi=0 fieldDiff=0 unexplained=0/);

  const differ = harness(searchSides({ eagle: [project(A, { region: ' Peace ' })], demi: [project(A, { region: 'Skeena' })] }));
  assert.strictEqual(await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'search-Project-public'], differ.deps), 1);
  assert.match(differ.out[0], /fieldDiff=1 unexplained=1/);
});

test('a list with values against none still differs', async () => {
  const h = harness(searchSides({ eagle: [project(A, { reviewSuspensions: ['2020-01-01'] })], demi: [project(A)] }));
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'search-Project-public'], h.deps);
  assert.strictEqual(code, 1);
  assert.match(h.out[0], /fieldDiff=1 unexplained=1/);
});

test('an organization city and province only DEMI shows are public-field differences, counted once', async () => {
  const org = (extra = {}) => ({ _id: A, name: 'Org', companyType: 'Proponent', ...extra });
  const h = harness(searchSides({ eagle: [org()], demi: [org({ city: 'Victoria', province: 'BC' })] }));
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'search-Organization-public'], h.deps);
  assert.strictEqual(code, 0);
  assert.match(h.out[0], /fieldDiff=2 unexplained=0 known=public-field-difference:2/);
});

const trackRun = async (demiExtra) => {
  const h = harness(searchSides({ eagle: [project(A)], demi: [project(A, { trackProjectId: 12, ...demiExtra })] }));
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'search-Project-public'], h.deps);
  return { code, line: h.out[0] };
};

test('a Track-mastered project field DEMI fills differently is counted as track-mastered', async () => {
  const { code, line } = await trackRun({ type: 'Mines - Coal', location: 'Near Hudson Hope' });
  assert.strictEqual(code, 0);
  assert.match(line, /fieldDiff=2 unexplained=0 known=track-mastered:2/);
});

test('a Track field differing on a project with no Track row is unexplained', async () => {
  const { code, line } = await trackRun({ trackProjectId: null, type: 'Mines - Coal' });
  assert.strictEqual(code, 1);
  assert.match(line, /fieldDiff=1 unexplained=1/);
});

test('a differing field Track does not master, or an empty DEMI value, is unexplained', async () => {
  const { code, line } = await trackRun({ sector: 'Metals', location: '' });
  assert.strictEqual(code, 1);
  assert.match(line, /fieldDiff=2 unexplained=2/);
});

test('a BCGW Type DEMI fills from Track is track-mastered; a differing MOE Region is not', async () => {
  const columns = ['Type', 'MOE Region', 'Project GUID'];
  const h = harness(csvSides([['Mines', 'Peace', `"${A}"`]], [['Mines - Coal', 'Omineca', `"${A}"`]], columns));
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'report-bcgw'], h.deps);
  assert.strictEqual(code, 1);
  assert.match(h.out[0], /fieldDiff=2 unexplained=1 known=track-mastered:1/);
});

const listRow = (id, extra = {}) => ({ _id: id, name: 'Project News', type: 'updateCategory', legislation: 0, ...extra });
const listRun = async (eagle, demi) => {
  const h = harness(searchSides({ eagle, demi }));
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'search-List-public'], h.deps);
  return { code, line: h.out[0] };
};

test('a List row each side holds under its own id is counted as list-id-other-env', async () => {
  const { code, line } = await listRun([listRow(A)], [listRow(B, { name: 'Project News ' })]);
  assert.strictEqual(code, 0);
  assert.match(line, /missingInDemi=1 extraInDemi=1 fieldDiff=0 unexplained=0 known=list-id-other-env:2/);
});

test('a List row whose legislation differs on the other side is unexplained', async () => {
  const { code, line } = await listRun([listRow(A)], [listRow(B, { legislation: 2018 })]);
  assert.strictEqual(code, 1);
  assert.match(line, /missingInDemi=1 extraInDemi=1 fieldDiff=0 unexplained=2/);
});

test('a missing List row whose twin on the other side is already paired is unexplained', async () => {
  const { code, line } = await listRun([listRow(A), listRow(B)], [listRow(A)]);
  assert.strictEqual(code, 1);
  assert.match(line, /match=1 missingInDemi=1 extraInDemi=0 fieldDiff=0 unexplained=1/);
});

const [HIDDEN, SHOWN] = ['4'.repeat(24), '5'.repeat(24)];
const periodRun = async (publicProjects, args = []) => {
  const period = { _id: B, project: HIDDEN, dateStarted: '2026-08-26T07:00:00.000Z', instructions: 'x' };
  const h = harness(restSides({
    '/public/project': publicProjects.map(id => ({ _id: id })),
    '/public/commentperiod': [period]
  }, searchBody([])));
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'commentperiod-list-public',
    '--id', `project=${HIDDEN}`, ...args], h.deps);
  return { code, line: h.out.find(l => /commentperiod-list-public/.test(l)) };
};

test('a --max-pages cut of the public project list leaves a missing comment period unexplained', async () => {
  // One full page and no total: the list may go on, so HIDDEN's absence proves nothing.
  const fullPage = Array.from({ length: 100 }, (_, i) => (i + 1).toString(16).padStart(24, '6'));
  const { code, line } = await periodRun(fullPage, ['--max-pages', '1']);
  assert.strictEqual(code, 1);
  assert.match(line, /missingInDemi=1 .*unexplained=1/);
  assert.doesNotMatch(line, /parent-not-public/);
});

test('a public comment period of a project Eagle does not list publicly is counted as parent-not-public', async () => {
  const { code, line } = await periodRun([SHOWN]);
  assert.strictEqual(code, 0);
  assert.match(line, /missingInDemi=1 .*unexplained=0 known=parent-not-public:1/);
});

test('a missing public comment period whose project Eagle lists publicly is unexplained', async () => {
  const { code, line } = await periodRun([SHOWN, HIDDEN]);
  assert.strictEqual(code, 1);
  assert.match(line, /missingInDemi=1 .*unexplained=1/);
});

// classify() as reconcile-eagle calls it: id-level, anonymous, one parentState per row.
const idCtx = (ctx) => ({ identity: 'anonymous', dataset: 'Document', id: A, eagle: { _id: A }, unpaired: [], ...ctx });

test('a missing row whose parent Eagle, DEMI and Track all lack is an orphan', () => {
  assert.strictEqual(classify(idCtx({ kind: 'missingInDemi', parentState: 'missing-in-eagle' })),
    'orphan-parent-missing-in-eagle');
});

test('a missing document whose parent project is not public is parent-not-public', () => {
  assert.strictEqual(classify(idCtx({ kind: 'missingInDemi', parentState: 'not-public' })), 'parent-not-public');
});

test('a missing row whose parent DEMI holds is push-missed-parent-in-demi', () => {
  assert.strictEqual(classify(idCtx({ kind: 'missingInDemi', parentState: 'in-demi' })), 'push-missed-parent-in-demi');
});

test('a missing row with no parent is push-missed', () => {
  assert.strictEqual(classify(idCtx({ kind: 'missingInDemi', dataset: 'Project', parentState: null })), 'push-missed');
});

test('a row only DEMI holds under an Eagle id is push-missed, even with its parent in DEMI', () => {
  assert.strictEqual(classify(idCtx({ kind: 'extraInDemi', demi: { id: A }, byEagleId: true, parentState: 'in-demi' })),
    'push-missed');
});

test('a Track-only row is still demi-only when a parentState is given', () => {
  assert.strictEqual(classify(idCtx({ kind: 'extraInDemi', id: 'track-42', byEagleId: true, parentState: null })),
    'demi-only');
});

test('a difference no class explains and no parentState given is unexplained', () => {
  assert.strictEqual(classify(idCtx({ kind: 'missingInDemi' })), null);
});

const facetSides = rowsOf => (host, url) => {
  const rows = rowsOf(host);
  if (url.pathname.endsWith('/search')) return json(searchBody(rows));
  return json(host === 'eagle.test' ? facet(rows) : rows);
};

test("the staff project list unwraps Eagle's count facet and pairs on the project ids", async () => {
  const h = harness(facetSides(() => [project(A), project(B)]), { env: { PARITY_TOKEN: TOKEN } });
  const code = await run([...staff, '--only', 'project-list'], h.deps);
  assert.strictEqual(code, 0);
  assert.match(h.out[0], /project-list identity=staff match=2 missingInDemi=0 extraInDemi=0 fieldDiff=0 unexplained=0/);
});

test('the project notification list asks Eagle for its compared fields', async () => {
  const h = harness(restSides({}, searchBody([])), { env: { PARITY_TOKEN: TOKEN } });
  await run([...staff, '--only', 'project-notification-list'], h.deps);
  assert.strictEqual(eagleCall(h, '/projectNotification').url.searchParams.get('fields'), 'name|type|subType');
});

const org = (extra = {}) => ({ _id: A, name: 'Org', companyType: 'Proponent', ...extra });

test("the organization route is asked for and compared on only the fields Eagle's route answers", async () => {
  const h = harness(restSides({ '/organization': [org()] }, searchBody([org({ city: 'Victoria', address2: 'Unit 4' })])),
    { env: { PARITY_TOKEN: TOKEN } });
  const code = await run([...staff, '--only', 'organization-list'], h.deps);
  assert.strictEqual(code, 0);
  assert.match(h.out[0], /match=1 missingInDemi=0 extraInDemi=0 fieldDiff=0 unexplained=0/);
  const asked = eagleCall(h, '/organization').url.searchParams.get('fields').split('|');
  assert.deepStrictEqual(asked.filter(f => ['city', 'province', 'address2'].includes(f)), []);
});

test('staff organization search still compares the address fields', async () => {
  const h = harness(searchSides({ eagle: [org({ city: 'Nanaimo' })], demi: [org({ city: 'Victoria' })] }),
    { env: { PARITY_TOKEN: TOKEN } });
  const code = await run([...staff, '--only', 'search-Organization'], h.deps);
  assert.strictEqual(code, 1);
  assert.match(h.out[0], /fieldDiff=1 unexplained=1/);
});

const ADDED = '2019-03-01T08:00:00.000Z';
const UPDATED = '2024-06-01T08:00:00.000Z';

test('staff organization search compares dateAdded and dateUpdated; null and absent match', async () => {
  for (const field of ['dateAdded', 'dateUpdated']) {
    const { code, line } = await staffSearch('Organization', org({ [field]: ADDED }), org({ [field]: UPDATED }));
    assert.strictEqual(code, 1, field);
    assert.match(line, /fieldDiff=1 unexplained=1/, field);
  }
  const { code, line } = await staffSearch('Organization', org({ dateAdded: ADDED }), org({ dateAdded: ADDED, dateUpdated: null }));
  assert.strictEqual(code, 0);
  assert.match(line, /match=1 .*fieldDiff=0/);
});

test('the organization route neither asks for nor compares the dates', async () => {
  const h = harness(restSides({ '/organization': [org({ dateAdded: ADDED, dateUpdated: ADDED })] },
    searchBody([org({ dateAdded: UPDATED, dateUpdated: UPDATED })])), { env: { PARITY_TOKEN: TOKEN } });
  const code = await run([...staff, '--only', 'organization-list'], h.deps);
  assert.strictEqual(code, 0);
  assert.match(h.out[0], /match=1 .*fieldDiff=0 unexplained=0/);
  const asked = eagleCall(h, '/organization').url.searchParams.get('fields').split('|');
  assert.deepStrictEqual(asked.filter(f => ['dateAdded', 'dateUpdated'].includes(f)), []);
});

test('the comment period route does not compare commentIdCount, which Eagle never answers', async () => {
  const period = { _id: B, project: A, dateStarted: '2026-08-26T07:00:00.000Z', instructions: 'x' };
  const h = harness(restSides({ [`/commentperiod/${B}`]: [period] }, searchBody([{ ...period, commentIdCount: 7 }])),
    { env: { PARITY_TOKEN: TOKEN } });
  const code = await run([...staff, '--only', 'commentperiod', '--id', `period=${B}`], h.deps);
  assert.strictEqual(code, 0);
  assert.match(h.out[0], /match=1 .*fieldDiff=0 unexplained=0/);
  assert.ok(!eagleCall(h, `/commentperiod/${B}`).url.searchParams.get('fields').split('|').includes('commentIdCount'));
});

const staffSearch = async (dataset, eagleRow, demiRow) => {
  const h = harness(searchSides({ eagle: [eagleRow], demi: [demiRow] }), { env: { PARITY_TOKEN: TOKEN } });
  const code = await run([...staff, '--only', `search-${dataset}`], h.deps);
  return { code, line: h.out[0] };
};

test('a project flag false in DEMI and absent in Eagle is counted as schema-default-false', async () => {
  const { code, line } = await staffSearch('Project', project(A), project(A, { substantially: false, hasMetCommentPeriods: false }));
  assert.strictEqual(code, 0);
  assert.match(line, /fieldDiff=2 unexplained=0 known=schema-default-false:2/);
});

test('a project flag true in DEMI and absent in Eagle is unexplained', async () => {
  const { code, line } = await staffSearch('Project', project(A), project(A, { substantially: true }));
  assert.strictEqual(code, 1);
  assert.match(line, /fieldDiff=1 unexplained=1/);
});

test("a comment period isVetted false in Eagle and '' in DEMI is counted as schema-default-false", async () => {
  const period = extra => ({ _id: B, dateStarted: '2026-08-26T07:00:00.000Z', ...extra });
  const { code, line } = await staffSearch('CommentPeriod', period({ isVetted: false }), period({ isVetted: '' }));
  assert.strictEqual(code, 0);
  assert.match(line, /fieldDiff=1 unexplained=0 known=schema-default-false:1/);
});

test("a blank Eagle Project column in the comment export against DEMI's merged name is track-mastered", async () => {
  const columns = ['Comment_No', 'Project', 'Comment'];
  const { code, line } = await exportRun(csvSides([[1, '', 'ok'], [2, 'Mine', 'ok']], [[1, 'Mine', 'ok'], [2, 'Mine', 'ok']], columns));
  assert.strictEqual(code, 0);
  assert.match(line, /match=1 .*fieldDiff=1 unexplained=0 known=track-mastered:1/);
});

test("a comment period isVetted 'false' in DEMI against false in Eagle matches; 'false' against true differs", async () => {
  const period = extra => ({ _id: B, dateStarted: '2026-08-26T07:00:00.000Z', ...extra });
  const equal = await staffSearch('CommentPeriod', period({ isVetted: false }), period({ isVetted: 'false' }));
  assert.match(equal.line, /match=1 .*fieldDiff=0 unexplained=0/);
  const differ = await staffSearch('CommentPeriod', period({ isVetted: true }), period({ isVetted: 'false' }));
  assert.match(differ.line, /fieldDiff=1 unexplained=1/);
});

test('a comment period commentIdCount null in Eagle and 0 in DEMI matches; 3 against 0 differs', async () => {
  const period = extra => ({ _id: B, dateStarted: '2026-08-26T07:00:00.000Z', ...extra });
  const equal = await staffSearch('CommentPeriod', period({ commentIdCount: null }), period({ commentIdCount: 0 }));
  assert.match(equal.line, /match=1 .*fieldDiff=0 unexplained=0/);
  const differ = await staffSearch('CommentPeriod', period({ commentIdCount: 3 }), period({ commentIdCount: 0 }));
  assert.match(differ.line, /fieldDiff=1 unexplained=1/);
});

test("a comment period userCan, which Eagle computes per caller, is not compared", async () => {
  const period = extra => ({ _id: B, dateStarted: '2026-08-26T07:00:00.000Z', ...extra });
  const { code, line } = await staffSearch('CommentPeriod', period({ userCan: { addComment: true } }), period({ userCan: '' }));
  assert.strictEqual(code, 0);
  assert.match(line, /match=1 .*fieldDiff=0 unexplained=0/);
});

const doc = extra => ({ _id: B, documentFileName: 'report.pdf', datePosted: '2026-08-26T07:00:00.000Z', ...extra });

test("an empty Eagle displayName against DEMI's documentFileName fallback is display-name-from-file-name", async () => {
  const { code, line } = await staffSearch('Document', doc({ displayName: '' }), doc({ displayName: 'report.pdf' }));
  assert.strictEqual(code, 0);
  assert.match(line, /fieldDiff=1 unexplained=0 known=display-name-from-file-name:1/);
});

test('a DEMI displayName that is not the file name, or an Eagle displayName that is set, is unexplained', async () => {
  const other = await staffSearch('Document', doc({ displayName: '' }), doc({ displayName: 'Annual report' }));
  assert.match(other.line, /fieldDiff=1 unexplained=1/);
  const set = await staffSearch('Document', doc({ displayName: 'Annual report' }), doc({ displayName: 'report.pdf' }));
  assert.match(set.line, /fieldDiff=1 unexplained=1/);
});

/**
 * Staff `search-CommentPeriod` with one period, under HIDDEN, only Eagle holds. Eagle's `/project`
 * lists `eagleProjects`; DEMI's project search answers `demiProjects`.
 */
const orphanRun = async ({ eagleProjects = [], eagleTotal = eagleProjects.length, demiProjects = [], args = [] } = {}) => {
  const period = { _id: B, project: HIDDEN, dateStarted: '2026-08-26T07:00:00.000Z', instructions: 'x' };
  const h = harness((host, url) => {
    const dataset = url.searchParams.get('dataset');
    if (host === 'demi.test') return json(searchBody(dataset === 'Project' ? demiProjects : []));
    if (url.pathname === '/api/project') return json(facet(eagleProjects.map(id => ({ _id: id })), eagleTotal));
    return json(dataset === 'CommentPeriod' ? searchBody([period]) : []);
  }, { env: { PARITY_TOKEN: TOKEN } });
  const code = await run([...staff, '--only', 'search-CommentPeriod', ...args], h.deps);
  return { code, line: h.out.find(l => /search-CommentPeriod identity/.test(l)) };
};

test('a missing comment period whose project neither Eagle nor DEMI lists is an orphan', async () => {
  const { code, line } = await orphanRun({ eagleProjects: [SHOWN], demiProjects: [{ id: '297', eagleId: SHOWN }] });
  assert.strictEqual(code, 0);
  assert.match(line, /missingInDemi=1 .*unexplained=0 known=orphan-parent-missing-in-eagle:1/);
});

test('a missing comment period whose project Eagle or DEMI lists is unexplained, not an orphan', async () => {
  for (const sides of [{ eagleProjects: [HIDDEN] }, { demiProjects: [{ id: '297', eagleId: HIDDEN }] }]) {
    const { code, line } = await orphanRun(sides);
    assert.strictEqual(code, 1);
    assert.match(line, /missingInDemi=1 .*unexplained=1/);
    assert.doesNotMatch(line, /orphan|push-missed/);
  }
});

test('a --max-pages cut of the parent project lists leaves a missing comment period unexplained', async () => {
  const fullPage = Array.from({ length: 100 }, (_, i) => (i + 1).toString(16).padStart(24, '6'));
  const { code, line } = await orphanRun({ eagleProjects: fullPage, eagleTotal: 200, args: ['--max-pages', '1'] });
  assert.strictEqual(code, 1);
  assert.match(line, /missingInDemi=1 .*unexplained=1/);
});

const [C, SEALED_ONLY] = ['6'.repeat(24), '7'.repeat(24)];

const knownRun = async (identity, known, extraArgs = []) => {
  const h = harness(searchSides({ eagle: [project(A)], demi: [project(A), project(B)] }),
    { env: { PARITY_TOKEN: TOKEN }, files: { 'known.json': JSON.stringify(known), 'more.json': '{}' } });
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, '--identity', identity, '--token-env', 'PARITY_TOKEN',
    '--only', 'search-Project', '--known-ids', 'known.json', ...extraArgs], h.deps);
  return { code, line: h.out[0], written: h.written };
};

test('an extra DEMI row listed as seeded-from-prod is counted under it', async () => {
  const { code, line } = await knownRun('staff', { 'seeded-from-prod': [B] });
  assert.strictEqual(code, 0);
  assert.match(line, /extraInDemi=1 .*unexplained=0 known=seeded-from-prod:1/);
});

test('eagle-staff-widened, dropped with the rule, is no longer a --known-ids class', async () => {
  const { code, line } = await knownRun('staff', { 'eagle-staff-widened': [B] });
  assert.strictEqual(code, 1);
  assert.match(line, /--known-ids: eagle-staff-widened is not one of/);
});

test('--known-ids may repeat, and lists of one class from several files merge', async () => {
  const h = harness(searchSides({ eagle: [project(A)], demi: [project(A), project(B), project(C)] }), {
    env: { PARITY_TOKEN: TOKEN },
    files: {
      'a.json': JSON.stringify({ 'seeded-from-prod': [B] }),
      'b.json': JSON.stringify({ 'seeded-from-prod': [C], extraInDemi: { 'search-Project': [B, C] } })
    }
  });
  const code = await run([...staff, '--only', 'search-Project', '--known-ids', 'a.json', '--known-ids', 'b.json'], h.deps);
  assert.strictEqual(code, 0);
  assert.match(h.out[0], /extraInDemi=2 .*unexplained=0 known=seeded-from-prod:2/);
});

test('a --known-ids class that does not exist is refused', async () => {
  const { code, line } = await knownRun('staff', { 'seeded-from-pord': [B] });
  assert.strictEqual(code, 1);
  assert.match(line, /--known-ids: seeded-from-pord is not one of/);
});

test('an id listed under the new id classes never explains a row missing in DEMI', () => {
  const knownIds = { 'seeded-from-prod': new Set([A]), 'ladder-above-public': new Set([A]) };
  assert.strictEqual(classify(idCtx({ kind: 'missingInDemi', identity: 'staff', knownIds })), null);
  assert.strictEqual(classify(idCtx({ kind: 'missingInDemi', identity: 'staff', knownIds, parentState: null })), 'push-missed');
});

const emitRun = async (identity) => {
  const eagle = [
    project(A, { read: ['public'] }),
    project(B, { read: ['sysadmin'] }),
    project(C, { read: ['staff', 'sysadmin'] }),
    project('9'.repeat(24), { read: ['team', 'sysadmin'] }),
    project(SEALED_ONLY, { read: ['compliance'] })
  ];
  const h = harness(searchSides({ eagle, demi: [...eagle, project('8'.repeat(24))] }), { env: { PARITY_TOKEN: TOKEN } });
  await run(['--eagle', EAGLE, '--demi', DEMI, '--identity', identity, '--token-env', 'PARITY_TOKEN',
    '--only', 'search-Project', '--emit-ids', 'ids.json'], h.deps);
  return h.written[0];
};

test('a sysadmin --emit-ids run lists ladder-above-public ids and extra DEMI ids per read, no widened class', async () => {
  const emitted = JSON.parse(await emitRun('sysadmin'));
  assert.deepStrictEqual(Object.keys(emitted).sort(), ['capped-under-parent', 'extraInDemi', 'ladder-above-public']);
  assert.deepStrictEqual(emitted['ladder-above-public'], [A]);
  assert.deepStrictEqual(emitted.extraInDemi, { 'search-Project': ['8'.repeat(24)] });
});

test('a sysadmin --emit-ids run lists the children of a public-only project under ladder-above-public', async () => {
  const period = (id, projectId, read) => ({ _id: id, project: projectId, read, dateStarted: '2026-08-26T07:00:00.000Z' });
  const rows = {
    Project: [project(A, { read: ['public', 'sysadmin'] }), project(B, { read: ['public', 'staff'] })],
    CommentPeriod: [period(C, A, ['staff', 'sysadmin']), period(SEALED_ONLY, B, ['staff', 'sysadmin'])]
  };
  const h = harness((host, url) => json(searchBody(rows[url.searchParams.get('dataset')] || [])),
    { env: { PARITY_TOKEN: TOKEN } });
  const map = PARITY_MAP.filter(e => ['search-Project', 'search-CommentPeriod'].includes(e.read));
  await run(['--eagle', EAGLE, '--demi', DEMI, '--identity', 'sysadmin', '--token-env', 'PARITY_TOKEN',
    '--emit-ids', 'ids.json'], { ...h.deps, map });
  assert.deepStrictEqual(JSON.parse(h.written[0])['ladder-above-public'], [A, C].sort());
});

test('a sysadmin --emit-ids run lists inspection items by their element read[]', async () => {
  const ITEM = '8'.repeat(24);
  const h = harness((host) => json(host === 'eagle.test'
    ? [{ _id: ELEMENT, read: ['sysadmin', 'public'], items: [ITEM] }]
    : [{ id: ITEM }]), { env: { PARITY_TOKEN: TOKEN } });
  await run(['--eagle', EAGLE, '--demi', DEMI, '--identity', 'sysadmin', '--token-env', 'PARITY_TOKEN',
    '--id', `inspection=${INSPECTION}`, '--id', `element=${ELEMENT}`, '--only', 'inspection-item',
    '--emit-ids', 'ids.json'], h.deps);
  assert.deepStrictEqual(JSON.parse(h.written[0])['ladder-above-public'], [ITEM]);
});

test('ladder-above-public explains an extra DEMI row for staff only, never a missing one', () => {
  const knownIds = { 'ladder-above-public': new Set([A]) };
  const extra = { kind: 'extraInDemi', demi: { id: A }, byEagleId: true, knownIds };
  assert.strictEqual(classify(idCtx({ ...extra, identity: 'staff' })), 'ladder-above-public');
  assert.strictEqual(classify(idCtx({ ...extra, identity: 'sysadmin' })), null);
  assert.strictEqual(classify(idCtx({ kind: 'missingInDemi', identity: 'staff', knownIds })), null);
});

// Test groups 5d6ff652... and 5ea73b4b... under project 58990017..., whose read[] has no ladder token.
const CAPPED_PROJECT = '58990017d334ee001d608bbd';
const STAFF_PROJECT = '58990017d334ee001d608bbe';
const CAPPED_GROUPS = ['5d6ff652fa1745001ad60725', '5ea73b4be97c750024d04907'];
const STAFF_GROUP = '5ea73b4be97c750024d04908';
const group = (id, projectId) => ({ _id: id, project: projectId, name: 'Working group', read: ['project-system-admin', 'sysadmin', 'staff'] });
const groupRows = {
  Project: [project(CAPPED_PROJECT, { read: ['project-system-admin', 'sysadmin'] }),
    project(STAFF_PROJECT, { read: ['staff', 'sysadmin'] })],
  Group: [...CAPPED_GROUPS.map(id => group(id, CAPPED_PROJECT)), group(STAFF_GROUP, STAFF_PROJECT)]
};
const groupEmit = async (rows = groupRows, reads = ['search-Project', 'search-Group']) => {
  const h = harness((host, url) => json(searchBody(rows[url.searchParams.get('dataset')] || [])),
    { env: { PARITY_TOKEN: TOKEN } });
  const map = PARITY_MAP.filter(e => reads.includes(e.read));
  await run(['--eagle', EAGLE, '--demi', DEMI, '--identity', 'sysadmin', '--token-env', 'PARITY_TOKEN',
    '--emit-ids', 'ids.json'], { ...h.deps, map });
  return h.written[0];
};
// DEMI holds none of the groups, as a staff caller sees it.
const missingGroupsRun = async (identity, emitted) => {
  const h = harness(searchSides({ eagle: groupRows.Group, demi: [] }),
    { env: { PARITY_TOKEN: TOKEN }, files: { 'ids.json': emitted } });
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, '--identity', identity, '--token-env', 'PARITY_TOKEN',
    '--only', 'search-Group', '--known-ids', 'ids.json'], h.deps);
  return { code, line: h.out[0] };
};

test('a sysadmin --emit-ids run lists a staff group under a project with no ladder token as capped-under-parent', async () => {
  const emitted = JSON.parse(await groupEmit());
  assert.deepStrictEqual(emitted['capped-under-parent'], CAPPED_GROUPS);
  assert.deepStrictEqual(emitted['ladder-above-public'], []);
});

test('a sysadmin --emit-ids run that did not read the projects lists no group as capped-under-parent', async () => {
  const emitted = JSON.parse(await groupEmit(groupRows, ['search-Group']));
  assert.deepStrictEqual(emitted['capped-under-parent'], []);
});

test('a group under a public-only project stays out of ladder-above-public: only periods and documents follow their project', async () => {
  const rows = { Project: [project(CAPPED_PROJECT, { read: ['public', 'sysadmin'] })], Group: [group(STAFF_GROUP, CAPPED_PROJECT)] };
  const emitted = JSON.parse(await groupEmit(rows));
  assert.deepStrictEqual(emitted['ladder-above-public'], [CAPPED_PROJECT]);
});

test('a staff run counts the capped groups under capped-under-parent; a group under a staff project stays unexplained', async () => {
  const { code, line } = await missingGroupsRun('staff', await groupEmit());
  assert.strictEqual(code, 1);
  assert.match(line, /missingInDemi=3 .*unexplained=1 known=capped-under-parent:2/);
});

test('capped-under-parent never explains a missing row for a privileged identity', async () => {
  const { code, line } = await missingGroupsRun('sysadmin', await groupEmit());
  assert.strictEqual(code, 1);
  assert.match(line, /missingInDemi=3 .*unexplained=3$/);
  const knownIds = { 'capped-under-parent': new Set([A]) };
  assert.strictEqual(classify(idCtx({ kind: 'missingInDemi', identity: 'sysadmin', knownIds })), null);
  assert.strictEqual(classify(idCtx({ kind: 'missingInDemi', identity: 'staff', knownIds })), 'capped-under-parent');
});

test('--emit-ids writes ids only, never field values', async () => {
  const text = await emitRun('sysadmin');
  assert.ok(!/Mine|Hudson Hope|Peace/.test(text), text);
});

test('a staff --emit-ids run lists no ladder ids: staff cannot see the rows that tell them apart', async () => {
  const emitted = JSON.parse(await emitRun('staff'));
  assert.ok(!('ladder-above-public' in emitted));
  assert.deepStrictEqual(Object.keys(emitted.extraInDemi), ['search-Project']);
});

test('an --emit-ids file is accepted as a --known-ids file', async () => {
  const emitted = await emitRun('sysadmin');
  const h = harness(searchSides({ eagle: [project(C)], demi: [project(C), project(A)] }),
    { env: { PARITY_TOKEN: TOKEN }, files: { 'ids.json': emitted } });
  const code = await run([...staff, '--only', 'search-Project', '--known-ids', 'ids.json'], h.deps);
  assert.strictEqual(code, 0);
  assert.match(h.out[0], /known=ladder-above-public:1/);
});
