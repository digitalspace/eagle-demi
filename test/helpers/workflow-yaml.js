'use strict';

// Reads GitHub workflow files by indentation (no YAML dependency in this repo) and runs step
// scripts against a fake `az`.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const indentOf = (line) => line.search(/\S/);

const readWorkflow = (name) => fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', name), 'utf8').split('\n');

// The lines under `<key>:` at `indent`, up to the next line at that indent or shallower.
function block(lines, indent, key) {
  const start = lines.findIndex((l) => l === `${' '.repeat(indent)}${key}:`);
  assert.notStrictEqual(start, -1, `no "${key}:" at indent ${indent}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.trim() !== '' && indentOf(l) <= indent);
  return end === -1 ? rest : rest.slice(0, end);
}

// `key: value` scalars at exactly `indent`.
function scalars(lines, indent) {
  const prefix = ' '.repeat(indent);
  return Object.fromEntries(lines
    .filter((l) => l.startsWith(prefix) && indentOf(l) === indent && /^\S[^:]*: /.test(l.slice(indent)))
    .map((l) => {
      const at = l.indexOf(': ');
      return [l.slice(indent, at), l.slice(at + 2)];
    }));
}

const job = (lines, name) => block(block(lines, 0, 'jobs'), 2, name);

// Each `- ` item under a job's `steps:`, re-indented so its keys sit at 8 like the others.
function steps(jobLines) {
  const body = block(jobLines, 4, 'steps');
  const starts = body.map((l, i) => (l.startsWith('      - ') ? i : -1)).filter((i) => i !== -1);
  return starts.map((s, n) => {
    const chunk = body.slice(s, starts[n + 1]);
    return [`        ${chunk[0].slice(8)}`, ...chunk.slice(1)];
  });
}

const stepIndex = (jobLines, name) => steps(jobLines).findIndex((s) => scalars(s, 8).name === name);

function step(jobLines, name) {
  const found = steps(jobLines)[stepIndex(jobLines, name)];
  assert.ok(found, `no step named "${name}"`);
  return found;
}

function runScript(stepLines) {
  const at = stepLines.findIndex((l) => l === '        run: |');
  assert.notStrictEqual(at, -1, 'step has no block run:');
  const body = stepLines.slice(at + 1);
  // Stop before the next step's leading comments, which `steps()` leaves on this chunk.
  const end = body.findIndex((l) => l.trim() !== '' && indentOf(l) < 10);
  return (end === -1 ? body : body.slice(0, end)).map((l) => l.slice(10)).join('\n');
}

const withTmp = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * Run `script` in a temp dir holding the repo's scripts/, `files` (paths created empty) and a fake
 * `az` that prints `azOut`, or fails with `azErr` on stderr.
 */
function runWithFakeAz(script, { env = {}, files = [], azOut = '', azErr = null } = {}) {
  return withTmp((dir) => {
    fs.symlinkSync(path.join(REPO_ROOT, 'scripts'), path.join(dir, 'scripts'));
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), '');
    }
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'az'), azErr === null
      ? `#!/usr/bin/env bash\necho '${azOut}'\n`
      : `#!/usr/bin/env bash\necho '${azErr}' >&2\nexit 1\n`, { mode: 0o755 });
    const summary = path.join(dir, 'summary.md');
    const output = path.join(dir, 'output');
    fs.writeFileSync(output, '');
    const run = spawnSync('bash', ['-e', '-c', script], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output, ...env },
    });
    return {
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      found: fs.readFileSync(output, 'utf8').trim(),
      summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '',
    };
  });
}

module.exports = { REPO_ROOT, indentOf, readWorkflow, block, scalars, job, steps, stepIndex, step, runScript, withTmp, runWithFakeAz };
