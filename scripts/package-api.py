#!/usr/bin/env python3
import os
import sys
import zipfile

def package_api(repo_root, zip_path):
    # Pruned at the REPO ROOT ONLY. Excluding "dist" at every depth also strips
    # node_modules/**/dist (e.g. @mongodb-js/saslprep) and ships an app that 500s on every
    # request. Do not reintroduce that.
    # `extraction-host` is vendored SOURCE for a machine outside Azure — Python the Node app never
    # loads. Shipping it would put worker.py and three systemd units at the app root, which is the
    # same class of debris the 2026-08-04 wwwroot sweep had to clean out by hand. Excluded at the
    # root only, like `frontend`.
    root_exclude_dirs = {".git", "frontend", "extraction-host", ".angular", "dist", "coverage",
                         ".deploy_archives", "tmp", "__pycache__"}
    exclude_extensions = {".zip", ".tar.gz", ".map", ".md"}

    # The boundary seeder reads the checked-in GeoJSON exports, which live under frontend/ because
    # the frontend serves them too. `frontend` is otherwise excluded, so without this the seed
    # fails with ENOENT on regional_districts.geojson only when run in Azure — never locally.
    # Kept as one source rather than a second copy under src/data, which would drift.
    include_subpaths = {os.path.join("frontend", "public", "assets", "geojson")}

    print(f"Packaging {repo_root} -> {zip_path}...")
    count = 0
    extra = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(repo_root):
            rel_root = os.path.relpath(root, repo_root)
            if rel_root == ".":
                dirs[:] = [d for d in dirs if d not in root_exclude_dirs]

            for file in files:
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
            for root, _dirs, files in os.walk(sub_abs):
                for file in files:
                    full_path = os.path.join(root, file)
                    rel_path = os.path.relpath(full_path, repo_root)
                    z.write(full_path, rel_path)
                    count += 1
                    extra += 1
            if extra == 0:
                raise SystemExit(f"ERROR: required data directory is empty: {sub}")

    print(f"Packaged {count} files into {zip_path} ({extra} from re-included data dirs)")

if __name__ == "__main__":
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    out = sys.argv[2] if len(sys.argv) > 2 else "/tmp/api-deploy.zip"
    package_api(os.path.abspath(root), out)
