#!/usr/bin/env python3
import os
import sys
import zipfile

def package_api(repo_root, zip_path):
    root_exclude_dirs = {".git", "frontend", ".angular", "dist", "coverage", ".deploy_archives", "tmp", "__pycache__"}
    exclude_extensions = {".zip", ".tar.gz", ".map", ".md"}

    print(f"Packaging {repo_root} -> {zip_path}...")
    count = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(repo_root):
            rel_root = os.path.relpath(root, repo_root)
            if rel_root == ".":
                dirs[:] = [d for d in dirs if d not in root_exclude_dirs]

            for file in files:
                if any(file.endswith(ext) for ext in exclude_extensions):
                    continue
                full_path = os.path.join(root, file)
                rel_path = os.path.relpath(full_path, repo_root)
                z.write(full_path, rel_path)
                count += 1
    print(f"Packaged {count} files into {zip_path}")

if __name__ == "__main__":
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    out = sys.argv[2] if len(sys.argv) > 2 else "/tmp/api-deploy.zip"
    package_api(os.path.abspath(root), out)
