#!/usr/bin/env python3
import os
import sys
import zipfile

def walk(top):
    """
    `os.walk` that FOLLOWS symlinked directories, without re-entering one it is already inside.

    The default does not descend into a symlinked directory, and it says nothing when it skips one.
    That is silent data loss for a packager: point `node_modules` at a store — a shared install, a
    git worktree borrowing one to avoid a 300 MB reinstall — and the packager walks straight past
    it, exits 0, and produces a zip that deploys and then cannot boot, because the app has no route
    to a registry to `npm install` from. Measured before this fix against a tree with a symlinked
    `node_modules`: zero `node_modules/` entries, exit 0, no warning.

    `followlinks=True` alone is not enough, and not for the usual reason. A symlink pointing back at
    an ancestor does not hang: the path grows one link per level, and at about forty the kernel
    raises ELOOP and the walk dies with an uncaught OSError — after it has already written the
    duplicates it produced on the way down.

    So the guard is per-BRANCH, not global: a directory is skipped only when its real path is
    already somewhere on the chain of directories the walk entered to reach it. A global
    visited-set is the obvious implementation and it is WRONG, because two different paths
    legitimately resolve to one directory. pnpm is the case that proves it — `node_modules/foo` is
    a link into `node_modules/.pnpm/foo@1.0.0/node_modules/foo`, and marking the realpath seen at
    the shallower name prunes the real store underneath. Measured: the whole `.pnpm` tree vanished
    from the package, content the previous version did ship. Both paths have to survive, because
    Node resolves through both.
    """
    chains = {top: (os.path.realpath(top),)}
    for root, dirs, files in os.walk(top, followlinks=True):
        chain = chains.pop(root, None) or (os.path.realpath(root),)
        keep = []
        for d in dirs:
            child = os.path.join(root, d)
            real = os.path.realpath(child)
            # Already on the way in: following it would walk the same branch again.
            if real in chain:
                continue
            # Recorded only for directories actually descended into, so a name the CALLER prunes
            # (root_exclude_dirs) never claims a realpath another path still needs.
            chains[child] = chain + (real,)
            keep.append(d)
        # Prune in place, which is what os.walk reads to decide where to go next.
        dirs[:] = keep
        yield root, dirs, files


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
    # `public` is a local build output, untracked by git, and nothing serves it any more — the
    # express.static mounts and the SPA sendFile routes that read it were deleted from src/app.js
    # (they answered 404 or hung; see the comment there). It is excluded rather than merely unused
    # because zipdeploy MERGES into wwwroot: packaging a stale bundle once leaves it on the box for
    # good, and this packager runs from whatever working tree the operator happens to have.
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
    # REQUIRE time, and the boot chain reaches it: index.js -> api/index.js -> src/routes/api.js ->
    # src/controllers/search.js -> eagle-query.js. So a package without them does not lose search,
    # it loses EVERY endpoint, and the only thing in the log is an ENOENT on a scandir of a path
    # that does not exist in wwwroot. Verified by unzipping the package and requiring src/app.
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
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in walk(repo_root):
            rel_root = os.path.relpath(root, repo_root)
            if rel_root == ".":
                dirs[:] = [d for d in dirs if d not in root_exclude_dirs]

            for file in files:
                if rel_root == "." and file in root_exclude_files:
                    continue
                if any(file.endswith(ext) for ext in exclude_extensions):
                    continue
                # Never ship .env. App settings supply every variable in Azure, so a packaged .env
                # is pure liability: it carried MONGODB_PASSWORD, TYPESENSE_API_KEY, MINIO_SECRET_KEY
                # and DOCLING_API_KEY into /home/site/wwwroot/.env world-readable. Matched at every
                # depth, not just the repo root, and by name rather than extension — ".env" has no
                # extension to filter on. The CI workflows already do this; this is the missing half.
                if file == ".env" or file.startswith(".env."):
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
            for root, _dirs, files in walk(sub_abs):
                for file in files:
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
