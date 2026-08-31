#!/usr/bin/env python3
import os
import sys
import zipfile

def walk(top, blocked=()):
    """
    `os.walk` that follows a symlinked directory, but never a symlink reached THROUGH one.

    The default does not descend into a symlinked directory, and says nothing when it skips one.
    That is silent data loss for a packager: point `node_modules` at a store — a shared install, or
    a git worktree borrowing one to avoid a 300 MB reinstall — and the packager walks past it,
    exits 0, and produces a zip that deploys and then cannot boot, because the app has no route to
    a registry to `npm install` from. Measured before this fix: zero `node_modules/` entries, exit
    0, no warning.

    ONE LINK DEEP, and the bound is the point. Two richer rules were tried and both were wrong:

      * A global visited-set is bounded but drops content. Two names legitimately resolve to one
        directory, and marking the realpath seen at the shallower one prunes the real tree under
        the deeper. Measured on a pnpm-shaped store: the entire `.pnpm` tree vanished.
      * Skipping only a realpath already on the current branch keeps all of that, and stops cycles,
        but nothing then bounds the OUTPUT. A reconvergent acyclic layout — the shape workspaces
        and `link:` dependencies produce — makes the walk enumerate every distinct path through the
        graph. Measured on a 20-level fixture holding 22 real directories: 114,590 entries and a
        58 MB zip, exit 0, no warning. `package_api` records below what an oversized package did to
        Kudu: status 1 for over thirty minutes against a normal thirty seconds.

    Counting links spent instead of directories seen bounds the output by construction — every
    emitted path crosses at most one symlink, so the total is the real tree plus one copy of each
    link target — while still covering every case this repo has: a symlinked `node_modules`, a link
    into a re-included data directory, and an alias beside the real directory it points at. A cycle
    needs at least two hops to close, so it cannot form.

    Deeper symlink layouts are deliberately out of scope. `.yarnrc.yml` pins
    `nodeLinker: node-modules`, so a real install is a real tree; anything more elaborate is a
    layout this app does not deploy from, and guessing at it is what produced both earlier bugs.
    """
    max_links = 1
    spent = {top: 0}
    blocked = tuple(blocked)
    for root, dirs, files in os.walk(top, followlinks=True):
        used = spent.pop(root, 0)
        keep = []
        for d in dirs:
            child = os.path.join(root, d)
            cost = used + (1 if os.path.islink(child) else 0)
            if cost > max_links:
                continue
            # An exclusion is a fact about a DIRECTORY, not about a name at one position in the
            # tree — and following symlinks is exactly what makes those two stop agreeing.
            # `root_exclude_dirs` is applied by the caller only at the repo root, so before this
            # a link anywhere could re-admit `.claude/worktrees/*` or `test/` under the link's own
            # name. Those worktrees are full checkouts of this repository; shipping them once made
            # a 202 MB package that left Kudu at status 1 for over thirty minutes.
            real = os.path.realpath(child)
            if any(real == b or real.startswith(b + os.sep) for b in blocked):
                continue
            # Recorded only for directories actually descended into, so a name the CALLER prunes
            # (root_exclude_dirs) costs nothing and starves nothing.
            spent[child] = cost
            keep.append(d)
        # Prune in place, which is what os.walk reads to decide where to go next.
        dirs[:] = keep
        yield root, dirs, files


def excluded_file(file, exclude_extensions):
    """
    Whether a file must never be packaged, wherever it was reached from.

    Shared by both write loops on purpose. The re-include loop below used to write whatever it
    walked with no filtering at all, which was survivable only while it could not leave the three
    checked-in data directories. Following symlinks ended that: a `.env` in a directory one of them
    links to reached the package. The comment on `.env` is not hypothetical — a packaged one
    carried MONGODB_PASSWORD, TYPESENSE_API_KEY, MINIO_SECRET_KEY and DOCLING_API_KEY into
    /home/site/wwwroot/.env, world-readable.

    Matched at every depth, and by NAME rather than extension: ".env" has no extension to filter on.
    """
    if file == ".env" or file.startswith(".env."):
        return True
    return any(file.endswith(ext) for ext in exclude_extensions)


def package_api(repo_root, zip_path):
    # Pruned at the REPO ROOT ONLY. Excluding "dist" at every depth also strips
    # node_modules/**/dist (e.g. @mongodb-js/saslprep) and ships an app that 500s on every
    # request. Do not reintroduce that.
    # `extraction-host` is vendored SOURCE for a machine outside Azure — Python the Node app never
    # loads. Shipping it would put worker.py and three systemd units at the app root, which is the
    # same class of debris the 2026-08-04 wwwroot sweep had to clean out by hand. Excluded at the
    # root only, like `frontend`.
    # `.claude` holds agent scratch AND `.claude/worktrees/*`, which are full git checkouts of this
    # same repository. Without this exclusion the package was 202 MB — 697 MB of it uncompressed
    # `.claude` against under 1 MB of actual `src` — and the deploy hung: Kudu sat at status 1 for
    # over thirty minutes where a healthy deploy of this app finishes in about thirty seconds.
    # `.git` was already excluded for the same reason; a worktree is the same problem wearing a
    # different directory name.
    # ‼️ `scripts` here is the ROOT one — deploy tooling (this file, deploy-azure.sh, the geojson
    # exporters). It is NOT `src/scripts`, which IS runtime: `src/controllers/db.js` requires
    # `src/controllers/wildfire.js` requires `../scripts/sync-wildfires`, resolving under `src/`.
    # Two directories, near-identical names, opposite fates.
    #
    # The `rel_root == "."` guard below is what keeps them apart. Remove that guard and `src/scripts`
    # disappears too, breaking `POST /admin/sync/wildfires` at runtime
    # with an ENOENT no unit test would catch. `test/scripts/package-api.test.js` pins it.
    #
    # `test`, `azure`, `.github` and `.vscode` are not runtime either — nothing reachable from
    # index.js -> api/index.js -> src/** loads them. They were shipped only because nothing excluded
    # them, which is how wwwroot ended up holding a copy of the repository.
    # `public` is an untracked local build output that nothing serves. Excluded because this
    # packager runs from whatever working tree the operator has, and a stale bundle would ship.
    root_exclude_dirs = {".git", ".claude", "frontend", "extraction-host", "extractor", ".angular",
                         "dist", "coverage", ".deploy_archives", "tmp", "__pycache__",
                         "test", "azure", ".github", ".vscode", "scripts", "public"}

    # Root-level files with no runtime role. `Dockerfile` describes a container Azure does not build,
    # `eslint.config.js` is lint config, `.gitignore` is meaningless once unpacked. Root-scoped for
    # the same reason as the dirs: a nested `Dockerfile` inside node_modules is not our business.
    root_exclude_files = {"Dockerfile", "eslint.config.js", ".gitignore"}

    exclude_extensions = {".zip", ".tar.gz", ".map", ".md"}

    # The boundary seeder reads the checked-in GeoJSON exports, which live under frontend/ because
    # the frontend serves them too. `frontend` is otherwise excluded, so without this the seed
    # fails with ENOENT on regional_districts.geojson only when run in Azure — never locally.
    # Kept as one source rather than a second copy under src/data, which would drift.
    #
    # The search index definitions are the same shape of problem, and cost more when missed.
    # `src/search/eagle-query.js` builds its field-type gate from `azure/search/indexes/*.json` at
    # REQUIRE time, and the first search reaches it: src/http/routes.js -> src/controllers/search.js
    # -> eagle-query.js. So a package without them does not degrade search, it kills it outright,
    # and the only thing in the log is an ENOENT on a scandir of a path that does not exist in
    # wwwroot.
    # Kept as one source for the same reason as the geojson: a copy under src/ would drift from
    # the definitions that are actually deployed to the search service, and the gate would then be
    # describing an index that is not the one being queried.
    include_subpaths = {os.path.join("frontend", "public", "assets", "geojson"),
                        os.path.join("azure", "search", "indexes"),
                        # INDEXERS TOO, and the omission was not theoretical: with only `indexes`
                        # re-included, `src/scripts/apply-search-definitions.js` — which IS packaged
                        # — died at `load(INDEXER_DIR)` with ENOENT before issuing a single request,
                        # on both dry run and --live. Data sources stay OUT: their connectionString
                        # comes back redacted on export, so the committed copy could only ever
                        # restore a broken one, and nothing reads them at runtime.
                        os.path.join("azure", "search", "indexers")}

    print(f"Packaging {repo_root} -> {zip_path}...")
    count = 0
    extra = 0
    # Realpaths of the excluded directories, so a followed symlink cannot re-admit one under a
    # different name. Identity, not position.
    blocked = tuple(sorted(
        os.path.realpath(os.path.join(repo_root, d)) for d in root_exclude_dirs
        if os.path.isdir(os.path.join(repo_root, d))))

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in walk(repo_root, blocked):
            rel_root = os.path.relpath(root, repo_root)
            if rel_root == ".":
                dirs[:] = [d for d in dirs if d not in root_exclude_dirs]

            for file in files:
                if rel_root == "." and file in root_exclude_files:
                    continue
                if excluded_file(file, exclude_extensions):
                    continue
                full_path = os.path.join(root, file)
                rel_path = os.path.relpath(full_path, repo_root)
                z.write(full_path, rel_path)
                count += 1

        for sub in sorted(include_subpaths):
            sub_abs = os.path.join(repo_root, sub)
            if not os.path.isdir(sub_abs):
                raise SystemExit(f"ERROR: required data directory is missing: {sub}")
            # Counted PER SUBPATH, because the running `extra` total only ever guards the FIRST
            # entry. Iteration is sorted, so today that is `azure/search/indexes` and the
            # unguarded one is the geojson: once the indexes have contributed files, an empty
            # `frontend/public/assets/geojson` would read as "fine" and ship a boundary seeder
            # that ENOENTs only in Azure. Which entry is exposed depends purely on sort order, so
            # adding a third subpath silently moves the hole — counting per subpath removes it
            # rather than relocating it.
            found = 0
            # Minus any block that CONTAINS this subpath — `frontend` is excluded wholesale and the
            # geojson lives under it, so blocking it here would empty the very directory this loop
            # exists to re-include.
            sub_real = os.path.realpath(sub_abs)
            sub_blocked = tuple(
                b for b in blocked
                if not (sub_real == b or sub_real.startswith(b + os.sep)))
            for root, _dirs, files in walk(sub_abs, sub_blocked):
                for file in files:
                    if excluded_file(file, exclude_extensions):
                        continue
                    full_path = os.path.join(root, file)
                    rel_path = os.path.relpath(full_path, repo_root)
                    z.write(full_path, rel_path)
                    count += 1
                    extra += 1
                    found += 1
            if found == 0:
                raise SystemExit(f"ERROR: required data directory is empty: {sub}")

        # Stamp the deploy id INTO the package. /api/config reports this back and
        # deploy-azure.sh compares it, which is the only way to tell from outside which CODE is
        # answering. An app setting cannot do this job: App Service serves the old container for
        # roughly two minutes after a deploy, and that old container reads the new setting when it
        # restarts and reports the new value quite happily. Only a file inside the package can
        # distinguish new code from an old worker with fresh configuration.
        z.writestr("build-id.txt", os.environ.get("BUILD_ID", "unknown"))

    print(f"Packaged {count} files into {zip_path} ({extra} from re-included data dirs)")

if __name__ == "__main__":
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    out = sys.argv[2] if len(sys.argv) > 2 else "/tmp/api-deploy.zip"
    package_api(os.path.abspath(root), out)
