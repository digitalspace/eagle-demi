'use strict';

// Staging side-app workflows: they skip while the app or CI's hand-granted role is missing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { readWorkflow, block, scalars, job, step, runScript, runWithFakeAz } = require('../helpers/workflow-yaml');
const { stagePackage, copiedShared } = require('../helpers/function-package');

const SIDE_APPS = [
  {
    file: 'azure-deploy-staging-pdf-title.yaml', job: 'deploy-pdf-title', probe: 'Does the PDF title app exist yet?',
    deploy: 'Deploy the PDF title worker to the Flex app', appVar: 'PDF_TITLE_APP_NAME', app: 'demi-pdf-title-test', fn: 'pdf_title_run',
  },
  {
    file: 'azure-deploy-staging-secret-rotator.yaml', job: 'deploy-secret-rotator', probe: 'Does the secret rotator app exist yet?',
    deploy: 'Deploy the secret rotator to the Flex app', appVar: 'SECRET_ROTATOR_APP_NAME', app: 'demi-secret-rotator-test', fn: 'secretRotatorHourly',
  },
];
const TIMER = 'Verify the timer is registered';

for (const side of SIDE_APPS) {
  const LINES = readWorkflow(side.file);
  const JOB = job(LINES, side.job);

  test(`${side.file}: deploys ${side.app}`, () => {
    assert.strictEqual(scalars(block(LINES, 0, 'env'), 2)[side.appVar], side.app);
  });

  test(`${side.file}: the deploy and timer check run only when the probe found the app`, () => {
    for (const name of [side.deploy, TIMER]) {
      assert.strictEqual(scalars(step(JOB, name), 8).if, "steps.probe.outputs.found == 'true'");
    }
    assert.match(scalars(step(JOB, TIMER), 8).run, new RegExp(`"\\$${side.appVar}" ${side.fn}$`));
  });

  test(`${side.file}: the probe asks for ${side.app}, with no tag marker`, () => {
    const probe = (opts) => runWithFakeAz(runScript(step(JOB, side.probe)), {
      env: { AZURE_RESOURCE_GROUP: 'c4b0a8-test-rg', [side.appVar]: side.app }, ...opts,
    });
    assert.strictEqual(probe({ azOut: side.app }).found, 'found=true');
    const absent = probe({ azErr: '(ResourceNotFound) gone' });
    assert.strictEqual(absent.found, 'found=false');
    assert.match(absent.stdout, new RegExp(`^::notice::${side.app} does not exist yet`, 'm'));
  });
}

test('the rotator workflow triggers on exactly the files its zip is built from', (t) => {
  const stage = stagePackage('secret-rotator');
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  const paths = block(block(block(readWorkflow(SIDE_APPS[1].file), 0, 'on'), 2, 'push'), 4, 'paths')
    .map((l) => /^\s+- '(.+)'$/.exec(l))
    .filter(Boolean)
    .map((m) => m[1])
    .sort();
  const expected = [
    'src/secret-rotator/**',
    ...copiedShared(stage, 'secret-rotator'),
    'scripts/package-secret-sync.sh',
    `.github/workflows/${SIDE_APPS[1].file}`,
  ].sort();
  assert.deepStrictEqual(paths, expected);
});
