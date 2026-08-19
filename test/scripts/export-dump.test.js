'use strict';

/**
 * `--dump` on the chunk export: the backup path.
 *
 * This corpus is the only extracted copy of the text and its Cosmos account carries an 8-hour
 * Periodic backup, so the thing under test is the one that makes a second copy exist. Cosmos is
 * stubbed by a preload — see test/helpers/stub-cosmos.js — so no test can reach the real account.
 *
 * The load-bearing assertion is that the dump carries `read[]` and `projectId`. Without them a
 * restore throws on the first batch (`repositories/chunks.js` assertAcl) or lands chunks no scoped
 * query can see, and the file would be a copy of the text rather than of the corpus.
 */

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'src', 'scripts', 'export-chunks-to-eagle.js');
const STUB = path.join(ROOT, 'test', 'helpers', 'stub-cosmos.js');

function run(args, cwd = ROOT) {
  return execFileSync(process.execPath, ['-r', STUB, SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// The --live test serves HTTP from THIS process, and execFileSync would block the event loop for the
// whole child run — the server could never accept the connection and the push would time out. Any
// test that needs the parent to stay responsive uses this instead.
const execFileAsync = promisify(execFile);
function runAsync(args) {
  return execFileAsync(process.execPath, ['-r', STUB, SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function tmpfile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'demi-dump-')), name);
}

function lines(f) {
  return fs.readFileSync(f, 'utf8').trim().split('\n');
}

test('--dump takes the WHOLE row, so the file is restorable', () => {
  const out = tmpfile('corpus.jsonl');
  run(['--dump', out]);

  const rows = lines(out).map(JSON.parse);
  assert.strictEqual(rows.length, 4, 'all four stubbed chunks should be dumped');

  // The two fields the push projection drops and a restore cannot do without.
  assert.deepStrictEqual(rows[0].read, ['public'], 'read[] must survive — assertAcl rejects a chunk without it');
  assert.strictEqual(rows[0].projectId, 'proj-7', 'projectId is SCOPE_FIELD; without it a restored chunk is invisible to scoped queries');
  assert.deepStrictEqual(rows[2].read, ['eao', 'admin'], 'a non-public ACL must round-trip unmodified');

  assert.strictEqual(rows[0].id, 'doc1::p1::c0', 'the source id is kept rather than re-derived');
  assert.strictEqual(rows[0].content, 'first chunk');
  assert.strictEqual(rows[3].content, 'fourth chunk');
});

test('--dump honours --limit', () => {
  const out = tmpfile('limited.jsonl');
  run(['--dump', out, '--limit', '3']);
  assert.strictEqual(lines(out).length, 3);
});

test('--dump appends rather than truncating, so a resumed run keeps the earlier copy', () => {
  const out = tmpfile('appended.jsonl');
  run(['--dump', out, '--limit', '2']);
  run(['--dump', out, '--limit', '2']);
  assert.strictEqual(lines(out).length, 4);
});

test('--dump and --live together: the backup is taken AND the push happens', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ path: req.url, key: req.headers['x-ingest-key'], rows: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ written: JSON.parse(body).length, orphans: 0, failed: 0 }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const target = `http://127.0.0.1:${server.address().port}`;

  const out = tmpfile('both.jsonl');
  try {
    await runAsync(['--dump', out, '--target', target, '--key', 'test-key', '--live']);
  } finally {
    await new Promise((r) => server.close(r));
  }

  assert.strictEqual(lines(out).length, 4, 'every row still reaches the dump when pushing');
  assert.strictEqual(received.length, 2, 'both pages should have been pushed');
  assert.strictEqual(received[0].path, '/ingest/eagle-chunks');
  assert.strictEqual(received[0].key, 'test-key');

  // The push payload is picked explicitly, so widening the dump query must not widen what is sent.
  const pushed = received[0].rows[0];
  assert.deepStrictEqual(
    Object.keys(pushed).sort(),
    ['chunkIndex', 'content', 'documentId', 'id', 'pageNumber'],
    'SELECT * must not leak read[]/projectId/system properties into the ingest body'
  );
  assert.strictEqual(pushed.id, 'doc1_p1_c0', 'the ingest id is the eagle-search key, not the Cosmos one');
});

test('a run with neither --dump nor a target is refused', () => {
  assert.throws(
    () => run([]),
    (e) => /--target and --key are required/.test(String(e.stderr)),
    'without a destination and without --dump there is nothing the run could do'
  );
});

test('--live still demands a destination', () => {
  const out = tmpfile('live.jsonl');
  assert.throws(
    () => run(['--dump', out, '--live']),
    (e) => /--live needs --target and --key/.test(String(e.stderr)),
    '--dump must not make --live silently push nowhere'
  );
});

test('an option that swallows the next flag is rejected, not obeyed', () => {
  // `--dump --limit 3` previously created a file literally named `--limit`. Run in a scratch cwd:
  // if this ever regresses, the stray file lands there rather than in the repo, where it would
  // otherwise sit and fail this same assertion on every later run.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-argv-'));
  assert.throws(
    () => run(['--dump', '--limit', '3'], scratch),
    (e) => /--dump needs a value/.test(String(e.stderr)),
    'a flag-shaped value must not be taken as a filename'
  );
  assert.deepStrictEqual(fs.readdirSync(scratch), [], 'no file named after the swallowed flag');
});

test('a trailing option with no value is rejected', () => {
  // The dangerous shape: on a --live run this silently pushed and took no backup at all.
  assert.throws(
    () => run(['--target', 'http://x', '--key', 'k', '--live', '--dump']),
    (e) => /--dump needs a value, got nothing/.test(String(e.stderr))
  );
});

test('--count with --dump is refused rather than writing an empty file', () => {
  const out = tmpfile('count.jsonl');
  assert.throws(
    () => run(['--count', '--dump', out]),
    (e) => /--count and --dump do nothing together/.test(String(e.stderr)),
    'an empty file an operator believes is a backup is worse than an error'
  );
  assert.ok(!fs.existsSync(out), 'nothing should be created');
});
