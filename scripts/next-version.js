'use strict';

// Computes the next semantic version for the release candidate from Conventional Commit messages.
// `.github/workflows/draft-release.yaml` runs this on every push to `main` and feeds the result to
// `git tag` and then to `gh release create --draft`.
//
// Inputs come from `gh`, never from git history. `git describe` walks HEAD's ancestry only, so a
// tag sitting on a commit that is not an ancestor of HEAD silently resolves to an OLDER base and
// yields a lower version than the one already released — a wrong number, produced quietly, which is
// the worst failure available here. The tags endpoint below is ancestry-independent.
//
// THE BASE IS THE HIGHEST TAG, not the latest published release. Every push to `main` now mints a
// tag, so a base that only saw published releases would recompute the same number on the next push
// and collide with the tag it had just created.
//
// A consequence worth stating: the range this bump is computed over and the range GitHub generates
// release NOTES over are deliberately different. The bump runs from the last tag, because the number
// has to climb once per push. `--generate-notes` is left to infer its own start, which is the last
// PUBLISHED release — the last version that actually reached production. So a candidate that is
// never deployed still spends a version, and the notes on the candidate that IS deployed carry its
// work too. "What is new in prod" is the question a published release answers.

const { execFileSync } = require('node:child_process');

// `type(scope)!:` — the `!` is the Conventional Commits breaking-change marker. Anything that does
// not match (a bare "wip", a merge commit, a revert of a revert) simply scores no bump rather than
// throwing: a release must not be blocked by one commit that skipped the format.
const HEADER = /^(?<type>[a-zA-Z]+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:/;

// Both spellings are normative in the Conventional Commits spec; `BREAKING-CHANGE` exists because a
// footer token cannot contain a space. The footer FORM is required — start of a line, followed by
// the spec's `: ` or ` #` separator. An unanchored search for the phrase would read prose as a
// declaration: a body reading "this is not a BREAKING CHANGE for callers" says the opposite of what
// it would then trigger, and at 1.x that mints a whole major on a commit that promised not to.
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE(?=: | #)/m;

// The only tag shape this project's automation creates. Anything else in the repository — a vendor
// tag, a `v1.2.3-rc1`, a `release/2026-08` — is not a version base and must not become one.
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

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
  const parsed = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(lastTag == null ? '' : lastTag).trim());
  // There is deliberately no "no previous release" branch. The seed release v0.1.0 is created once
  // by hand, so a predecessor always exists and every version is computed from a real one. Reaching
  // here means the seed is gone or renamed, which is an operator problem, not something to paper
  // over by inventing a starting point that would then disagree with the notes GitHub generates.
  if (!parsed) {
    // The suggested command carries `--notes` on purpose: without it `gh` opens an editor, and with
    // no TTY (a CI shell, an ssh one-liner, a pipe) it just refuses. This message is read at exactly
    // the moment a pasted command has to work first try.
    throw new Error(
      `Cannot compute the next version: ${JSON.stringify(lastTag)} is not a version tag. ` +
        'Create the seed release first: ' +
        'gh release create v0.1.0 --repo digitalspace/eagle-demi --target main --title "v0.1.0" ' +
        '--notes "Baseline: the state of staging as of the first tagged release."'
    );
  }

  let [major, minor, patch] = parsed.slice(1).map(Number);
  const level = (commitMessages || []).reduce((highest, message) => Math.max(highest, bumpLevel(message)), PATCH);

  // The 0.x guard. SemVer says anything may change while the major is 0, so a breaking change here
  // is a minor bump, and 1.0.0 stays a deliberate human decision. Without this, a single stray
  // `refactor!:` would mint v1.0.0 for a product that has never shipped to prod — and a version
  // number cannot be walked back once a draft carrying it has been published.
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
  // In Actions the workflow's own SHA is the target, not a branch name, so a push landing mid-run
  // cannot move the comparison. Outside Actions the fallback `HEAD` is resolved by GitHub, not by
  // the local checkout: it means the remote default branch. A local preview therefore reports the
  // bump for what is on the remote, and cannot see unpushed commits on a feature branch.
  const sha = process.env.GITHUB_SHA || 'HEAD';
  const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

  let lastTag = '';
  try {
    // Sorted here, not by GitHub: the tags endpoint's order is unspecified — neither semver nor
    // creation time — so the highest is picked explicitly, with a NUMERIC collation. A plain string
    // sort puts `v0.1.9` above `v0.1.10` and would hand back a base that has already been used.
    //
    // Reads tags rather than releases so an unpublished candidate is still seen. Reads the API
    // rather than `git tag --sort=-v:refname` so it needs neither a full-depth checkout nor fetched
    // tag refs, and so a local preview reports what the REMOTE has, matching the compare below.
    //
    // The repository is passed explicitly so this and the compare call below cannot resolve to
    // different repositories: without it `gh` infers from the checkout's origin remote, while the
    // compare uses GITHUB_REPOSITORY. In a fork or a mirror clone that yields a base tag from one
    // repository and a commit range from another.
    lastTag = highestReleaseTag(gh(['api', `repos/${repository}/tags`, '--paginate', '--jq', '.[].name']).split('\n'));
  } catch {
    // gh has already printed its own reason on stderr; fall through so nextVersion raises the
    // actionable "create the seed release" error rather than a bare non-zero exit.
  }

  // `total_commits` is fetched alongside the messages so truncation is detectable — see the guard
  // below. Emitted as one JSON object, not one message per line: commit messages contain newlines
  // themselves, so a newline-delimited stream has no unambiguous boundary between two messages, and
  // a body line reading `feat: ...` would be indistinguishable from the next commit's subject and
  // would bump the minor on its own.
  //
  // The `--jq` projection is also what keeps this inside execFileSync's 1 MB default buffer: a raw
  // compare response carries every changed file's full patch, which is ~10 MB across this
  // repository's history and dies with ENOBUFS.
  //
  // Skipped without a tag so the missing-seed case surfaces as the error below rather than as a
  // raw 404 body from a comparison with no left-hand side.
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

  // The compare endpoint caps `.commits` at 250 and announces it nowhere except a `total_commits`
  // that disagrees with the array length. The response is ordered base->head, so what gets dropped
  // is the NEWEST work — the one `feat:` that should have bumped the minor is exactly the commit
  // that falls off the end, and the result would be a version that is quietly too low. A tag per
  // push normally keeps this gap at one commit, but it stays reachable: a long-lived branch merged
  // in one push, or a run whose tag step failed, both widen it. Failing is the point. Paginating
  // instead would trade a loud stop for a multi-megabyte download on every push.
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
  // The failure above is written for an operator, so it is printed as a sentence rather than thrown:
  // an uncaught throw buries that sentence under a node stack trace naming internal frames, in an
  // Actions log where the first line is the one that gets read.
  try {
    process.stdout.write(`${nextVersion(lastTag, compare.messages)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
