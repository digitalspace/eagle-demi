'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { run, parseCsv, MIN_GAP_MS } = require('../../src/scripts/parity-eagle');
const { PARITY_MAP } = require('../../src/scripts/parity-map');
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

test('a staff row with no ladder token is counted under L1 and exits 0', async () => {
  const h = harness(searchSides({
    eagle: [project(A), project(B, { read: ['sysadmin'] })],
    demi: [project(A)]
  }), { env: { PARITY_TOKEN: TOKEN } });
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, '--identity', 'staff', '--token-env', 'PARITY_TOKEN',
    '--only', 'search-Project'], h.deps);
  assert.strictEqual(code, 0);
  assert.match(h.out[0], /missingInDemi=1 .*unexplained=0 known=L1-no-ladder-token:1/);
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

test('a download with the same bytes on both sides matches, and the store gets no token', async () => {
  const h = harness(downloads(), { env: { PARITY_TOKEN: TOKEN } });
  const code = await run([...staff, '--only', 'document-download', '--id', `document=${A}`, '--download-sample', '1'], h.deps);
  assert.strictEqual(code, 0);
  assert.match(h.out[0], /document-download identity=staff match=1 .*fieldDiff=0 unexplained=0/);
  const store = h.calls.filter(c => c.host === 'store.test');
  assert.strictEqual(store.length, 1);
  assert.strictEqual(store[0].headers.authorization, undefined);
});

test('a download whose bytes differ is unexplained and exits 1', async () => {
  const h = harness(downloads({ storeBytes: 'pdf-bytez' }), { env: { PARITY_TOKEN: TOKEN } });
  const code = await run([...staff, '--only', 'document-download', '--id', `document=${A}`, '--download-sample', '1'], h.deps);
  assert.strictEqual(code, 1);
  assert.match(h.out[0], /match=0 .*fieldDiff=1 unexplained=1/);
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

test('a BCGW project link that differs only by host is counted as a known difference', async () => {
  const columns = ['Project name', 'URL to Epic Project', 'Project GUID'];
  const row = host => ['Mine', `https://${host}/p/${A}/project-details`, `"${A}"`];
  const h = harness(csvSides([row('projects.eao.gov.bc.ca')], [row('eagle-test.example')], columns));
  const code = await run(['--eagle', EAGLE, '--demi', DEMI, '--only', 'report-bcgw'], h.deps);
  assert.strictEqual(code, 0);
  assert.match(h.out[0],
    /report-bcgw identity=anonymous match=0 missingInDemi=0 extraInDemi=0 fieldDiff=1 unexplained=0 known=bcgw-link-host:1/);
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
    `demi.test/api/groups/${GROUP}?project=${A}`
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
