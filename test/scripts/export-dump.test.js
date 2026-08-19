'use strict';

/**
 * `--dump` on the chunk export: the backup path.
 *
 * This corpus is the only extracted copy of the text and its Cosmos account carries an 8-hour
 * Periodic backup, so the thing being tested is the one that makes a second copy exist. Cosmos is
 * stubbed by a preload — see test/helpers/stub-cosmos.js — so no test can reach the real account.
 */

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'src', 'scripts', 'export-chunks-to-eagle.js');
const STUB = path.join(ROOT, 'test', 'helpers', 'stub-cosmos.js');

function run(args) {
  return execFileSync(process.execPath, ['-r', STUB, SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function tmpfile(name) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'demi-dump-')), name);
  return f;
}

test('--dump writes every chunk read as JSONL, without --target or --key', () => {
  const out = tmpfile('corpus.jsonl');
  run(['--dump', out]);

  const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 4, 'all four stubbed chunks should be dumped');

  const first = JSON.parse(lines[0]);
  assert.strictEqual(first.documentId, 'doc1');
  assert.strictEqual(first.content, 'first chunk');
  // The dump is a copy of the SOURCE row, so it keeps the field names Cosmos returned rather than
  // the reshaped `id`/`pageNumber` payload that goes to eagle-search.
  assert.ok(!('id' in first), 'dump should carry source rows, not the ingest payload shape');
  assert.strictEqual(JSON.parse(lines[3]).content, 'fourth chunk');
});

test('--dump honours --limit', () => {
  const out = tmpfile('limited.jsonl');
  run(['--dump', out, '--limit', '3']);
  assert.strictEqual(fs.readFileSync(out, 'utf8').trim().split('\n').length, 3);
});

test('--dump appends rather than truncating, so a resumed run keeps the earlier copy', () => {
  const out = tmpfile('appended.jsonl');
  run(['--dump', out, '--limit', '2']);
  run(['--dump', out, '--limit', '2']);
  assert.strictEqual(fs.readFileSync(out, 'utf8').trim().split('\n').length, 4);
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
