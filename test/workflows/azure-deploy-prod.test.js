'use strict';

// The prod deploy workflow: the skip_schema_probe break-glass input and the side-app jobs.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readWorkflow, block, scalars, job: jobIn, stepIndex, step, runScript, withTmp, runWithFakeAz } = require('../helpers/workflow-yaml');

const LINES = readWorkflow('azure-deploy-prod.yaml');

function input(name) {
  const inputs = block(block(block(LINES, 0, 'on'), 2, 'workflow_dispatch'), 4, 'inputs');
  return scalars(block(inputs, 6, name), 8);
}

const job = (name) => jobIn(LINES, name);
const VERIFY_JOB = job('verify-search-schema');
const PUBLISH_JOB = job('publish-release');

// Only `inputs.x`, `!inputs.x` and `needs.<job>.outputs.<key> == '<value>'`; anything else throws,
// so a rewrite fails here instead of passing blind.
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

function bash(script, env) {
  return spawnSync('bash', ['-e', '-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, ...env } });
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
  const inFile = LINES.join('\n').match(/inputs\.skip_schema_probe/g) || [];
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
      stdio: ['ignore', 'pipe', 'pipe'],
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

// Side-app jobs skip rather than fail while prod has no app, so a release before the infra deploy
// still publishes.
const SIDE_APPS = [
  {
    job: 'deploy-pdf-title', probe: 'Does the PDF title app exist yet?', deploy: 'Deploy the PDF title worker',
    packager: 'package-pdf-title.sh', appVar: 'PDF_TITLE_APP_NAME', app: 'demi-pdf-title-prod',
    marker: 'pdf-title/function_app.py', fn: 'pdf_title_run', appArg: undefined,
  },
  {
    job: 'deploy-secret-rotator', probe: 'Does the secret rotator app exist yet?', deploy: 'Deploy the secret rotator',
    packager: 'package-secret-sync.sh', appVar: 'SECRET_ROTATOR_APP_NAME', app: 'demi-secret-rotator-prod',
    marker: 'src/secret-rotator/index.js', fn: 'secretRotatorHourly', appArg: 'secret-rotator',
  },
];

for (const side of SIDE_APPS) {
  const JOB = job(side.job);
  const TIMER = 'Verify the timer is registered';

  test(`${side.job} runs after the API, as prod, from the tag being deployed`, () => {
    const top = scalars(JOB, 4);
    assert.strictEqual(top.needs, 'deploy-api');
    assert.strictEqual(top.environment, 'prod');
    assert.strictEqual(scalars(block(step(JOB, 'Checkout the tag'), 8, 'with'), 10).ref,
      'refs/tags/${{ inputs.version }}');
    assert.ok(stepIndex(JOB, VALIDATE) < stepIndex(JOB, 'Checkout the tag'));
  });

  test(`publish-release waits for ${side.job}`, () => {
    assert.match(scalars(PUBLISH_JOB, 4).needs, new RegExp(`\\b${side.job}\\b`));
  });

  test(`${side.job}: the deploy and timer check run only when the probe found the app`, () => {
    for (const name of [side.deploy, TIMER]) {
      assert.strictEqual(scalars(step(JOB, name), 8).if, "steps.probe.outputs.found == 'true'");
    }
  });

  test(`${side.job} waits for ${side.fn} to register`, () => {
    assert.strictEqual(scalars(step(JOB, TIMER), 8).run,
      `./scripts/wait-for-function.sh "$AZURE_RESOURCE_GROUP" "$${side.appVar}" ${side.fn}`);
  });

  test(`${side.job} packages from the tag checkout, not the workflow ref`, () => {
    const tagPath = scalars(block(step(JOB, 'Checkout the tag'), 8, 'with'), 10).path;
    const args = withTmp((dir) => {
      const capture = path.join(dir, 'args');
      fs.mkdirSync(path.join(dir, 'scripts'));
      fs.writeFileSync(path.join(dir, 'scripts', side.packager),
        `#!/usr/bin/env bash\necho "$*" > '${capture}'\n`, { mode: 0o755 });
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'az'), '#!/usr/bin/env bash\n', { mode: 0o755 });
      const run = spawnSync('bash', ['-e', '-c', runScript(step(JOB, side.deploy))], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: `${bin}:${process.env.PATH}`, AZURE_RESOURCE_GROUP: 'rg-demi-prod', [side.appVar]: side.app },
      });
      assert.strictEqual(run.status, 0, run.stderr);
      return fs.readFileSync(capture, 'utf8').trim().split(' ');
    });
    assert.strictEqual(tagPath, 'release');
    assert.strictEqual(args[0], tagPath);
    assert.strictEqual(args[2], side.appArg);
  });

  // The probe's own branches are covered in test/scripts/probe-function-app.test.js.
  const probe = (opts) => runWithFakeAz(runScript(step(JOB, side.probe)), {
    env: { AZURE_RESOURCE_GROUP: 'rg-demi-prod', [side.appVar]: side.app }, ...opts,
  });

  test(`${side.job}: the probe asks for ${side.app} and deploys when it exists`, () => {
    const r = probe({ files: [path.join('release', side.marker)], azErr: '(ResourceNotFound) gone' });
    assert.match(r.stdout, new RegExp(`^::notice::${side.app} does not exist yet`, 'm'));
    assert.strictEqual(probe({ files: [path.join('release', side.marker)], azOut: side.app }).found, 'found=true');
  });

  test(`${side.job}: the probe skips a tag that predates the app without asking Azure`, () => {
    const r = probe({ azErr: 'az must not be called' });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.found, 'found=false');
    assert.ok(r.stdout.includes(`The tag has no ${side.marker}`), r.stdout);
  });
}
