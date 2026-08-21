'use strict';

// The bump rules in `scripts/next-version.js` are the only non-trivial logic in the release
// automation, and they are logic nobody watches: the workflow runs unattended on every push to
// `main` and its output becomes the tag a future prod deploy consumes. A wrong bump is not noticed
// when it happens, only later, when two releases claim versions in the wrong order.
//
// Every expectation below is a hardcoded string. Computing the expected version from the same
// parsing the implementation uses would produce a test that agrees with any behaviour, including
// broken behaviour, and therefore can never go red.

const test = require('node:test');
const assert = require('node:assert');

const { nextVersion, highestReleaseTag } = require('../../scripts/next-version');

test('patch-only commits bump the patch', () => {
  assert.strictEqual(nextVersion('v0.1.0', ['fix: bound unbounded Cosmos queries', 'chore: bump eslint']), 'v0.1.1');
});

test('a feat anywhere in the set beats a fix', () => {
  // Order matters here only in that it must not: the highest bump in the whole set wins, so the
  // feat is deliberately not first.
  assert.strictEqual(nextVersion('v0.1.0', ['fix: correct OCR page bound', 'feat: add document search']), 'v0.2.0');
});

test('a scoped feat is recognised', () => {
  assert.strictEqual(nextVersion('v0.3.4', ['feat(search): rank by phrase presence']), 'v0.4.0');
});

test('"feature:" is not the feat type and only bumps the patch', () => {
  // A prefix match would treat this as a feature and inflate the minor.
  assert.strictEqual(nextVersion('v0.1.0', ['feature: add document search']), 'v0.1.1');
});

test('feat! at 0.x bumps the minor, never the major', () => {
  assert.strictEqual(nextVersion('v0.1.0', ['feat!: replace the extraction contract']), 'v0.2.0');
});

test('a scoped refactor! at 0.x bumps the minor, never the major', () => {
  // The exact scenario the 0.x guard exists for: a stray breaking refactor must not mint v1.0.0 on
  // a product that has never shipped to prod.
  assert.strictEqual(nextVersion('v0.9.3', ['refactor(api)!: drop the legacy chunk route']), 'v0.10.0');
});

test('a BREAKING CHANGE body at 0.x bumps the minor', () => {
  const message = 'refactor: move chunking into the worker\n\nBREAKING CHANGE: /api/chunk no longer accepts raw text.';
  assert.strictEqual(nextVersion('v0.1.0', [message]), 'v0.2.0');
});

test('the hyphenated BREAKING-CHANGE footer counts too', () => {
  const message = 'refactor: move chunking into the worker\n\nBREAKING-CHANGE: /api/chunk no longer accepts raw text.';
  assert.strictEqual(nextVersion('v0.1.0', [message]), 'v0.2.0');
});

test('prose about a breaking change is not a breaking change', () => {
  // The body says the opposite of what an unanchored phrase search would trigger. Requiring the
  // footer form — line start, then the spec's separator — is what keeps a promise of compatibility
  // from minting a major.
  const message = 'fix: tighten the retry budget\n\nThis is a NON-BREAKING CHANGE to the /api/chunk contract.';
  assert.strictEqual(nextVersion('v1.4.2', [message]), 'v1.4.3');
});

test('the breaking footer is read from the body, never from the subject', () => {
  // The subject's breaking marker is `!`. A subject that spells the footer out instead is talking
  // about a breaking change, and must not declare one.
  assert.strictEqual(nextVersion('v1.4.2', ['BREAKING CHANGE: the /api/chunk contract changed']), 'v1.4.3');
});

test('feat! at 1.x bumps the major', () => {
  assert.strictEqual(nextVersion('v1.4.2', ['feat!: replace the extraction contract']), 'v2.0.0');
});

test('a BREAKING CHANGE body at 1.x bumps the major', () => {
  const message = 'refactor: move chunking into the worker\n\nBREAKING CHANGE: /api/chunk no longer accepts raw text.';
  assert.strictEqual(nextVersion('v1.4.2', [message]), 'v2.0.0');
});

test('a feat at 1.x bumps the minor', () => {
  assert.strictEqual(nextVersion('v1.4.2', ['feat: add document search']), 'v1.5.0');
});

test('malformed subjects fall through to a patch instead of throwing', () => {
  const messages = ['wip', '', 'Merge pull request #12 from digitalspace/feat/search', ':::', 'feat'];
  assert.strictEqual(nextVersion('v0.1.0', messages), 'v0.1.1');
});

test('an empty commit set still produces a patch', () => {
  // The workflow reruns on a re-push of the same SHA, where `A...B` is empty. A version is still
  // needed for the draft, and it must not collide with the released one.
  assert.strictEqual(nextVersion('v0.1.0', []), 'v0.1.1');
});

test('a missing or unparseable last tag tells the operator to create the seed release', () => {
  for (const bad of [null, undefined, '', 'latest', 'v1.2']) {
    assert.throws(() => nextVersion(bad, ['fix: something']), /seed release/, `expected a throw for ${JSON.stringify(bad)}`);
  }
});

// `highestReleaseTag` is the version BASE. Since every push to `main` mints a tag, picking the wrong
// one re-mints a version that already exists — the tag push then fails, or worse, succeeds against a
// number a previous build already shipped under.

test('the base is the highest tag, not the last one GitHub happened to return', () => {
  assert.strictEqual(highestReleaseTag(['v0.1.0', 'v0.3.1', 'v0.2.7']), 'v0.3.1');
});

test('the base is ordered numerically, not lexically', () => {
  // The one that a plain string sort gets backwards: 'v0.1.9' > 'v0.1.10' as text.
  assert.strictEqual(highestReleaseTag(['v0.1.9', 'v0.1.10']), 'v0.1.10');
  assert.strictEqual(highestReleaseTag(['v0.9.0', 'v0.10.0']), 'v0.10.0');
  assert.strictEqual(highestReleaseTag(['v9.0.0', 'v10.0.0']), 'v10.0.0');
});

test('tags that are not release tags are never the base', () => {
  assert.strictEqual(highestReleaseTag(['v0.1.0', 'v9.9.9-rc1', 'release/2026-08', 'latest', 'v1.2']), 'v0.1.0');
});

test('surrounding whitespace and blank lines from the API stream are tolerated', () => {
  // The caller splits `gh --jq` output on newlines, so a trailing newline yields a final ''.
  assert.strictEqual(highestReleaseTag([' v0.1.0 ', 'v0.2.0\r', '']), 'v0.2.0');
});

test('no release tag at all yields an empty base, which nextVersion turns into the seed error', () => {
  assert.strictEqual(highestReleaseTag([]), '');
  assert.throws(() => nextVersion(highestReleaseTag(['nightly']), ['fix: x']), /seed release/);
});
