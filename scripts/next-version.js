'use strict';

// Computes the next semantic version for the rolling draft release from Conventional Commit
// messages. `.github/workflows/draft-release.yaml` runs this on every push to `main` and feeds the
// result to `gh release create --draft`.
//
// Inputs come from `gh`, never from git history. `git describe` walks HEAD's ancestry only, so a
// tag sitting on a commit that is not an ancestor of HEAD silently resolves to an OLDER base and
// yields a lower version than the one already released — a wrong number, produced quietly, which is
// the worst failure available here. `gh release view` is ancestry-independent, and `A...B` is the
// same commit set GitHub itself diffs for `--generate-notes`, so the version and the notes in one
// draft can never describe different sets of commits.

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

module.exports = { nextVersion };

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
    // `gh release view` with no tag returns the latest PUBLISHED release, skipping drafts. That is
    // what stops the rolling draft from feeding itself: the draft carrying v0.1.1 is invisible
    // here, so the next push recomputes from v0.1.0 and lands on v0.1.1 again instead of climbing
    // one version per push.
    //
    // "Latest" is GitHub's flag, not tag order. Ticking "Set as the latest release" on an OLDER
    // published release — the usual reflex when a newer one turns out bad — moves this base
    // backwards, and the next run then tries to create a draft for a version that already exists as
    // a published tag. That surfaces as a `gh release create` "already exists" failure whose message
    // does not mention the flag; untick it and the next push recovers on its own.
    //
    // `--repo` is passed explicitly so this and the compare call below cannot resolve to different
    // repositories: without it `gh` infers from the checkout's origin remote, while the compare uses
    // GITHUB_REPOSITORY. In a fork or a mirror clone that yields a base tag from one repository and
    // a commit range from another.
    lastTag = gh(['release', 'view', '--repo', repository, '--json', 'tagName', '--jq', '.tagName']);
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
  // that falls off the end, and the result would be a version that is quietly too low. Reachable
  // here: publishing is a manual click, so the gap between two published releases is unbounded.
  // Failing is the point. Paginating instead would trade a loud stop for a multi-megabyte download
  // on every push, and a draft that has gone 250 commits without being published needs a human
  // anyway.
  if (compare.total > compare.messages.length) {
    console.error(
      `Cannot compute the next version: GitHub returned ${compare.messages.length} of ` +
        `${compare.total} commits since ${lastTag}. Its compare endpoint caps a response at 250 and ` +
        'drops the newest ones, so any version computed here would be too low. Publish the current ' +
        'draft release — the next comparison then starts from it and is short again.'
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
