'use strict';

/**
 * The break-glass `skip_schema_probe` input on the prod deploy.
 *
 * It exists for one deadlock: the app serving production answers the probe with a 500, and the
 * release that fixes it cannot pass the gate. What has to hold is narrow: unticked, both gates run
 * as before; ticked, neither runs, the run and the release name who skipped them, and the job still
 * succeeds so the deploy jobs that need it are not skipped along with it.
 *
 * No YAML dependency in this repo, so the file is read by indentation, which is all GitHub's own
 * layout here needs.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WORKFLOW = path.join(__dirname, '..', '..', '.github', 'workflows', 'azure-deploy-prod.yaml');
const TEXT = fs.readFileSync(WORKFLOW, 'utf8');
const LINES = TEXT.split('\n');

const indentOf = (line) => line.search(/\S/);

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

function input(name) {
  const inputs = block(block(block(LINES, 0, 'on'), 2, 'workflow_dispatch'), 4, 'inputs');
  return scalars(block(inputs, 6, name), 8);
}

const job = (name) => block(block(LINES, 0, 'jobs'), 2, name);
const VERIFY_JOB = job('verify-search-schema');
const PUBLISH_JOB = job('publish-release');

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

// Just enough of GitHub's expression language for these steps: `inputs.x`, `!inputs.x`, and
// `needs.<job>.outputs.<key> == '<value>'`, bare or inside `${{ }}`. Anything else throws, so a
// rewrite fails here instead of passing blind.
function runs(stepLines, ctx) {
  const cond = scalars(stepLines, 8).if;
  if (cond === undefined) return true;
  const expr = cond.trim().replace(/^\$\{\{\s*(.*?)\s*\}\}$/, '$1');
  const input = /^(!?)inputs\.([a-z_]+)$/.exec(expr);
  const need = /^needs\.([a-z-]+)\.outputs\.([a-z_]+) == '([^']*)'$/.exec(expr);
  assert.ok(input || need, `unsupported if: ${cond}`);
  if (need) return (ctx.needs?.[need[1]]?.[need[2]] ?? '') === need[3];
  return input[1] === '!' ? !ctx.inputs[input[2]] : Boolean(ctx.inputs[input[2]]);
}

function runScript(stepLines) {
  const at = stepLines.findIndex((l) => l === '        run: |');
  assert.notStrictEqual(at, -1, 'step has no block run:');
  return stepLines.slice(at + 1).map((l) => l.slice(10)).join('\n');
}

function bash(script, env) {
  return spawnSync('bash', ['-e', '-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
}

// `key=value` lines as GitHub reads $GITHUB_OUTPUT (single-line values only).
const parseOutputs = (text) => Object.fromEntries(text.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

// Runs the Record step as a re-run would: `actor` dispatched, `rerunner` pressed re-run.
function record(dir) {
  const summary = path.join(dir, 'summary.md');
  const output = path.join(dir, 'output');
  const run = bash(runScript(step(VERIFY_JOB, RECORD)), {
    ACTOR: 'octo-dispatcher',
    TRIGGERING_ACTOR: 'octo-rerunner',
    INPUT_VERSION: 'v0.114.3',
    GITHUB_STEP_SUMMARY: summary,
    GITHUB_OUTPUT: output,
  });
  assert.strictEqual(run.status, 0, run.stderr);
  return {
    stdout: run.stdout.trim(),
    summary: fs.readFileSync(summary, 'utf8').trim(),
    outputs: parseOutputs(fs.readFileSync(output, 'utf8')),
  };
}

const withTmp = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skip-probe-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const VALIDATE = 'Validate version format';
const SCHEMA = "Probe the live indexes with this tag's index definitions";
const DATA = 'Check the values in the live indexes';
const RECORD = 'Record the skipped search gates';
const RELEASE_NOTE = 'Name the skipped search gates in the release notes';

test('skip_schema_probe is a boolean input that defaults to false', () => {
  const declared = input('skip_schema_probe');
  assert.strictEqual(declared.type, 'boolean');
  assert.strictEqual(declared.default, 'false');
  assert.strictEqual(declared.required, 'false');
});

test('skip_schema_probe is for a 500 only, behind main holding the tag and a clean drift check', () => {
  const { description } = input('skip_schema_probe');
  assert.match(description, /Break-glass only/);
  assert.match(description, /500 \(not 503, not 404\)/);
  assert.doesNotMatch(description, /5xx/);
  assert.match(description, /main contains this tag/);
  assert.match(description, /scripts\/demi-devbox\.sh drift --env <env> exits 0/);
});

test('unticked, both search gates run and nothing records a skip', () => {
  const ctx = { inputs: { skip_schema_probe: false } };
  assert.strictEqual(runs(step(VERIFY_JOB, SCHEMA), ctx), true);
  assert.strictEqual(runs(step(VERIFY_JOB, DATA), ctx), true);
  assert.strictEqual(runs(step(VERIFY_JOB, RECORD), ctx), false);
});

test('ticked, neither search gate runs and the skip is recorded', () => {
  const ctx = { inputs: { skip_schema_probe: true } };
  assert.strictEqual(runs(step(VERIFY_JOB, SCHEMA), ctx), false);
  assert.strictEqual(runs(step(VERIFY_JOB, DATA), ctx), false);
  assert.strictEqual(runs(step(VERIFY_JOB, RECORD), ctx), true);
});

test('the skip is recorded only after the version has been validated', () => {
  assert.ok(stepIndex(VERIFY_JOB, VALIDATE) >= 0);
  assert.ok(stepIndex(VERIFY_JOB, RECORD) > stepIndex(VERIFY_JOB, VALIDATE));
});

test('the verify job itself has no condition, so the deploy jobs that need it still run', () => {
  assert.strictEqual(scalars(VERIFY_JOB, 4).if, undefined);
});

test('the input is read only by the verify job', () => {
  const inVerify = VERIFY_JOB.join('\n').match(/inputs\.skip_schema_probe/g) || [];
  const inFile = TEXT.match(/inputs\.skip_schema_probe/g) || [];
  assert.ok(inVerify.length > 0);
  assert.strictEqual(inFile.length, inVerify.length);
  assert.doesNotMatch(job('deploy-extractor').join('\n'), /skip_schema_probe/);
  assert.doesNotMatch(job('deploy-api').join('\n'), /skip_schema_probe/);
  assert.doesNotMatch(job('rollback').join('\n'), /skip_schema_probe/);
  assert.doesNotMatch(PUBLISH_JOB.join('\n'), /skip_schema_probe/);
  assert.deepStrictEqual(LINES.filter((l) => /environment:/.test(l) && /skip/.test(l)), []);
});

test('allow_missing_schema_probe still drives both gates, independent of the skip', () => {
  assert.match(step(VERIFY_JOB, SCHEMA).join('\n'), /SEARCH_SCHEMA_ALLOW_MISSING: \$\{\{ inputs\.allow_missing_schema_probe && '1' \|\| '0' \}\}/);
  assert.match(step(VERIFY_JOB, DATA).join('\n'), /SEARCH_DATA_ALLOW_MISSING: \$\{\{ inputs\.allow_missing_schema_probe && '1' \|\| '0' \}\}/);
});

test('the skip takes both actors and the tag from env, never interpolated into the script', () => {
  const env = scalars(block(step(VERIFY_JOB, RECORD), 8, 'env'), 10);
  assert.strictEqual(env.ACTOR, '${{ github.actor }}');
  assert.strictEqual(env.TRIGGERING_ACTOR, '${{ github.triggering_actor }}');
  assert.strictEqual(env.INPUT_VERSION, '${{ inputs.version }}');
  assert.doesNotMatch(runScript(step(VERIFY_JOB, RECORD)), /\$\{\{/);
});

test('the skip warns in the log and writes the same line, naming both actors, to the summary', () => {
  const { stdout, summary } = withTmp(record);
  assert.match(summary, /v0\.114\.3/);
  assert.match(summary, /dispatched by octo-dispatcher/);
  assert.match(summary, /run by octo-rerunner/);
  assert.strictEqual(stdout, `::warning::${summary}`);
});

test('the verify job exposes the skip and its line as job outputs', () => {
  const { outputs, summary } = withTmp(record);
  const jobOutputs = scalars(block(VERIFY_JOB, 4, 'outputs'), 6);
  assert.strictEqual(scalars(step(VERIFY_JOB, RECORD), 8).id, 'skip_record');
  assert.strictEqual(jobOutputs.schema_probe_skipped, '${{ steps.skip_record.outputs.skipped }}');
  assert.strictEqual(jobOutputs.schema_probe_skip_note, '${{ steps.skip_record.outputs.note }}');
  assert.strictEqual(outputs.skipped, 'true');
  assert.strictEqual(outputs.note, summary);
});

test('publish-release names the skip in the release notes only when the gates were skipped', () => {
  const note = step(PUBLISH_JOB, RELEASE_NOTE);
  const skipped = { needs: { 'verify-search-schema': { schema_probe_skipped: 'true' } } };
  assert.match(scalars(PUBLISH_JOB, 4).needs, /verify-search-schema/);
  assert.strictEqual(runs(note, skipped), true);
  assert.strictEqual(runs(note, { needs: { 'verify-search-schema': {} } }), false);
});

test('the release notes keep their body and gain the skip line', () => {
  const env = scalars(block(step(PUBLISH_JOB, RELEASE_NOTE), 8, 'env'), 10);
  assert.strictEqual(env.NOTE, '${{ needs.verify-search-schema.outputs.schema_probe_skip_note }}');

  const notes = withTmp((dir) => {
    const capture = path.join(dir, 'notes');
    const gh = path.join(dir, 'gh');
    fs.writeFileSync(gh, [
      '#!/usr/bin/env bash',
      'case "$1 $2" in',
      '  "release view") echo "Existing notes" ;;',
      '  "release edit") while [ $# -gt 0 ]; do [ "$1" = --notes-file ] && cp "$2" "$CAPTURE"; shift; done ;;',
      '  *) exit 9 ;;',
      'esac',
    ].join('\n'), { mode: 0o755 });
    const run = spawnSync('bash', ['-c', runScript(step(PUBLISH_JOB, RELEASE_NOTE))], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        CAPTURE: capture,
        VERSION: 'v0.114.3',
        REPO: 'bcgov/eagle-demi',
        NOTE: 'skip_schema_probe: skipped by octo-dispatcher',
      },
    });
    assert.strictEqual(run.status, 0, run.stderr);
    return fs.readFileSync(capture, 'utf8');
  });

  assert.strictEqual(notes, 'Existing notes\n\nskip_schema_probe: skipped by octo-dispatcher\n');
});
