'use strict';

// Next semantic version from Conventional Commits, for draft-release.yaml. Details: wiki Release-Process.
// Inputs from `gh`, never git history: `git describe` walks ancestry only and yields an older base.

const { execFileSync } = require('node:child_process');

// `type(scope)!:` — the `!` is the breaking-change marker. Anything that does not match scores no
// bump rather than throwing: a release must not be blocked by one commit that skipped the format.
const HEADER = /^(?<type>[a-zA-Z]+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:/;

// The footer FORM is required — line start, then the spec's `: ` or ` #`. An unanchored search reads
// prose as a declaration: "this is not a BREAKING CHANGE for callers" would mint a major at 1.x.
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE(?=: | #)/m;

// The only tag shape this project's automation creates, and the only base it will accept. A vendor
// tag, a `v1.2.3-rc1` or a `release/2026-08` is not a version base.
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

const PATCH = 0;
const MINOR = 1;
const MAJOR = 2;

function bumpLevel(message) {
  const [header, ...body] = String(message).split('\n');
  const match = HEADER.exec(header.trim());

  if (match && match.groups.breaking) return MAJOR;
  // Only the body is searched. The subject's breaking marker is `!`, per the spec; a subject that
  // merely spells the footer out is talking about a breaking change, not declaring one.
  if (BREAKING_FOOTER.test(body.join('\n'))) return MAJOR;
  // Exact match, not a prefix: `feature:` and `feat-flag:` are not the `feat` type, and treating
  // them as one would inflate the minor on commits that never claimed a new feature.
  if (match && match.groups.type === 'feat') return MINOR;

  return PATCH;
}

/**
 * Picks the version base out of an unordered list of tag names.
 *
 * @param {string[]} names  every tag in the repository, in whatever order GitHub returned them
 * @returns {string} the highest `vX.Y.Z` tag, or `''` if there is none
 */
function highestReleaseTag(names) {
  return (
    (names || [])
      .map((name) => String(name).trim())
      .filter((name) => RELEASE_TAG.test(name))
      // Numeric collation, not a string sort: `'v0.1.9' > 'v0.1.10'` lexically, and taking that as
      // the base re-mints a version that already exists as a tag.
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .pop() || ''
  );
}

/**
 * @param {string} lastTag  the previous release tag, e.g. `v0.1.0`
 * @param {string[]} commitMessages  full messages (subject + body) of every commit since lastTag
 * @returns {string} the next version, `v`-prefixed
 */
function nextVersion(lastTag, commitMessages) {
  const parsed = RELEASE_TAG.exec(String(lastTag == null ? '' : lastTag).trim());
  // No "no previous release" branch on purpose: the seed release is created once by hand, so
  // reaching here means it is gone or renamed, which is an operator problem.
  if (!parsed) {
    // `--notes` on purpose: without it `gh` opens an editor and refuses when there is no TTY.
    throw new Error(
      `Cannot compute the next version: ${JSON.stringify(lastTag)} is not a version tag. ` +
        'Create the seed release first: ' +
        'gh release create v0.1.0 --repo digitalspace/eagle-demi --target main --title "v0.1.0" ' +
        '--notes "Baseline: the state of staging as of the first tagged release."'
    );
  }

  let [major, minor, patch] = parsed.slice(1).map(Number);
  const level = (commitMessages || []).reduce((highest, message) => Math.max(highest, bumpLevel(message)), PATCH);

  // The 0.x guard: SemVer lets anything change while the major is 0, so 1.0.0 stays a human
  // decision. Without it one stray `refactor!:` mints v1.0.0, and a version cannot be walked back.
  if (level === MAJOR && major >= 1) {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (level >= MINOR) {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }

  return `v${major}.${minor}.${patch}`;
}

module.exports = { nextVersion, highestReleaseTag };

if (require.main === module) {
  const repository = process.env.GITHUB_REPOSITORY || 'digitalspace/eagle-demi';
  // The workflow's own SHA, so a push landing mid-run cannot move the comparison. The `HEAD`
  // fallback is resolved by GitHub — the remote default branch, not the local checkout.
  const sha = process.env.GITHUB_SHA || 'HEAD';
  const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

  let lastTag = '';
  try {
    // `matching-refs/tags/v` filters server-side, in no defined order — hence the numeric sort.
    // Tags, not releases, so an unpublished candidate is seen. Repository explicit: a fork drifts.
    lastTag = highestReleaseTag(gh([
      'api', `repos/${repository}/git/matching-refs/tags/v?per_page=100`, '--paginate',
      '--jq', '.[].ref | sub("^refs/tags/"; "")',
    ]).split('\n'));
  } catch (err) {
    // Only a 404 actually means the seed is missing; a bad flag, a rate limit or a 5xx land here
    // too, and the "create the seed release" error below would then be a wrong instruction.
    process.stderr.write(
      `Could not list tags for ${repository}: ${err.message}\n` +
      'If that is a 404 the seed release is genuinely missing; anything else is a gh or API ' +
      'failure and the message below about creating a seed release does not apply.\n'
    );
  }

  // One JSON object, not a message per line: a body line reading `feat: ...` would otherwise read as
  // the next subject. The projection also keeps this inside execFileSync's 1 MB buffer.
  const compare = lastTag
    ? JSON.parse(
        gh([
          'api',
          `repos/${repository}/compare/${lastTag}...${sha}`,
          '--jq',
          '{total: .total_commits, messages: [.commits[].commit.message]}',
        ])
      )
    : { total: 0, messages: [] };

  // The compare endpoint caps `.commits` at 250, announced nowhere but a `total_commits` that
  // disagrees with the array length — and it drops the NEWEST work, so failing loudly is the point.
  if (compare.total > compare.messages.length) {
    console.error(
      `Cannot compute the next version: GitHub returned ${compare.messages.length} of ` +
        `${compare.total} commits since ${lastTag}. Its compare endpoint caps a response at 250 and ` +
        'drops the newest ones, so any version computed here would be too low. Tag an intermediate ' +
        'commit by hand — the next comparison then starts from it and is short again.'
    );
    process.exit(1);
  }

  // Only the version goes to stdout: the workflow captures this whole stream as the release tag.
  // Printed as a sentence rather than thrown — a stack trace buries the line that gets read.
  try {
    process.stdout.write(`${nextVersion(lastTag, compare.messages)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
