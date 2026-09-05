#!/usr/bin/env python3
import os
import sys
import zipfile

def walk(top, blocked=()):
    """
    `os.walk` that follows a symlinked directory, but never a symlink reached THROUGH one.

    One link deep by budget, so the output is the real tree plus one copy of each link target.
    Richer rules were tried and both dropped content or blew the entry count up: wiki CI-Workflows.
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
            # An exclusion is a fact about a DIRECTORY, not about a name at one position — and
            # following symlinks is what makes those two stop agreeing. Compare realpaths.
            real = os.path.realpath(child)
            if any(real == b or real.startswith(b + os.sep) for b in blocked):
                continue
            # Recorded only for directories descended into, so a name the CALLER prunes costs
            # nothing and starves nothing.
            spent[child] = cost
            keep.append(d)
        # Prune in place, which is what os.walk reads to decide where to go next.
        dirs[:] = keep
        yield root, dirs, files


# Operator files that must never reach wwwroot. A packaged `.env` once carried MONGODB_PASSWORD,
# TYPESENSE_API_KEY, MINIO_SECRET_KEY and DOCLING_API_KEY into a world-readable path.
EXCLUDED_NAMES = {"local.settings.json", ".npmrc"}
EXCLUDED_PREFIXES = ("LICENSE", "CHANGELOG")


def excluded_file(file, exclude_extensions):
    """
    Whether a file must never be packaged, wherever it was reached from.

    Shared by both write loops: the re-include loop filtered nothing until a `.env` in a linked
    directory reached the package. Matched by NAME too — ".env" has no extension to filter on.
    """
    if file == ".env" or file.startswith(".env."):
        return True
    if file in EXCLUDED_NAMES or file.startswith(EXCLUDED_PREFIXES):
        return True
    return any(file.endswith(ext) for ext in exclude_extensions)


def package_api(repo_root, zip_path):
    # Pruned at the REPO ROOT ONLY: "dist" at every depth also strips node_modules/**/dist, and
    # `scripts` here is deploy tooling while `src/scripts` IS runtime — the `rel_root` guard below.
    root_exclude_dirs = {".git", ".claude", ".yarn", "frontend", "extraction-host", "extractor",
                         ".angular", "dist", "coverage", ".deploy_archives", "tmp", "__pycache__",
                         "test", "azure", ".github", ".vscode", "scripts", "public"}

    # Root-level files with no runtime role. Root-scoped for the same reason as the dirs: a nested
    # Dockerfile inside node_modules is not our business.
    root_exclude_files = {"Dockerfile", "eslint.config.js", ".gitignore"}

    # `.d.ts` is types for a runtime that never reads them; the credential extensions are the same
    # hazard as `.env` — an operator tree can hold either.
    exclude_extensions = {".zip", ".tar.gz", ".map", ".md", ".d.ts",
                          ".pem", ".key", ".p12", ".pfx"}

    # Runtime data living under excluded directories: the boundary seeder reads the geojson,
    # eagle-query.js the indexes at REQUIRE time, apply-search-definitions.js the indexers.
    include_subpaths = {os.path.join("frontend", "public", "assets", "geojson"),
                        os.path.join("azure", "search", "indexes"),
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
            # Counted PER SUBPATH: a running total only ever guards the first entry, so an empty
            # directory later in sort order would read as "fine" and ENOENT only in Azure.
            found = 0
            # Minus any block that CONTAINS this subpath — `frontend` is excluded wholesale and the
            # geojson lives under it.
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

        # The deploy id goes IN the package: an app setting cannot do this job, because the old
        # worker serves for ~2 minutes and reports the new value. 0644 or the worker cannot read it.
        stamp = zipfile.ZipInfo("build-id.txt")
        stamp.external_attr = 0o100644 << 16  # S_IFREG | 0644
        z.writestr(stamp, os.environ.get("BUILD_ID", "unknown"))

    print(f"Packaged {count} files into {zip_path} ({extra} from re-included data dirs)")

if __name__ == "__main__":
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    out = sys.argv[2] if len(sys.argv) > 2 else "/tmp/api-deploy.zip"
    package_api(os.path.abspath(root), out)
